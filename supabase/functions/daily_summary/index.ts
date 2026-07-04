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

  // Shared-secret authentication: fail closed if ORBOT_API_KEY is unset.
  // Invoked on a schedule via pg_cron/net.http_post — see
  // Other/setup_daily_summary_cron.sql, which must send this header too.
  const expectedKey = Deno.env.get("ORBOT_API_KEY");
  const providedKey = req.headers.get("X-Orbot-Key");
  if (!expectedKey || providedKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const discordWebhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL") ?? "";
    if (!discordWebhookUrl) {
      throw new Error("Missing Discord configuration");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date();

    // Compute "today" as a local Malaysia-time calendar day, not the server's
    // (UTC, on Supabase Edge Functions) local day — otherwise the boundary is
    // skewed by 8 hours and the report can include/exclude the wrong orders.
    const myParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const myYear = myParts.find(p => p.type === 'year')!.value;
    const myMonth = myParts.find(p => p.type === 'month')!.value;
    const myDay = myParts.find(p => p.type === 'day')!.value;
    // Malaysia is UTC+8 year-round (no DST), so local midnight in MYT is
    // 16:00 UTC on the previous calendar day.
    const midnight = new Date(`${myYear}-${myMonth}-${myDay}T00:00:00+08:00`).toISOString();

    // These three lookups are independent of each other — run them concurrently.
    const [
      { count: ordersToday },
      { data: jobsToday },
      { count: errorsToday },
    ] = await Promise.all([
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', midnight),
      supabase
        .from('print_jobs')
        .select('job_execution_status')
        .gte('created_at', midnight),
      supabase
        .from('system_logs')
        .select('id', { count: 'exact', head: true })
        .eq('log_level', 'error')
        .gte('created_at', midnight),
    ]);

    const jobStatusCounts: Record<string, number> = {};
    for (const job of jobsToday ?? []) {
      const status = job.job_execution_status ?? 'unknown';
      jobStatusCounts[status] = (jobStatusCounts[status] ?? 0) + 1;
    }
    const jobsSummary = Object.keys(jobStatusCounts).length
      ? Object.entries(jobStatusCounts).map(([status, n]) => `${status}: ${n}`).join("\n")
      : "No jobs dispatched today.";

    const dateStr = now.toLocaleDateString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: 'long', day: 'numeric' });

    const discordRes = await fetch(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: `📊 Orbot Daily Report — ${dateStr}`,
          color: 0x3498db,
          fields: [
            { name: "Orders Ingested", value: String(ordersToday ?? 0), inline: true },
            { name: "Errors Today", value: String(errorsToday ?? 0), inline: true },
            { name: "Print Jobs Dispatched", value: jobsSummary, inline: false },
          ],
          timestamp: now.toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!discordRes.ok) {
      throw new Error(`Failed to send Discord message: ${discordRes.status} ${await discordRes.text()}`);
    }

    return new Response(JSON.stringify({ status: "success" }), {
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
