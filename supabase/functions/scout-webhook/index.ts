import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY') ?? '';

    if (!supabaseUrl || !supabaseServiceKey || !geminiApiKey) {
      throw new Error("Missing required environment variables.");
    }

    // Initialize Supabase client with the Service Role key to bypass RLS for system operations
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Receive Webhook
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { email_body } = body;

    if (!email_body) {
      return new Response(JSON.stringify({ error: "Missing email_body in payload" }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. LLM Parsing (Gemini Flash)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent`;

    const prompt = `
      You are a data extraction assistant for an order ingestion system.
      Parse the following order confirmation email and extract the details into a strict JSON format.
      Do not include markdown blocks or any other text, just the JSON.
      JSON structure:
      {
        "platform_order_id": "string (the order number, e.g. '2605223GVDY287'. CRITICAL: Strip any leading '#' prefix if present)",
        "order_timestamp": "ISO 8601 string (assume UTC+8 timezone for Malaysia if not specified)",
        "sales_platform": "string",
        "customer_name": "string (the customer/buyer username or name, e.g. 'duoble8402' from 'Kindly ship order to duoble8402.')",
        "order_subtotal": number,
        "order_currency": "string (the currency code, e.g., 'MYR', 'SGD'. Guess from the price format, assume MYR for Malaysia)",
        "items": [
          {
            "listing_title": "string (the product listing name. CRITICAL: Strip off any leading item numbering, indices, or list prefixes like '1. ', '2) ', '• ' so that it is just the text name, e.g. 'Display Stand for Time Machine...')",
            "variation_name": "string or null if no variation",
            "purchased_quantity": number
          }
        ]
      }
      
      Email Body:
      ${email_body}
    `;

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          response_mime_type: "application/json",
        }
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      throw new Error(`Gemini API error: ${errorText}`);
    }

    const geminiData = await geminiResponse.json();

    // Log Gemini usage
    const usage = geminiData.usageMetadata;
    if (usage) {
      const { error: usageLogError } = await supabase.from("gemini_usage_log").insert({
        agent_name: "Scout Webhook",
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

    const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!responseText) {
      throw new Error("Failed to extract content from Gemini response.");
    }

    let parsedData;
    try {
      let cleanedResponseText = responseText.trim();
      if (cleanedResponseText.startsWith("```")) {
        cleanedResponseText = cleanedResponseText.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "");
      }
      parsedData = JSON.parse(cleanedResponseText.trim());
    } catch (e) {
      throw new Error(`Gemini returned invalid JSON: ${e.message}`);
    }

    const {
      platform_order_id,
      order_timestamp,
      sales_platform,
      customer_name,
      order_subtotal,
      order_currency,
      items
    } = parsedData;

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error(`Gemini returned no order items for order ${platform_order_id ?? "(unknown)"} — refusing to ingest an empty order.`);
    }

    const platformOrderId = String(platform_order_id).trim();

    // Check for duplicate order ID first, before running the expensive matching
    // pipeline (which includes self-heal inserts) — mirrors scout/index.ts.
    const { data: existingOrder, error: existingOrderError } = await supabase
      .from('orders')
      .select('id')
      .eq('platform_order_id', platformOrderId)
      .maybeSingle();

    if (existingOrderError) {
      console.error("Failed to check for existing order:", existingOrderError);
    }

    if (existingOrder) {
      console.log(`Order ${platformOrderId} already exists. Skipping ingestion.`);
      return new Response(JSON.stringify({ status: "Order already exists. Skipping ingestion." }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Translation Dictionary Matching
    const validOrderItems = [];
    let hasMatchingFailure = false;
    let hasFuzzyMatch = false;
    let missingItemDetails = "";
    let fuzzyItemDetails = "";
    let itemIndex = 0;

    for (const item of items) {
      const { listing_title, variation_name, purchased_quantity } = item;

      const { variantId, isFuzzy } = await resolveVariantId(supabase, listing_title, variation_name);

      if (!variantId) {
        hasMatchingFailure = true;
        missingItemDetails += `Listing: "${listing_title}" (Variation: "${variation_name || 'None'}"); `;

        const { error: missingLogError } = await supabase.from('system_logs').insert({
          agent_name: 'scout',
          log_level: 'error',
          log_message: `Listing or variation not found: ${listing_title} (Variation: ${variation_name || 'None'}) for order ${platform_order_id}`,
          additional_details: item
        });
        if (missingLogError) console.error("Failed to log missing item warning:", missingLogError);

        validOrderItems.push({
          variant_id: `non_existent_${itemIndex++}`,
          purchased_quantity,
          variation_name,
          isFake: true
        });
        continue;
      }

      if (isFuzzy) {
        hasFuzzyMatch = true;
        fuzzyItemDetails += `Listing: "${listing_title}" (Variation: "${variation_name || 'None'}"); `;
      }

      validOrderItems.push({
        variant_id: variantId,
        purchased_quantity,
        variation_name,
        isFake: false
      });
    }

    // 4. Database Insertion
    // Insert the master receipt into `orders`
    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .insert({
        platform_order_id: platformOrderId,
        order_timestamp,
        sales_platform,
        customer_name,
        order_subtotal,
        order_currency: order_currency || 'MYR',
        overall_order_status: 'pending'
      })
      .select('id')
      .single();

    if (orderError) {
      throw new Error(`Order insertion error: ${orderError.message}`);
    }

    const orderId = orderData.id;

    if (validOrderItems.length > 0) {
      // Merge items by variant_id
      const mergedItemsMap = new Map<string, any>(); // variant_id -> { quantity, variationNames: Set, isFake: boolean }
      for (const item of validOrderItems) {
        if (!mergedItemsMap.has(item.variant_id)) {
          mergedItemsMap.set(item.variant_id, {
            quantity: Number(item.purchased_quantity),
            variationNames: item.variation_name ? new Set([item.variation_name]) : new Set(),
            isFake: item.isFake
          });
        } else {
          const existing = mergedItemsMap.get(item.variant_id);
          existing.quantity += Number(item.purchased_quantity);
          if (item.variation_name) {
            existing.variationNames.add(item.variation_name);
          }
        }
      }

      // Insert each matched item into `order_items`
      const orderItemsToInsert = [];
      for (const [variantId, details] of mergedItemsMap.entries()) {
        let vSku = "item does not exist";
        let vName = "item does not exist";
        
        if (!details.isFake) {
          const { data: variantInfo, error: variantInfoError } = await supabase
            .from('variants')
            .select('variant_sku, variant_name')
            .eq('id', variantId)
            .single();
          if (variantInfoError) console.error(`Failed to look up variant ${variantId}:`, variantInfoError);
          vSku = variantInfo?.variant_sku ?? null;
          vName = variantInfo?.variant_name ?? null;
        }

        const varNamesList = Array.from(details.variationNames).sort() as string[];
        const varNamesStr = varNamesList.length > 0 ? varNamesList.join(", ") : null;
        const finalName = details.isFake
          ? "item does not exist"
          : (vName && varNamesStr ? `${vName} (${varNamesStr})` : (vName ?? null));

        orderItemsToInsert.push({
          order_id: orderId,
          variant_id: details.isFake ? null : variantId,
          variant_sku: vSku,
          variant_name: finalName,
          purchased_quantity: details.quantity,
          // Fake placeholder rows must be not_applicable, or the order-status
          // roll-up waits forever on an item that can never print
          item_print_status: details.isFake ? 'not_applicable' : 'pending'
        });
      }

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(orderItemsToInsert);

      if (itemsError) {
        throw new Error(`Order items insertion error: ${itemsError.message}`);
      }
    }

    if (hasMatchingFailure) {
      const { error: holdUpdateError } = await supabase
        .from('orders')
        .update({ overall_order_status: 'hold' })
        .eq('id', orderId);
      if (holdUpdateError) console.error("Failed to update order status to hold:", holdUpdateError);

      throw new Error(`Order ${platformOrderId} ingested, but some items do not exist: ${missingItemDetails}`);
    }

    if (hasFuzzyMatch) {
      const { error: fuzzyLogError } = await supabase.from('system_logs').insert({
        agent_name: 'scout',
        log_level: 'warning',
        log_message: `Order ${platformOrderId} ingested with fuzzy/fallback matching: ${fuzzyItemDetails}`,
        additional_details: { fuzzy_match: true, platform_order_id: platformOrderId }
      });
      if (fuzzyLogError) console.error("Failed to log fuzzy match warning:", fuzzyLogError);
    }

    // 6. Logging
    const { error: successLogError } = await supabase.from('system_logs').insert({
      agent_name: 'scout',
      log_level: 'info',
      log_message: `Successfully ingested order ${platform_order_id} from ${sales_platform}`,
      additional_details: { orderId, matchedItemCount: validOrderItems.length }
    });
    if (successLogError) console.error("Failed to log success:", successLogError);

    // 5. The Handoff
    return new Response(JSON.stringify({ status: "Order ingested, Foreman trigger activated." }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    // Log the full error server-side only — never echo it back to the caller,
    // since error messages can still contain sensitive details (e.g. upstream URLs).
    console.error("Error processing request:", error);

    return new Response(JSON.stringify({ error: "Internal error processing request" }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

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

// Multi-stage robust variant matching. isFuzzy=true means a fallback rule
// guessed the SKU — callers must surface a "verify SKU" warning.
async function resolveVariantId(supabase: any, listingTitle: string, variationName: string | null): Promise<{ variantId: string | null; isFuzzy: boolean }> {
  const normVariation = (variationName || "").trim();
  let exactListingId: string | null = null;

  // STAGE 1: Exact listing and variation match
  console.log(`[Matching] Stage 1: Exact match for listing "${listingTitle}" and variation "${normVariation}"`);
  
  const { data: exactListing } = await supabase
    .from('listings')
    .select('id')
    .eq('platform_listing_name', listingTitle)
    .single();

  if (exactListing) {
    const listingId = exactListing.id;
    exactListingId = listingId;
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
