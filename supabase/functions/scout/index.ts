import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Shared-secret authentication: fail closed if ORBOT_API_KEY is unset
  const expectedKey = Deno.env.get("ORBOT_API_KEY");
  const providedKey = req.headers.get("X-Orbot-Key");
  if (!expectedKey || providedKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Receive Webhook
    const { email_body } = await req.json();

    if (!email_body) {
      throw new Error("Missing email_body in request payload.");
    }

    // Initialize Supabase Client (using service_role key to bypass RLS for internal ingestion)
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 2. LLM Parsing (Gemini Flash)
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) throw new Error("GEMINI_API_KEY is not set.");

    const geminiPrompt = `
    You are an AI assistant parsing an e-commerce order confirmation email.
    Extract the following information and output ONLY a valid JSON object. Do NOT wrap in markdown or backticks.
    
    Email Body:
    ${email_body}
    
    JSON Schema Requirements:
    {
      "platform_order_id": "String (the order number, e.g. '2605223GVDY287'. CRITICAL: Strip any leading '#' prefix if present)",
      "order_timestamp": "ISO 8601 string of when the order was placed (guess timezone if not provided, assume UTC+8 for Malaysia)",
      "sales_platform": "Shopee or Lazada",
      "customer_name": "String (the customer/buyer username or name, e.g. 'duoble8402' from 'Kindly ship order to duoble8402.')",
      "order_subtotal": Number (just the numeric value, e.g., 55.50),
      "order_currency": "String (the currency code, e.g., 'MYR', 'SGD'. Guess from the price format, assume MYR for Malaysia)",
      "items": [
        {
          "listing_title": "String (the name of the product listing. CRITICAL: Strip off any leading item indices, numbering, or punctuation like '1. ', '2) ', '• ' so that it is just the text name, e.g. 'Display Stand for Time Machine...')",
          "variation_name": "String (the specific option/color selected. Use null if no variation is mentioned)",
          "purchased_quantity": Number
        }
      ]
    }
    `;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiPrompt }] }],
          generationConfig: { response_mime_type: "application/json" }
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const geminiData = await geminiRes.json();
    if (!geminiData.candidates || geminiData.candidates.length === 0) {
      console.error("Gemini API Error Response:", JSON.stringify(geminiData));
      throw new Error(`Failed to get response from Gemini API. Status: ${geminiRes.status}. Response: ${JSON.stringify(geminiData)}`);
    }

    // Log Gemini usage
    const usage = geminiData.usageMetadata;
    if (usage) {
      const { error: usageLogError } = await supabase.from("gemini_usage_log").insert({
        agent_name: "Scout Agent",
        model_name: "gemini-3.1-flash-lite",
        prompt_tokens: usage.promptTokenCount || 0,
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      });
      if (usageLogError) {
        console.error("Failed to log Gemini usage:", usageLogError);
      } else {
        console.log(`Gemini usage logged: ${usage.totalTokenCount} tokens`);
      }
    }

    const rawJsonText = geminiData.candidates[0]?.content?.parts?.[0]?.text;
    if (!rawJsonText) {
      throw new Error(`Gemini response had no text part (finishReason: ${geminiData.candidates[0]?.finishReason ?? "unknown"})`);
    }
    let cleanedJsonText = rawJsonText.trim();
    if (cleanedJsonText.startsWith("```")) {
      cleanedJsonText = cleanedJsonText.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "");
    }
    const orderData = JSON.parse(cleanedJsonText.trim());

    if (!Array.isArray(orderData.items) || orderData.items.length === 0) {
      throw new Error(`Gemini returned no order items for order ${orderData.platform_order_id ?? "(unknown)"} — refusing to ingest an empty order.`);
    }

    // 3. Database Insertion & Bridging Table Matching
    
    const platformOrderId = String(orderData.platform_order_id).trim();

    // Check for duplicate order ID first
    const { data: existingOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('platform_order_id', platformOrderId)
      .maybeSingle();

    if (existingOrder) {
      console.log(`Order ${platformOrderId} already exists. Skipping ingestion.`);
      return new Response(JSON.stringify({ status: "Order already exists. Skipping ingestion." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // First, insert the master order
    const { data: insertedOrder, error: orderError } = await supabase
      .from('orders')
      .insert({
        platform_order_id: platformOrderId,
        order_timestamp: orderData.order_timestamp,
        sales_platform: orderData.sales_platform,
        customer_name: orderData.customer_name,
        order_subtotal: orderData.order_subtotal,
        order_currency: orderData.order_currency,
        overall_order_status: 'pending'
      })
      .select()
      .single();

    if (orderError) throw new Error(`Failed to insert order: ${orderError.message}`);

    const orderId = insertedOrder.id;

    // Now process items
    const resolvedItemsMap = new Map<string, any>(); // variantId -> { variantSku, variantName, quantity, variationNames: Set, isFake?: boolean }
    let hasMatchingFailure = false;
    let hasFuzzyMatch = false;
    let missingItemDetails = "";
    let fuzzyItemDetails = "";
    let itemIndex = 0;
    
    for (const item of orderData.items) {
      const { variantId, isFuzzy } = await resolveVariantId(supabase, item.listing_title, item.variation_name);

      if (!variantId) {
        hasMatchingFailure = true;
        missingItemDetails += `Listing: "${item.listing_title}" (Variation: "${item.variation_name || 'None'}"); `;
        
        resolvedItemsMap.set(`non_existent_${itemIndex++}`, {
          variantSku: "item does not exist",
          variantName: "item does not exist",
          quantity: Number(item.purchased_quantity),
          variationNames: item.variation_name ? new Set([item.variation_name]) : new Set(),
          isFake: true
        });
        continue;
      }

      if (isFuzzy) {
        hasFuzzyMatch = true;
        fuzzyItemDetails += `Listing: "${item.listing_title}" (Variation: "${item.variation_name || 'None'}"); `;
      }

      const { data: variantInfo } = await supabase
        .from('variants')
        .select('variant_sku, variant_name')
        .eq('id', variantId)
        .single();
      const variantSku = variantInfo?.variant_sku ?? null;
      const variantName = variantInfo?.variant_name ?? null;

      if (!resolvedItemsMap.has(variantId)) {
        resolvedItemsMap.set(variantId, {
          variantSku,
          variantName,
          quantity: Number(item.purchased_quantity),
          variationNames: item.variation_name ? new Set([item.variation_name]) : new Set()
        });
      } else {
        const existing = resolvedItemsMap.get(variantId);
        existing.quantity += Number(item.purchased_quantity);
        if (item.variation_name) {
          existing.variationNames.add(item.variation_name);
        }
      }
    }

    // Insert merged items
    let successfulItems = 0;
    for (const [key, details] of resolvedItemsMap.entries()) {
      const varNamesList = Array.from(details.variationNames).sort() as string[];
      const varNamesStr = varNamesList.length > 0 ? varNamesList.join(", ") : null;
      
      const finalName = details.isFake
        ? "item does not exist"
        : (details.variantName && varNamesStr ? `${details.variantName} (${varNamesStr})` : (details.variantName ?? null));

      const variantIdVal = details.isFake ? null : key;

      const { error: itemInsertError } = await supabase
        .from('order_items')
        .insert({
          order_id: orderId,
          variant_id: variantIdVal,
          variant_sku: details.variantSku,
          variant_name: finalName,
          purchased_quantity: details.quantity,
          item_print_status: details.isFake ? 'not_applicable' : 'pending'
        });

      if (itemInsertError) {
        await logSystemError(supabase, `Failed to insert order item for variant ${details.variantSku} in order ${orderData.platform_order_id}: ${itemInsertError.message}`);
      } else {
        successfulItems++;
      }
    }

    if (hasMatchingFailure) {
      // Update overall status to hold
      const { error: holdUpdateError } = await supabase
        .from('orders')
        .update({ overall_order_status: 'hold' })
        .eq('id', orderId);
      if (holdUpdateError) console.error("Failed to update order status to hold:", holdUpdateError);
    }

    if (hasFuzzyMatch && !hasMatchingFailure) {
      const warningMsg = `Order ${orderData.platform_order_id} ingested with fuzzy/fallback matching: ${fuzzyItemDetails}`;
      const { error: fuzzyLogError } = await supabase.from('system_logs').insert({
        agent_name: 'Scout Edge Function',
        log_level: 'warning',
        log_message: warningMsg,
        additional_details: { fuzzy_match: true, platform_order_id: orderData.platform_order_id }
      });
      if (fuzzyLogError) console.error("Failed to log fuzzy match warning:", fuzzyLogError);
    }

    if (hasMatchingFailure) {
      await logSystemError(supabase, `Order ${orderData.platform_order_id} ingested with missing items: ${missingItemDetails}`);
      throw new Error(`Order ${orderData.platform_order_id} ingested, but some items do not exist: ${missingItemDetails}`);
    }

    // 4. Logging Success
    const { error: successLogError } = await supabase.from('system_logs').insert({
      agent_name: 'Scout Edge Function',
      log_level: 'info',
      log_message: `Successfully ingested order ${orderData.platform_order_id} with ${orderData.items.length} items.`
    });
    if (successLogError) console.error("Failed to log success:", successLogError);

    return new Response(JSON.stringify({
      status: hasFuzzyMatch ? "Order ingested (fuzzy matched — verify SKU)." : "Order ingested, Foreman trigger activated."
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error: any) {
    // Log the full error server-side only — never echo it back to the caller,
    // since error messages can still contain sensitive details (e.g. upstream URLs).
    console.error(error);
    return new Response(JSON.stringify({ error: "Internal error processing request" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

// Helper function to insert error logs
async function logSystemError(supabase: any, message: string) {
  console.error("Scout Error:", message);
  const { error } = await supabase.from('system_logs').insert({
    agent_name: 'Scout Edge Function',
    log_level: 'error',
    log_message: message
  });
  if (error) console.error("Failed to write system_logs entry:", error);
}

// Mirrors normalize_variation() in main.py: lowercase, " - " around hyphens,
// no spaces around commas, collapsed whitespace. Keep the two in sync — the
// Python matcher and its self-healed rows key on this exact form.
function normalizeVariation(raw: string | null): string {
  let s = (raw || "").trim().toLowerCase();
  s = s.replace(/\s*-\s*/g, " - ");
  s = s.replace(/\s*,\s*/g, ",");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function getF1SkuSuffix(variationName: string | null): string {
  if (!variationName) return "";
  const val = variationName.toLowerCase().trim();
  if (val.includes("mclaren")) return "MCLAREN";
  if (val.includes("aston")) return "ASTON";
  if (val.includes("ferrari")) return "FERRARI";
  if (val.includes("haas")) return "HAAS";
  if (val.includes("alpine")) return "ALPINE";
  if (val.includes("apx")) return "APX";
  if (val.includes("kick") || val.includes("sauber")) return "KICK";
  if (val.includes("mercedes") || val.includes("merc")) return "MERC";
  if (val.includes("redbull") || val.includes("red bull")) return "REDBULL";
  if (val.includes("racing bulls") || val.includes("racing buls") || val.includes("racing") || val === "rb") return "RACINGBULLS";
  if (val.includes("williams")) return "WILLIAMS";
  return "";
}

function getF1MultiTierSuffix(variationName: string | null, listingTitle: string): string {
  if (variationName) {
    const val = variationName.toLowerCase().trim();
    const m = val.match(/\b([1-4])\s*tier/);
    if (m) return `T${m[1]}`;
    for (const t of ["t1", "t2", "t3", "t4"]) {
      if (val === t || val.includes(" " + t) || val.includes(t + " ") || val.includes("(" + t + ")")) {
        return t.toUpperCase();
      }
    }
    if (val.includes("1 tier") || val.includes("1-tier")) return "T1";
    if (val.includes("2 tier") || val.includes("2-tier")) return "T2";
    if (val.includes("3 tier") || val.includes("3-tier")) return "T3";
    if (val.includes("4 tier") || val.includes("4-tier")) return "T4";
  }

  const combined = `${listingTitle} ${variationName || ""}`.toLowerCase();
  const m = combined.match(/\b([1-4])\s*tier/);
  if (m) {
    return `T${m[1]}`;
  }
  
  for (const t of ["t4", "t3", "t2", "t1"]) {
    const regex = new RegExp(`\\b${t}\\b`);
    if (regex.test(combined)) return t.toUpperCase();
  }
  
  if (combined.includes("4 tier") || combined.includes("4-tier")) return "T4";
  if (combined.includes("3 tier") || combined.includes("3-tier")) return "T3";
  if (combined.includes("2 tier") || combined.includes("2-tier")) return "T2";
  if (combined.includes("1 tier") || combined.includes("1-tier")) return "T1";
  return "";
}

// Multi-stage robust variant matching
async function resolveVariantId(supabase: any, listingTitle: string, variationName: string | null): Promise<{ variantId: string | null; isFuzzy: boolean }> {
  const normVariation = (variationName || "").trim();
  let exactListingId: string | null = null;

  // STAGE 1: Exact listing and variation match
  console.log(`[Matching] Stage 1: Exact match for listing "${listingTitle}" and variation "${normVariation}"`);
  
  const { data: exactListing } = await supabase
    .from('listings')
    .select('id, product_id')
    .eq('platform_listing_name', listingTitle)
    .single();

  if (exactListing) {
    const listingId = exactListing.id;
    exactListingId = listingId;

    // Special Star Wars rule
    const isStarWars = listingTitle.toLowerCase().includes("star wars") || listingTitle.toLowerCase().includes("starwars");
    if (isStarWars && normVariation.toLowerCase().startsWith("base - blank")) {
      console.log(`[Matching] Star Wars rule: variation starts with 'Base - Blank'.`);
      
      // 1. Check if set number is in variation name
      const setMatchesVar = normVariation.match(/\b\d{4,6}\b/g);
      if (setMatchesVar && setMatchesVar.length > 0) {
        const setNum = setMatchesVar[0];
        const { data: varRes } = await supabase
          .from('variants')
          .select('id')
          .eq('variant_type', 'DS-NP')
          .eq('set_number', setNum)
          .limit(1);
        if (varRes && varRes.length > 0) {
          console.log(`[Matching] Star Wars rule Success: matched set ${setNum} to DS-NP variant = ${varRes[0].id}`);
          return { variantId: varRes[0].id, isFuzzy: false };
        }
      }
      
      // 2. Extract set numbers from listing title
      const setMatchesTitle = listingTitle.match(/\b\d{4,6}\b/g);
      if (setMatchesTitle && setMatchesTitle.length > 0) {
        const nonYears = setMatchesTitle.filter(num => !/^(19\d{2}|20\d{2})$/.test(num));
        if (nonYears.length > 0) {
          const firstSet = nonYears[0];
          const { data: varRes } = await supabase
            .from('variants')
            .select('id')
            .eq('variant_type', 'DS-NP')
            .eq('set_number', firstSet)
            .limit(1);
          if (varRes && varRes.length > 0) {
            console.log(`[Matching] Star Wars rule Success: matched title set ${firstSet} to DS-NP variant = ${varRes[0].id}`);
            return { variantId: varRes[0].id, isFuzzy: false };
          }
        }
      }
    }

    const { data: exactVar } = await supabase
      .from('listing_variations')
      .select('variant_id')
      .eq('listing_id', listingId)
      .eq('platform_variation_name', normVariation)
      .single();

    if (exactVar) {
      console.log(`[Matching] Stage 1 Success: found variant_id = ${exactVar.variant_id}`);
      return { variantId: exactVar.variant_id, isFuzzy: false };
    }

    // Stage 1b: normalized-form match — how the Python matcher and its
    // self-healed rows store variations (case/spacing-insensitive)
    const { data: normVarRows } = await supabase
      .from('listing_variations')
      .select('variant_id')
      .eq('listing_id', listingId)
      .eq('normalized_variation_name', normalizeVariation(variationName))
      .limit(1);
    if (normVarRows && normVarRows.length > 0) {
      console.log(`[Matching] Stage 1b Success (normalized): found variant_id = ${normVarRows[0].variant_id}`);
      return { variantId: normVarRows[0].variant_id, isFuzzy: false };
    }

    // Fallback 1.1: Single variation match for this listing
    const { data: variations } = await supabase
      .from('listing_variations')
      .select('variant_id, platform_variation_name')
      .eq('listing_id', listingId);

    if (variations && variations.length === 1) {
      const dbVarName = variations[0].platform_variation_name.trim();
      if (dbVarName === "" || dbVarName.toLowerCase() === "default" || normVariation === "") {
        console.log(`[Matching] Fallback 1.1: Single variation match - defaulting to "${variations[0].platform_variation_name}"`);
        return { variantId: variations[0].variant_id, isFuzzy: true };
      }
    }

    // Fallback 1.2: Variation keyword match
    if (variations && variations.length > 0) {
      const varLower = normVariation.toLowerCase();
      let matchedVar = null;
      if (varLower.includes("wall") || varLower.includes("mount") || varLower.includes("wm") || varLower.includes("fwm")) {
        matchedVar = variations.find((v: any) => {
          const nameLower = v.platform_variation_name.toLowerCase();
          return nameLower.includes("wall") || nameLower.includes("mount") || nameLower.includes("wm") || nameLower.includes("fwm");
        });
      }
      if (matchedVar) {
        console.log(`[Matching] Fallback 1.2: Mapped variation "${normVariation}" to "${matchedVar.platform_variation_name}"`);
        return { variantId: matchedVar.variant_id, isFuzzy: true };
      }
    }
  }

  // STAGE 2: Set Number fallback matching
  console.log(`[Matching] Stage 2: Set number fallback match for "${listingTitle}"`);
  const matches = listingTitle.match(/\b\d{4,6}\b/g);
  let setNum: string | null = null;
  if (matches) {
    const nonYears = matches.filter(num => !/^(19\d{2}|20\d{2})$/.test(num));
    setNum = nonYears.length > 0 ? nonYears[0] : matches[0];
  }
  if (setNum) {
    // Exact set_number match — a substring SKU LIKE would let 4-digit sets
    // (e.g. 7519) collide with 5-digit ones (75190)
    const { data: matchedVariants } = await supabase
      .from('variants')
      .select('id, variant_sku, variant_name, variant_type')
      .eq('set_number', setNum);

    if (matchedVariants && matchedVariants.length > 0) {
      const isWallMount = listingTitle.toLowerCase().includes("wall") || listingTitle.toLowerCase().includes("mount") || normVariation.toLowerCase().includes("wall") || normVariation.toLowerCase().includes("mount") || normVariation.toLowerCase().includes("wm") || normVariation.toLowerCase().includes("fwm");
      const isNoPlate = listingTitle.toLowerCase().includes("no plate") || normVariation.toLowerCase().includes("no plate") || normVariation.toLowerCase().includes("np") || normVariation.toLowerCase().includes("blank") || normVariation.toLowerCase().includes("without plate");

      let bestVariant = null;
      if (isWallMount) {
        const isFlush = listingTitle.toLowerCase().includes("flush") || normVariation.toLowerCase().includes("flush") || normVariation.toLowerCase().includes("fush") || normVariation.toLowerCase().includes("fwm");
        if (isFlush) {
          bestVariant = matchedVariants.find((v: any) => v.variant_type === 'FWM');
        }
        if (!bestVariant) {
          bestVariant = matchedVariants.find((v: any) => v.variant_type === 'WM' || v.variant_type === 'FWM');
        }
      } else if (isNoPlate) {
        bestVariant = matchedVariants.find((v: any) => v.variant_type === 'DS-NP');
      } else {
        bestVariant = matchedVariants.find((v: any) => v.variant_type === 'DS' || v.variant_type === 'BASE');
      }

      // No blind matchedVariants[0] fallback: if the type heuristics found
      // nothing, fall through to the next stage instead of guessing.
      if (bestVariant) {
        console.log(`[Matching] Stage 2 Success: mapped set ${setNum} to variant "${bestVariant.variant_sku}"`);

        if (exactListing) {
          const { error: selfHealError } = await supabase.from('listing_variations').insert({
            listing_id: exactListing.id,
            variant_id: bestVariant.id,
            platform_variation_name: normVariation,
            normalized_variation_name: normalizeVariation(variationName),
            match_source: 'self_heal',
            reference_name: `${listingTitle} [${normVariation}]`
          });
          if (selfHealError) {
            console.error(`[Matching] Self-heal error for "${listingTitle}":`, selfHealError);
          } else {
            console.log(`[Matching] Self-healed listing variation for "${listingTitle}"`);
          }
        }
        return { variantId: bestVariant.id, isFuzzy: true };
      }
    }
  }

  // STAGE 2.5: F1 Team & Multi-tier matching fallback
  const isF1 = listingTitle.toLowerCase().includes("f1") || listingTitle.toLowerCase().includes("formula 1") || listingTitle.toLowerCase().includes("formula one");
  const isSC = listingTitle.toLowerCase().includes("speed champions") || listingTitle.toLowerCase().includes("sc");
  const isVertical = !listingTitle.toLowerCase().includes("foldable") && !listingTitle.toLowerCase().includes("skadis") && !listingTitle.toLowerCase().includes("wall") && !listingTitle.toLowerCase().includes("flush") && !listingTitle.toLowerCase().includes("lift");

  // F1 Multi-tier stand matching fallback
  if (isF1 && isSC && normVariation) {
    const tierSuffix = getF1MultiTierSuffix(normVariation, listingTitle);
    if (tierSuffix) {
      const targetSku = `BLO-SC-DS-F1-${tierSuffix}`;
      console.log(`[Matching] F1 Multi-tier matching constructed target SKU "${targetSku}"`);
      const { data: matchedVariant } = await supabase
        .from('variants')
        .select('id, variant_sku')
        .eq('variant_sku', targetSku)
        .single();
      
      if (matchedVariant) {
        console.log(`[Matching] F1 Multi-tier Success: found variant_id = ${matchedVariant.id} for SKU "${targetSku}"`);

        // Auto-heal/insert listing variation if listing exists
        if (exactListingId) {
          const { error: selfHealError } = await supabase.from('listing_variations').insert({
            listing_id: exactListingId,
            variant_id: matchedVariant.id,
            platform_variation_name: normVariation,
            normalized_variation_name: normalizeVariation(variationName),
            match_source: 'self_heal',
            reference_name: `${listingTitle} [${normVariation}]`
          });
          if (selfHealError) {
            console.error(`[Matching] Self-heal error for "${listingTitle}":`, selfHealError);
          } else {
            console.log(`[Matching] Self-healed listing variation for "${listingTitle}"`);
          }
        }
        return { variantId: matchedVariant.id, isFuzzy: true };
      }
    }
  }

  // F1 Team Stand matching
  if (isF1 && isSC && isVertical && normVariation) {
    const suffix = getF1SkuSuffix(normVariation);
    if (suffix) {
      const targetSku = `BLO-SC-VDS-F1-${suffix}`;
      console.log(`[Matching] Stage 2.5: F1 Team matching constructed target SKU "${targetSku}"`);
      const { data: matchedVariant } = await supabase
        .from('variants')
        .select('id, variant_sku')
        .eq('variant_sku', targetSku)
        .single();
      
      if (matchedVariant) {
        console.log(`[Matching] Stage 2.5 Success: found variant_id = ${matchedVariant.id} for SKU "${targetSku}"`);

        // Auto-heal/insert listing variation if listing exists
        if (exactListingId) {
          const { error: selfHealError } = await supabase.from('listing_variations').insert({
            listing_id: exactListingId,
            variant_id: matchedVariant.id,
            platform_variation_name: normVariation,
            normalized_variation_name: normalizeVariation(variationName),
            match_source: 'self_heal',
            reference_name: `${listingTitle} [${normVariation}]`
          });
          if (selfHealError) {
            console.error(`[Matching] Self-heal error for "${listingTitle}":`, selfHealError);
          } else {
            console.log(`[Matching] Self-healed listing variation for "${listingTitle}"`);
          }
        }
        return { variantId: matchedVariant.id, isFuzzy: true };
      }
    }
  }

  // STAGE 3: Fuzzy / Similar listing matching
  console.log(`[Matching] Stage 3: Fuzzy similarity matching for "${listingTitle}"`);
  let cleanTitle = listingTitle.replace(/Display Stand for Lego/gi, "")
                               .replace(/Display Stand for/gi, "")
                               .replace(/Wall Mount for Lego/gi, "")
                               .replace(/Wall Mount for/gi, "")
                               .replace(/Lego/gi, "")
                               .trim();
  const words = cleanTitle.split(/\s+/).filter(w => w.length > 2);
  if (words.length >= 2) {
    const searchPattern = `%${words[0]}%${words[1]}%`;
    const { data: fuzzyListings } = await supabase
      .from('listings')
      .select('id, platform_listing_name')
      .ilike('platform_listing_name', searchPattern)
      .limit(5);

    if (fuzzyListings && fuzzyListings.length > 0) {
      const bestFuzzy = fuzzyListings[0];
      const { data: variations } = await supabase
        .from('listing_variations')
        .select('variant_id, platform_variation_name')
        .eq('listing_id', bestFuzzy.id);

      if (variations && variations.length > 0) {
        // Try to find a variation with matching name first
        let bestVar = variations.find((v: any) => v.platform_variation_name.toLowerCase() === normVariation.toLowerCase());
        if (!bestVar) {
          // Fallback keyword match
          bestVar = variations.find((v: any) => normVariation.toLowerCase().includes(v.platform_variation_name.toLowerCase()) || v.platform_variation_name.toLowerCase().includes(normVariation.toLowerCase()));
        }
        if (!bestVar) {
          const isWallMount = listingTitle.toLowerCase().includes("wall") || listingTitle.toLowerCase().includes("mount") || normVariation.toLowerCase().includes("wall") || normVariation.toLowerCase().includes("mount");
          if (isWallMount) {
            const wmVar = variations.find((v: any) => v.platform_variation_name.toLowerCase().includes("wall") || v.platform_variation_name.toLowerCase().includes("mount") || v.platform_variation_name.toLowerCase().includes("wm"));
            if (wmVar) bestVar = wmVar;
          }
        }
        // Never guess: if no variation matched, fail the match rather than
        // shipping the wrong item (contract: Stage 3 must not pick variations[0]).
        if (bestVar) {
          console.log(`[Matching] Stage 3 Success: mapped fuzzy listing to variant_id = ${bestVar.variant_id}`);
          return { variantId: bestVar.variant_id, isFuzzy: true };
        }
        console.log(`[Matching] Stage 3: fuzzy listing found but no variation matched — not guessing.`);
      }
    }
  }

  return { variantId: null, isFuzzy: false };
}
