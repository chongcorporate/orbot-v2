import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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

    const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
    const telegramChatId = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

    if (!telegramBotToken || !telegramChatId) {
      throw new Error("Missing Telegram configuration");
    }

    const icon = logEntry.log_level === 'error' ? "🚨" : "⚠️";
    const textMessage = `${icon} *Orbot Alert: ${logEntry.agent_name}*\n\n*Level:* ${logEntry.log_level.toUpperCase()}\n*Message:* ${logEntry.log_message}\n*Time:* ${new Date(logEntry.created_at).toLocaleString()}`;

    const tgUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const tgResponse = await fetch(tgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: textMessage,
        parse_mode: "Markdown"
      })
    });

    if (!tgResponse.ok) {
      throw new Error("Failed to send Telegram message");
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
