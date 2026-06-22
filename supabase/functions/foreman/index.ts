import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper function for the 1-second delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const simplyprintApiKey = Deno.env.get("SIMPLYPRINT_API_KEY") ?? "";
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (!simplyprintApiKey) {
    throw new Error("SIMPLYPRINT_API_KEY is not set.");
  }

  try {
    // 1. Fetch all pending order items that have a variant mapped
    // Join orders table to check status and sort chronologically
    const { data: pendingItems, error: itemsError } = await supabase
      .from('order_items')
      .select('*, orders!inner(platform_order_id, order_timestamp, created_at, overall_order_status)')
      .eq('item_print_status', 'pending')
      .not('variant_id', 'is', null)
      .in('orders.overall_order_status', ['pending', 'printing']);

    if (itemsError) {
      throw new Error(`Failed to fetch pending order items: ${itemsError.message}`);
    }

    if (!pendingItems || pendingItems.length === 0) {
      return new Response(JSON.stringify({ status: "success", message: "No pending order items to dispatch." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // 2. Sort chronologically by order timestamp / creation time (oldest first)
    const sortedItems = pendingItems.sort((a: any, b: any) => {
      const orderA = a.orders;
      const orderB = b.orders;
      const timeA = new Date(orderA.order_timestamp || orderA.created_at).getTime();
      const timeB = new Date(orderB.order_timestamp || orderB.created_at).getTime();
      if (timeA !== timeB) return timeA - timeB;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    let totalFilesDispatched = 0;
    let totalFulfilledFromStock = 0;
    const processedItemIds: string[] = [];

    const companyId = Deno.env.get("SIMPLYPRINT_COMPANY_ID") ?? "13502";

    // 3. Process each pending item in FIFO order
    for (const item of sortedItems) {
      // Optimistic Locking: Attempt to update item status from 'pending' to 'printing'
      const { data: lockRows, error: lockError } = await supabase
        .from('order_items')
        .update({ item_print_status: 'printing' })
        .eq('id', item.id)
        .eq('item_print_status', 'pending')
        .select();

      if (lockError || !lockRows || lockRows.length === 0) {
        // Skip: another worker has locked/processed this item
        console.log(`Item ${item.id} already locked or processed by another run. Skipping.`);
        continue;
      }

      // We successfully locked this item! Let's process it.
      let itemFilesDispatched = 0;
      let fulfilledFromStock = 0;
      let remainingToPrint = item.purchased_quantity;

      try {
        // Fetch variant info (stock_quantity and variant_sku)
        const { data: variant, error: varError } = await supabase
          .from('variants')
          .select('variant_sku, stock_quantity')
          .eq('id', item.variant_id)
          .single();

        if (varError || !variant) {
          throw new Error(`Failed to fetch variant ID ${item.variant_id}: ${varError?.message || 'No variant found'}`);
        }

        const stockQuantity = variant.stock_quantity ?? 0;

        if (stockQuantity > 0) {
          fulfilledFromStock = Math.min(item.purchased_quantity, stockQuantity);
          remainingToPrint = item.purchased_quantity - fulfilledFromStock;
          const newStock = stockQuantity - fulfilledFromStock;

          // Update variant's stock level in the database
          const { error: stockUpdateError } = await supabase
            .from('variants')
            .update({ stock_quantity: newStock })
            .eq('id', item.variant_id);

          if (stockUpdateError) {
            console.error(`Failed to update stock for variant ID ${item.variant_id}: ${stockUpdateError.message}`);
          } else {
            await supabase.from('system_logs').insert({
              agent_name: 'Foreman Edge Function',
              log_level: 'info',
              log_message: `Stock Keeping: Fulfilled ${fulfilledFromStock} unit(s) of SKU ${variant.variant_sku} from stock. Remaining to print: ${remainingToPrint}. New stock: ${newStock}`
            });
          }
        }

        if (remainingToPrint === 0) {
          // Fully satisfied from stock
          await supabase
            .from('order_items')
            .update({ 
              item_print_status: 'completed',
              sent_to_print_timestamp: new Date().toISOString()
            })
            .eq('id', item.id);

          await supabase.from('system_logs').insert({
            agent_name: 'Foreman Edge Function',
            log_level: 'info',
            log_message: `Order item ${item.id} fully satisfied from stock. No prints dispatched.`
          });

          // Check overall order status
          await checkOverallOrderStatus(supabase, item.order_id);
          totalFulfilledFromStock += fulfilledFromStock;
          processedItemIds.push(item.id);
          continue;
        }

        // Fetch all print files for this variant
        const { data: printFiles, error: filesError } = await supabase
          .from('print_files')
          .select('id, simplyprint_file_id, print_file_name')
          .eq('variant_id', item.variant_id);

        if (filesError || !printFiles || printFiles.length === 0) {
          throw new Error(`Failed to fetch print files for variant ${item.variant_id}: ${filesError?.message || 'No print files found'}`);
        }

        // Dispatch each file multiplied by the remaining quantity to print
        for (let q = 0; q < remainingToPrint; q++) {
          for (const file of printFiles) {
            if (!file.simplyprint_file_id) {
               await supabase.from('system_logs').insert({
                 agent_name: 'Foreman Edge Function', log_level: 'warning', 
                 log_message: `Missing SimplyPrint File ID for Print File ID: ${file.id}`
               });
               continue;
            }

            // Check if print job already exists to enforce idempotency (prevent double print)
            const { data: existingJobs, error: checkError } = await supabase
              .from('print_jobs')
              .select('id')
              .eq('order_item_id', item.id)
              .eq('print_file_id', file.id);

            if (existingJobs && existingJobs.length > q) {
              console.log(`Skipping duplicate dispatch: print file ${file.print_file_name} copy ${q + 1} already dispatched for order item ${item.id}`);
              continue;
            }

            // 1-second delay between dispatches to prevent rate limit
            if (totalFilesDispatched > 0) {
              await delay(1000);
            }

            // Determine printer model requirements.
            // A1 Mini files explicitly end in "a1m" or "mini" (excluding file extensions).
            // A1 files explicitly end in "a1" (excluding file extensions).
            // Otherwise, fallback to name-based classification.
            const nameLower = file.print_file_name.toLowerCase();
            const nameWithoutExt = nameLower.endsWith(".gcode") ? nameLower.slice(0, -6).trim() : nameLower.trim();
            
            let isA1Mini = false;
            if (nameWithoutExt.endsWith("a1m") || nameWithoutExt.endsWith("mini")) {
              isA1Mini = true;
            } else if (nameWithoutExt.endsWith("a1")) {
              isA1Mini = false;
            } else {
              // Fallback regex matching
              isA1Mini = /(?:[-_ ]a1m\b|^a1m\b|\ba1m\b|[-_]a1m[-_\(])|(?:\bmini\b|[-_]mini\b)/i.test(nameLower) && !/\bminifig/i.test(nameLower);
            }

            let forPrinters: number[];
            if (isA1Mini) {
              forPrinters = [38959, 38960]; // A1 Mini pool: Mini Auto 1 & Mini Auto 2
            } else {
              forPrinters = [38961, 39538]; // A1 pool: A1 L & A1 R
            }

            // Add to global print queue
            const spResponse = await fetch(`https://api.simplyprint.io/${companyId}/queue/AddItem`, {
              method: "POST",
              headers: {
                "X-API-KEY": simplyprintApiKey,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                filesystem: file.simplyprint_file_id,
                amount: 1,
                for_printers: forPrinters,
                position: "bottom"
              })
            });

            if (!spResponse.ok) {
              const errorText = await spResponse.text();
              throw new Error(`SimplyPrint API failed for file ${file.print_file_name} (ID: ${file.simplyprint_file_id}). HTTP ${spResponse.status}: ${errorText}`);
            }

            const spData = await spResponse.json();
            const spJobId = spData.created_id ? String(spData.created_id) : "UNKNOWN_JOB_ID";

            // Record print job
            const { error: insertJobError } = await supabase.from('print_jobs').insert({
              order_item_id: item.id,
              print_file_id: file.id,
              print_file_name: file.print_file_name,
              simplyprint_job_id: spJobId,
              job_execution_status: 'pending'
            });

            if (insertJobError) {
              console.error(`Failed to insert print job in DB for SimplyPrint job ${spJobId}: ${insertJobError.message}`);
            }

            itemFilesDispatched++;
            totalFilesDispatched++;
          }
        }

        // Successfully dispatched all print files for this item
        await supabase
          .from('order_items')
          .update({ 
            item_print_status: 'printing',
            sent_to_print_timestamp: new Date().toISOString()
          })
          .eq('id', item.id);

        await checkOverallOrderStatus(supabase, item.order_id);
        processedItemIds.push(item.id);

        await supabase.from('system_logs').insert({
          agent_name: 'Foreman Edge Function',
          log_level: 'info',
          log_message: `Successfully dispatched ${itemFilesDispatched} files for order item ${item.id} (Order ID: ${item.order_id})`
        });

      } catch (err: any) {
        console.error(`Error processing item ${item.id}:`, err);
        // Revert status to pending on error so it can be retried
        await supabase
          .from('order_items')
          .update({ item_print_status: 'pending' })
          .eq('id', item.id);

        await supabase.from('system_logs').insert({
          agent_name: 'Foreman Edge Function',
          log_level: 'error',
          log_message: `Error processing item ${item.id}: ${err.message}`
        });
      }
    }

    return new Response(JSON.stringify({ 
      status: "success", 
      processed_items_count: processedItemIds.length,
      files_dispatched: totalFilesDispatched,
      fulfilled_from_stock: totalFulfilledFromStock 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error: any) {
    console.error(error);
    await createClient(supabaseUrl, supabaseServiceKey).from('system_logs').insert({
      agent_name: 'Foreman Edge Function', log_level: 'error', log_message: `Fatal Dispatch Error: ${error.message}`
    });
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

// Helper function to check and update overall order status
async function checkOverallOrderStatus(supabase: any, orderId: string) {
  if (!orderId) return;
  const { data: orderItems } = await supabase
    .from('order_items')
    .select('item_print_status')
    .eq('order_id', orderId);
    
  if (orderItems) {
    const allCompleted = orderItems.every((oi: any) => oi.item_print_status === 'completed');
    const allProductionReady = orderItems.every((oi: any) => 
      oi.item_print_status === 'printing' || oi.item_print_status === 'completed'
    );

    if (allCompleted) {
      await supabase.from('orders').update({ overall_order_status: 'completed' }).eq('id', orderId);
    } else if (allProductionReady) {
      await supabase.from('orders').update({ overall_order_status: 'printing' }).eq('id', orderId);
    }
  }
};

export function filterPrintFiles(printFiles: any[], variantName: string | null): any[] {
  if (!printFiles || printFiles.length === 0) return [];

  // 1. Deduplicate by simplyprint_file_id
  const uniqueFiles: any[] = [];
  const seenSpIds = new Set<string>();
  for (const f of printFiles) {
    if (f.simplyprint_file_id) {
      if (seenSpIds.has(f.simplyprint_file_id)) {
        continue;
      }
      seenSpIds.add(f.simplyprint_file_id);
    }
    uniqueFiles.push(f);
  }

  // 2. Filter by orientation if variantName contains vertical/horizontal keywords
  let filteredByOrientation = uniqueFiles;
  if (variantName) {
    const vNameLower = variantName.toLowerCase();
    const isVertOrder = vNameLower.includes("vert") || vNameLower.includes("vertical") || vNameLower.includes("vfwm") || vNameLower.includes("vwm");
    const isHorizOrder = vNameLower.includes("horiz") || vNameLower.includes("horizontal") || vNameLower.includes("hfwm") || vNameLower.includes("hwm");

    if (isVertOrder || isHorizOrder) {
      filteredByOrientation = uniqueFiles.filter(f => {
        const fNameLower = f.print_file_name.toLowerCase();
        const isVertFile = fNameLower.includes("vfwm") || fNameLower.includes("vwm") || fNameLower.includes("vert") || fNameLower.includes("-v-") || fNameLower.includes("_v_");
        const isHorizFile = fNameLower.includes("hfwm") || fNameLower.includes("hwm") || fNameLower.includes("horiz") || fNameLower.includes("-h-") || fNameLower.includes("_h_");

        if (isVertOrder && isHorizFile && !isVertFile) {
          return false;
        }
        if (isHorizOrder && isVertFile && !isHorizFile) {
          return false;
        }
        return true;
      });
    }
  }

  // 3. Prefer A1M over A1 slices
  const plates: any[] = [];
  const mains: any[] = [];

  for (const f of filteredByOrientation) {
    const nameLower = f.print_file_name.toLowerCase();
    if (nameLower.includes("plate")) {
      plates.push(f);
    } else {
      mains.push(f);
    }
  }

  const filterSlices = (files: any[]) => {
    if (files.length <= 1) return files;

    const hasA1M = files.some(f => {
      const nameLower = f.print_file_name.toLowerCase();
      return nameLower.includes("a1m") || nameLower.includes("mini");
    });

    if (hasA1M) {
      return files.filter(f => {
        const nameLower = f.print_file_name.toLowerCase();
        if (nameLower.includes("a1") && !nameLower.includes("a1m") && !nameLower.includes("mini")) {
          return false;
        }
        return true;
      });
    }
    return files;
  };

  const processGroup = (files: any[]) => {
    if (files.length === 0) return [];

    // Group files by part index
    const groups = new Map<string, any[]>();
    for (const f of files) {
      const nameLower = f.print_file_name.toLowerCase();
      const match = nameLower.match(/(?:\(|_|\b)(?:part|pt|p)?\s*([1-9])\s*(?:\)|\b)/i);
      const index = match ? match[1] : "default";
      if (!groups.has(index)) {
        groups.set(index, []);
      }
      groups.get(index)!.push(f);
    }

    // Check if we have any numbered parts that are A1M
    let hasNumberedA1M = false;
    for (const [index, groupFiles] of groups.entries()) {
      if (index !== "default") {
        const hasA1M = groupFiles.some(f => {
          const nameLower = f.print_file_name.toLowerCase();
          return nameLower.includes("a1m") || nameLower.includes("mini");
        });
        if (hasA1M) {
          hasNumberedA1M = true;
          break;
        }
      }
    }

    // If we have numbered A1M parts, we should discard the "default" (unsplit) group
    if (hasNumberedA1M && groups.has("default")) {
      groups.delete("default");
    }

    const result: any[] = [];
    // For each part group, apply slice filtering (prefer A1M over A1)
    for (const [index, groupFiles] of groups.entries()) {
      const filtered = filterSlices(groupFiles);
      if (filtered.length === 1) {
        result.push(filtered[0]);
      } else if (filtered.length > 1) {
        const sorted = [...filtered].sort((a, b) => b.print_file_name.length - a.print_file_name.length);
        result.push(sorted[0]);
      }
    }
    return result;
  };

  const finalPlates = processGroup(plates);
  const finalMains = processGroup(mains);

  return [...finalMains, ...finalPlates];
}

