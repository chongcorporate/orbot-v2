-- Enable necessary extensions if they aren't already enabled
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Unschedule any existing job with the same name just in case
select cron.unschedule('scout-agent-job');

-- Schedule the Scout Edge Function to run every 5 minutes
--
-- IMPORTANT: scout now requires a shared-secret X-Orbot-Key header (fails closed with 401
-- if missing/wrong). Replace REPLACE_WITH_ORBOT_API_KEY_VALUE below with the same value
-- configured as the ORBOT_API_KEY secret on the Supabase Edge Function
-- (Project Settings > Edge Functions > Secrets) before running this script.
select cron.schedule(
  'scout-agent-job', -- Name of the cron job
  '*/5 * * * *',     -- Cron schedule (every 5 minutes)
  $$
  select net.http_post(
      -- REPLACE <YOUR_PROJECT_REFERENCE> with your actual project ref (e.g. abcdefghijklmnop)
      url:='https://<YOUR_PROJECT_REFERENCE>.supabase.co/functions/v1/scout',

      -- REPLACE <YOUR_ANON_KEY> with your actual anon/service key, and
      -- REPLACE_WITH_ORBOT_API_KEY_VALUE with the ORBOT_API_KEY secret value
      headers:='{"Authorization": "Bearer <YOUR_ANON_KEY>", "Content-Type": "application/json", "X-Orbot-Key": "REPLACE_WITH_ORBOT_API_KEY_VALUE"}'::jsonb
  )
  $$
);

-- Note: You can view the status of cron jobs by querying the cron.job_run_details table:
-- select * from cron.job_run_details order by start_time desc limit 10;
