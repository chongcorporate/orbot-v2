-- =============================================================================
-- v11: RLS coverage for `shops` / `app_settings`, anon-role policies for the
-- dashboard, a missing `gemini_usage_log` table definition, and a fix for the
-- broken `waybill_jobs` index in init_schema.sql.
-- =============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
-- (a) `shops` and `app_settings` were added in update_schema_v8.sql / v10.sql
--     without ever enabling Row Level Security. Every other business table in
--     init_schema.sql has RLS enabled (see init_schema.sql:211-220), so these
--     two were an oversight. This migration turns RLS on for both.
--
-- (b) The Orbot frontend dashboard (app.js) is moving from calling Supabase
--     with the service-role key (full bypass of RLS) to calling it with the
--     anon key, because there is no per-user login/auth flow yet — Supabase
--     credentials currently live in the browser's localStorage and are shared
--     by whoever has the URL. Turning on RLS with NO policies would silently
--     break every dashboard read/write (orders, products, print jobs, etc.)
--     the moment the frontend switches to the anon key.
--
--     To avoid that regression, this migration adds permissive
--     `FOR ALL ... TO anon USING (true) WITH CHECK (true)` policies on every
--     business table the dashboard directly reads/writes via supabase-js.
--     This intentionally preserves today's de-facto "anyone with the anon key
--     can do anything" behavior — it is NOT real access control. It exists so
--     enabling RLS doesn't break the app, not to restrict anyone.
--
--     Real per-user / per-shop access control requires adding actual
--     authentication (e.g. Supabase Auth) as a follow-up, then replacing these
--     `USING (true)` policies with policies scoped to the authenticated user
--     (e.g. by shop_id, by role, etc).
--
-- >>> REVIEW BEFORE APPLYING TO PRODUCTION. <<<
-- This migration changes live data-access permissions (enables RLS on tables
-- that currently have none, and adds broad anon policies across most of the
-- schema). Apply via `supabase db push` or the SQL editor only after reading
-- through every statement below and confirming it matches your intended
-- access model. This file deliberately does NOT get applied automatically by
-- this change — that is a separate, manual step for the project owner.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Enable RLS on the two tables that were missing it.
-- -----------------------------------------------------------------------------
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- 2. gemini_usage_log — used by scout, scout-webhook, and cancellation edge
--    functions to record LLM token usage, but never defined in any audited
--    schema file. Columns inferred from the actual .insert({...}) calls:
--      agent_name, model_name, prompt_tokens, completion_tokens, total_tokens
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gemini_usage_log (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name        TEXT NOT NULL,
    model_name        TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gemini_usage_log_created_at ON gemini_usage_log(created_at DESC);

ALTER TABLE gemini_usage_log ENABLE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- 3. Anon-role policies for feature-parity with the current service-role-key
--    behavior. Every table the dashboard directly reads/writes via
--    supabase-js gets a permissive policy — INCLUDING waybill_jobs and
--    agent_heartbeats: app.js inserts waybill_jobs rows for every trigger
--    button (Gmail scan, batch compile, SimplyPrint sync, printer controls
--    incl. E-STOP), polls them, purges them, and reads agent_heartbeats for
--    the System Status panel. Without these policies the anon-key dashboard
--    gets silent empty reads and RLS-rejected writes on every one of those.
-- -----------------------------------------------------------------------------

CREATE POLICY "anon_full_access" ON products
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON variants
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON print_files
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON listings
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON listing_variations
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON orders
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON order_items
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON print_jobs
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON system_logs
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON shops
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON app_settings
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON gemini_usage_log
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON waybill_jobs
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_full_access" ON agent_heartbeats
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- The dashboard also uploads waybill PDFs straight into the incoming-waybills
-- storage bucket (app.js uses supabase.storage.from('incoming-waybills')).
-- Storage RLS lives on storage.objects; without an anon policy those uploads
-- fail the moment the frontend switches to the anon key.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'incoming-waybills') THEN
    EXECUTE $pol$
      CREATE POLICY "anon_incoming_waybills" ON storage.objects
        FOR ALL
        TO anon
        USING (bucket_id = 'incoming-waybills')
        WITH CHECK (bucket_id = 'incoming-waybills')
    $pol$;
  END IF;
END $$;


-- -----------------------------------------------------------------------------
-- 4. Fix: init_schema.sql:252 indexes waybill_jobs, which init_schema.sql never
--    creates (it's created separately in Other/create_waybill_jobs.sql). Running
--    init_schema.sql standalone against a fresh database therefore fails at that
--    line with "relation waybill_jobs does not exist".
--
--    The bad line has been deleted from init_schema.sql directly (a narrow,
--    one-line removal — not a rewrite of that file's history). The corrected
--    index statement lives here instead, guarded with IF NOT EXISTS and placed
--    after waybill_jobs is guaranteed to exist (this migration is applied after
--    Other/create_waybill_jobs.sql in the bootstrap order).
--
--    If you are bootstrapping a brand-new database from scratch, run in this
--    order: init_schema.sql -> Other/create_waybill_jobs.sql -> ... -> this file.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_waybill_jobs_created_at_desc ON waybill_jobs (created_at DESC);


-- -----------------------------------------------------------------------------
-- 5. simplyprint_printers / simplyprint_queue — queried directly by app.js
--    (supabase.from("simplyprint_printers") / .from("simplyprint_queue")) but,
--    like shops/app_settings, never defined via CREATE TABLE in any audited
--    schema file — they exist in production only from ad-hoc creation outside
--    version control. Without RLS + a policy here, these two views silently
--    break the moment the frontend switches from the service-role key to anon.
--    Uses DROP POLICY IF EXISTS first since these tables may already have RLS
--    state that predates this migration and we don't have a schema record of it.
-- -----------------------------------------------------------------------------
ALTER TABLE simplyprint_printers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_full_access" ON simplyprint_printers;
CREATE POLICY "anon_full_access" ON simplyprint_printers
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

ALTER TABLE simplyprint_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_full_access" ON simplyprint_queue;
CREATE POLICY "anon_full_access" ON simplyprint_queue
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);
