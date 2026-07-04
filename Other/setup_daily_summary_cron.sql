-- Enable necessary extensions if they aren't already enabled
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Unschedule any existing job with the same name just in case (no-op if it doesn't exist yet)
DO $$
BEGIN
  PERFORM cron.unschedule('daily-summary-job');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Schedule the daily_summary Edge Function to run once a day at 18:00 MYT (UTC+8) = 10:00 UTC
--
-- IMPORTANT: daily_summary now requires a shared-secret X-Orbot-Key header (fails closed
-- with 401 if missing/wrong). Replace REPLACE_WITH_ORBOT_API_KEY_VALUE below with the same
-- value configured as the ORBOT_API_KEY secret on the Supabase Edge Function
-- (Project Settings > Edge Functions > Secrets) before running this script.
select cron.schedule(
  'daily-summary-job', -- Name of the cron job
  '0 10 * * *',         -- Cron schedule (10:00 UTC daily = 18:00 Malaysia time)
  $$
  select net.http_post(
      url:='https://velgortxgdouxbkonirr.supabase.co/functions/v1/daily_summary',
      headers:='{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZlbGdvcnR4Z2RvdXhia29uaXJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyODg3NzAsImV4cCI6MjA5Mjg2NDc3MH0.g0gV69-MABjTt4leFyUPjgScvTplHT2Dcqb_JuYalcY", "Content-Type": "application/json", "X-Orbot-Key": "REPLACE_WITH_ORBOT_API_KEY_VALUE"}'::jsonb
  )
  $$
);

-- Note: You can view the status of cron jobs by querying the cron.job_run_details table:
-- select * from cron.job_run_details order by start_time desc limit 10;
