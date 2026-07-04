import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
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
    const bodyJson = await req.json();
    const { email_body, email_subject, order_id, platform_order_id } = bodyJson;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    const simplyprintApiKey = Deno.env.get("SIMPLYPRINT_API_KEY") ?? "";
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    if (!simplyprintApiKey) {
      throw new Error("Missing SIMPLYPRINT_API_KEY key.");
    }

    let orderId: string | null = null;
    let extractedPlatformOrderId: string | null = null;

    if (order_id) {
      orderId = order_id;
      const { data: ord } = await supabase
        .from('orders')
        .select('platform_order_id')
        .eq('id', orderId)
        .maybeSingle();
      extractedPlatformOrderId = ord?.platform_order_id ?? null;
    } else if (platform_order_id) {
      extractedPlatformOrderId = platform_order_id;
      const { data: ord } = await supabase
        .from('orders')
        .select('id')
        .eq('platform_order_id', extractedPlatformOrderId)
        .maybeSingle();
      orderId = ord?.id ?? null;
    } else if (email_body) {
      if (!geminiApiKey) {
        throw new Error("Missing GEMINI_API_KEY key.");
      }
      // 1. Use Gemini to extract the Order ID from the cancellation email
      const geminiPayload = {
        contents: [{
          parts: [{
            text: `You are extracting data from a Shopee or Lazada order cancellation email. Extract the Order ID exactly as it appears. 
            Return ONLY a JSON object: {"platform_order_id": "string"}. Email body: ${email_body}`
          }]
        }],
        generationConfig: { response_mime_type: "application/json" }
      };

      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
        body: JSON.stringify(geminiPayload),
        signal: AbortSignal.timeout(30000),
      });

      if (!geminiRes.ok) throw new Error("Gemini API failed to parse cancellation email.");
      
      const geminiData = await geminiRes.json();

      // Log Gemini usage
      const usage = geminiData.usageMetadata;
      if (usage) {
        const { error: usageLogError } = await supabase.from("gemini_usage_log").insert({
          agent_name: "Cancellation Agent",
          model_name: "gemini-2.5-flash",
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

      const extractedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!extractedText) {
        throw new Error(`Gemini response had no text part (finishReason: ${geminiData.candidates?.[0]?.finishReason ?? "unknown"})`);
      }

      // Clean markdown code blocks from response text
      const cleanJsonText = extractedText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const parsedData = JSON.parse(cleanJsonText);
      extractedPlatformOrderId = parsedData.platform_order_id;

      if (!extractedPlatformOrderId) throw new Error("Could not find an Order ID in the cancellation email.");

      // Find the order in the database
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .select('id')
        .eq('platform_order_id', extractedPlatformOrderId)
        .maybeSingle();

      if (orderError || !order) {
        const { error: notFoundLogError } = await supabase.from('system_logs').insert({
          agent_name: 'Cancellation Agent', log_level: 'warning',
          log_message: `Received cancellation for Order ${extractedPlatformOrderId}, but it does not exist in the database.`
        });
        if (notFoundLogError) console.error("Failed to log order-not-found warning:", notFoundLogError);
        return new Response(JSON.stringify({ status: "ignored", reason: "Order not found" }), { headers: corsHeaders, status: 200 });
      }

      orderId = order.id;
    } else {
      throw new Error("Missing cancellation target parameters.");
    }

    if (!orderId) {
      throw new Error("Order ID could not be resolved.");
    }

    // 2. Find all order items for this order
    const { data: orderItems, error: itemsError } = await supabase
      .from('order_items')
      .select('id')
      .eq('order_id', orderId);

    if (itemsError) {
      throw new Error(`Failed to fetch order items: ${itemsError.message}`);
    }

    const companyId = Deno.env.get("SIMPLYPRINT_COMPANY_ID") ?? "13502";

    // Lazy active printers loader
    let activePrintersData: any[] | null = null;
    const getActivePrinters = async () => {
      if (activePrintersData !== null) return activePrintersData;
      try {
        const prRes = await fetch(`https://api.simplyprint.io/${companyId}/printers/Get`, {
          method: "POST",
          headers: {
            "X-API-KEY": simplyprintApiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(15000),
        });
        if (prRes.ok) {
          const res = await prRes.json();
          activePrintersData = res.data || [];
        } else {
          console.error(`SimplyPrint printers/Get failed. Status ${prRes.status}`);
          activePrintersData = [];
        }
      } catch (e) {
        console.error("Failed to fetch active printers from SimplyPrint", e);
        activePrintersData = [];
      }
      return activePrintersData;
    };

    // 3. For each order item, find print jobs and delete/cancel them.
    // Track per-job success so we only clear a print_jobs row from our DB
    // when the corresponding SimplyPrint call actually succeeded — otherwise
    // we'd desync our queue view from what's still active/queued upstream.
    const jobIdsToDelete: string[] = [];
    let anyCancelFailed = false;

    for (const item of orderItems) {
      const { data: printJobs, error: jobsError } = await supabase
        .from('print_jobs')
        .select('id, simplyprint_job_id')
        .eq('order_item_id', item.id);

      if (jobsError) {
        const { error: fetchLogError } = await supabase.from('system_logs').insert({
          agent_name: 'Cancellation Agent', log_level: 'error',
          log_message: `Failed to fetch print jobs for item ${item.id}: ${jobsError.message}`
        });
        if (fetchLogError) console.error("Failed to log print-jobs fetch error:", fetchLogError);
        continue;
      }

      if (printJobs) {
        for (const job of printJobs) {
          if (job.simplyprint_job_id && job.simplyprint_job_id !== "UNKNOWN_JOB_ID" && !job.simplyprint_job_id.startsWith("MOCK_")) {
            let cancelSucceeded = false;
            try {
              console.log(`Attempting to delete SimplyPrint queue item ${job.simplyprint_job_id}...`);
              // Delete queue item via POST /queue/DeleteItem
              const spResponse = await fetch(`https://api.simplyprint.io/${companyId}/queue/DeleteItem?job=${job.simplyprint_job_id}`, {
                method: "POST",
                headers: { "X-API-KEY": simplyprintApiKey },
                signal: AbortSignal.timeout(15000),
              });

              if (spResponse.ok) {
                console.log(`Queue item ${job.simplyprint_job_id} deleted successfully.`);
                cancelSucceeded = true;
              } else {
                const spErrorText = await spResponse.text();
                console.log(`SimplyPrint DeleteItem failed for job ${job.simplyprint_job_id} (could be printing). Status ${spResponse.status}: ${spErrorText}`);

                // If deletion from queue failed, it might be printing on a physical printer. Scan active printers to cancel.
                const printers = await getActivePrinters();
                let printerIdToCancel: number | null = null;
                for (const p of printers) {
                  const pJob = p.job;
                  if (pJob && String(pJob.id) === String(job.simplyprint_job_id)) {
                    printerIdToCancel = p.printer?.id;
                    break;
                  }
                }

                if (printerIdToCancel) {
                  console.log(`Job ${job.simplyprint_job_id} is running on printer ${printerIdToCancel}. Sending cancel...`);
                  const cancelRes = await fetch(`https://api.simplyprint.io/${companyId}/printers/actions/Cancel?pid=${printerIdToCancel}`, {
                    method: "POST",
                    headers: { "X-API-KEY": simplyprintApiKey },
                    signal: AbortSignal.timeout(15000),
                  });
                  if (cancelRes.ok) {
                    console.log(`Successfully cancelled active job on printer ${printerIdToCancel}`);
                    cancelSucceeded = true;
                  } else {
                    const cancelErr = await cancelRes.text();
                    console.error(`Failed to cancel active job on printer ${printerIdToCancel}. Status ${cancelRes.status}: ${cancelErr}`);
                  }
                } else {
                  console.log(`Job ${job.simplyprint_job_id} not found in active printers.`);
                }
              }
            } catch (e: any) {
              const { error: netLogError } = await supabase.from('system_logs').insert({
                agent_name: 'Cancellation Agent',
                log_level: 'warning',
                log_message: `Network failure when deleting SimplyPrint job ${job.simplyprint_job_id}: ${e.message}`
              });
              if (netLogError) console.error("Failed to log network failure:", netLogError);
            }

            if (cancelSucceeded) {
              jobIdsToDelete.push(job.id);
            } else {
              anyCancelFailed = true;
              const { error: unresolvedLogError } = await supabase.from('system_logs').insert({
                agent_name: 'Cancellation Agent',
                log_level: 'error',
                log_message: `Could not confirm cancellation of SimplyPrint job ${job.simplyprint_job_id} (print_jobs row ${job.id}). Leaving row intact for manual review.`
              });
              if (unresolvedLogError) console.error("Failed to log unresolved cancellation:", unresolvedLogError);
            }
          } else {
            // No real SimplyPrint job to cancel (unknown/mock) — safe to clear locally.
            jobIdsToDelete.push(job.id);
          }
        }
      }
    }

    // 4. Delete only the print_jobs rows whose SimplyPrint cancellation actually succeeded
    // (or that never had a real SimplyPrint job to begin with).
    if (jobIdsToDelete.length > 0) {
      const { error: deleteJobsError } = await supabase
        .from('print_jobs')
        .delete()
        .in('id', jobIdsToDelete);

      if (deleteJobsError) {
        console.error(`Failed to delete print jobs from database: ${deleteJobsError.message}`);
      }
    }

    // 5. Update the order status. If any SimplyPrint cancellation could not be
    // confirmed, a printer may still be running the job — put the order on
    // 'hold' for manual review instead of falsely reporting it cancelled
    // (mirrors _do_cancel_order in main.py).
    const finalStatus = anyCancelFailed ? 'hold' : 'cancelled';
    const { error: updateOrderError } = await supabase
      .from('orders')
      .update({ overall_order_status: finalStatus })
      .eq('id', orderId);

    if (updateOrderError) {
      throw new Error(`Failed to update order status in database: ${updateOrderError.message}`);
    }

    const resultMsg = anyCancelFailed
      ? `Cancellation of Order ${extractedPlatformOrderId || orderId} INCOMPLETE — some SimplyPrint jobs could not be confirmed cancelled. Order set to 'hold' for manual review.`
      : `Successfully cancelled Order ${extractedPlatformOrderId || orderId} and aborted associated print jobs.`;
    const { error: successLogError } = await supabase.from('system_logs').insert({
      agent_name: 'Cancellation Agent',
      log_level: anyCancelFailed ? 'warning' : 'info',
      log_message: resultMsg
    });
    if (successLogError) console.error("Failed to log cancellation result:", successLogError);

    return new Response(JSON.stringify({
      status: anyCancelFailed ? "incomplete" : "success",
      cancelled: !anyCancelFailed,
      platform_order_id: extractedPlatformOrderId || orderId
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
