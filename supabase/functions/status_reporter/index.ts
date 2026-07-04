import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Shared-secret authentication: fail closed if ORBOT_API_KEY is unset.
  // Invoked by the notify_system_log_event() trigger via net.http_post — see
  // Other/setup_status_reporter_webhook.sql, which must send this header too.
  const expectedKey = Deno.env.get("ORBOT_API_KEY");
  const providedKey = req.headers.get("X-Orbot-Key");
  if (!expectedKey || providedKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json();
    const logEntry = payload.record;

    if (!logEntry || !logEntry.log_level || !logEntry.log_message) {
      throw new Error("Invalid webhook payload for system_logs");
    }

    // Only fire alerts for errors and warnings
    if (logEntry.log_level !== 'error' && logEntry.log_level !== 'warning') {
      return new Response("ok", { headers: corsHeaders, status: 200 });
    }

    const discordWebhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL") ?? "";

    if (!discordWebhookUrl) {
      throw new Error("Missing Discord configuration");
    }

    const isError = logEntry.log_level === 'error';
    const isFuzzyMatch = Boolean(logEntry.additional_details?.fuzzy_match);

    let icon = isError ? "🚨" : "⚠️";
    let color = isError ? 0xe74c3c : 0xf1c40f; // red for error, yellow for warning
    let title = `${icon} Orbot Alert: ${logEntry.agent_name ?? "Unknown"}`;

    if (isFuzzyMatch) {
      // Fuzzy-matched orders aren't failures, but they're a silent SKU-mismatch risk —
      // give them their own look so they never blend in with routine warnings.
      icon = "🔶";
      color = 0xe67e22; // orange, distinct from both error-red and warning-yellow
      title = "🔶🔶 FUZZY MATCH — VERIFY SKU BEFORE PRINTING 🔶🔶";
    }

    const fields = [
      { name: "Agent", value: String(logEntry.agent_name ?? "Unknown"), inline: true },
      { name: "Level", value: logEntry.log_level.toUpperCase(), inline: true },
    ];

    if (logEntry.additional_details) {
      const details = typeof logEntry.additional_details === "string"
        ? logEntry.additional_details
        : JSON.stringify(logEntry.additional_details, null, 2);
      fields.push({ name: "Details", value: "```json\n" + details.slice(0, 1000) + "\n```", inline: false });
    }

    const discordRes = await fetch(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title,
          description: logEntry.log_message,
          color,
          fields,
          timestamp: logEntry.created_at ?? new Date().toISOString(),
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
