-- Enable necessary extensions if they aren't already enabled
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Unschedule any existing job with the same name just in case
select cron.unschedule('scout-agent-job');

-- Schedule the Scout Edge Function to run every 5 minutes
select cron.schedule(
  'scout-agent-job', -- Name of the cron job
  '*/5 * * * *',     -- Cron schedule (every 5 minutes)
  $$
  select net.http_post(
      -- REPLACE <YOUR_PROJECT_REFERENCE> with your actual project ref (e.g. abcdefghijklmnop)
      url:='https://<YOUR_PROJECT_REFERENCE>.supabase.co/functions/v1/scout',
      
      -- REPLACE <YOUR_ANON_KEY> with your actual anon/service key
      headers:='{"Authorization": "Bearer <YOUR_ANON_KEY>", "Content-Type": "application/json"}'::jsonb
  )
  $$
);

-- Note: You can view the status of cron jobs by querying the cron.job_run_details table:
-- select * from cron.job_run_details order by start_time desc limit 10;
