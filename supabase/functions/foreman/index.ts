import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-simplyprint-key",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const railwayUrl = Deno.env.get("RAILWAY_BACKEND_URL") ?? "https://web-production-fb6c3.up.railway.app";

  const spKey = Deno.env.get("SIMPLYPRINT_API_KEY") ?? req.headers.get("x-simplyprint-key") ?? "";
  const forwardHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (spKey) forwardHeaders["X-SimplyPrint-Key"] = spKey;

  try {
    const res = await fetch(`${railwayUrl}/foreman/dispatch`, {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify({}),
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Proxy error: ${err.message}` }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
