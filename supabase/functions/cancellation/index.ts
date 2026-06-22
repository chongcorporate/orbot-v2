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

      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload)
      });

      if (!geminiRes.ok) throw new Error("Gemini API failed to parse cancellation email.");
      
      const geminiData = await geminiRes.json();

      // Log Gemini usage
      try {
        const usage = geminiData.usageMetadata;
        if (usage) {
          await supabase.from("gemini_usage_log").insert({
            agent_name: "Cancellation Agent",
            model_name: "gemini-2.5-flash",
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
          });
          console.log(`Gemini usage logged: ${usage.totalTokenCount} tokens`);
        }
      } catch (e) {
        console.error("Failed to log Gemini usage:", e);
      }

      const extractedText = geminiData.candidates[0].content.parts[0].text;
      
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
        await supabase.from('system_logs').insert({
          agent_name: 'Cancellation Agent', log_level: 'warning', 
          log_message: `Received cancellation for Order ${extractedPlatformOrderId}, but it does not exist in the database.`
        });
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
          body: JSON.stringify({})
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
    
    // 3. For each order item, find print jobs and delete/cancel them
    for (const item of orderItems) {
      const { data: printJobs, error: jobsError } = await supabase
        .from('print_jobs')
        .select('id, simplyprint_job_id')
        .eq('order_item_id', item.id);
        
      if (jobsError) {
        await supabase.from('system_logs').insert({
          agent_name: 'Cancellation Agent', log_level: 'error',
          log_message: `Failed to fetch print jobs for item ${item.id}: ${jobsError.message}`
        });
        continue;
      }

      if (printJobs) {
        for (const job of printJobs) {
          if (job.simplyprint_job_id && job.simplyprint_job_id !== "UNKNOWN_JOB_ID" && !job.simplyprint_job_id.startsWith("MOCK_")) {
            try {
              console.log(`Attempting to delete SimplyPrint queue item ${job.simplyprint_job_id}...`);
              // Delete queue item via POST /queue/DeleteItem
              const spResponse = await fetch(`https://api.simplyprint.io/${companyId}/queue/DeleteItem?job=${job.simplyprint_job_id}`, {
                method: "POST",
                headers: { "X-API-KEY": simplyprintApiKey }
              });

              if (spResponse.ok) {
                console.log(`Queue item ${job.simplyprint_job_id} deleted successfully.`);
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
                    headers: { "X-API-KEY": simplyprintApiKey }
                  });
                  if (cancelRes.ok) {
                    console.log(`Successfully cancelled active job on printer ${printerIdToCancel}`);
                  } else {
                    const cancelErr = await cancelRes.text();
                    console.error(`Failed to cancel active job on printer ${printerIdToCancel}. Status ${cancelRes.status}: ${cancelErr}`);
                  }
                } else {
                  console.log(`Job ${job.simplyprint_job_id} not found in active printers.`);
                }
              }
            } catch (e: any) {
               await supabase.from('system_logs').insert({
                 agent_name: 'Cancellation Agent',
                 log_level: 'warning',
                 log_message: `Network failure when deleting SimplyPrint job ${job.simplyprint_job_id}: ${e.message}`
               });
            }
          }
        }
      }
    }

    // 4. Delete print jobs associated with this order's items so they are removed from the queue in the UI
    const itemIds = orderItems.map(item => item.id);
    if (itemIds.length > 0) {
      const { error: deleteJobsError } = await supabase
        .from('print_jobs')
        .delete()
        .in('order_item_id', itemIds);

      if (deleteJobsError) {
        console.error(`Failed to delete print jobs from database: ${deleteJobsError.message}`);
      }
    }

    // 5. Update the order status to 'cancelled' in the database
    const { error: updateOrderError } = await supabase
      .from('orders')
      .update({ overall_order_status: 'cancelled' })
      .eq('id', orderId);

    if (updateOrderError) {
      throw new Error(`Failed to update order status in database: ${updateOrderError.message}`);
    }

    await supabase.from('system_logs').insert({
      agent_name: 'Cancellation Agent', log_level: 'info', 
      log_message: `Successfully cancelled Order ${extractedPlatformOrderId || orderId} and aborted associated print jobs.`
    });

    return new Response(JSON.stringify({ status: "success", platform_order_id: extractedPlatformOrderId || orderId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error: any) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
