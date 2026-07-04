import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-simplyprint-key",
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

  const railwayUrl = Deno.env.get("RAILWAY_BACKEND_URL") ?? "https://web-production-fb6c3.up.railway.app";

  // Railway's /foreman/dispatch authenticates via the same ORBOT_API_KEY shared secret
  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Orbot-Key": expectedKey,
  };

  try {
    const res = await fetch(`${railwayUrl}/foreman/dispatch`, {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });
    // Railway serves HTML error pages on 5xx — read as text so the real body survives
    const raw = await res.text();
    let payload: string;
    try {
      payload = JSON.stringify(JSON.parse(raw));
    } catch {
      payload = JSON.stringify({ error: `Railway returned non-JSON (${res.status})`, body: raw.slice(0, 500) });
    }
    return new Response(payload, {
      status: res.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Proxy error: ${err.message}` }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
