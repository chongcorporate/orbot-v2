-- Enable pg_net extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create or replace trigger function to call status_reporter edge function
--
-- IMPORTANT: status_reporter now requires a shared-secret X-Orbot-Key header (fails closed
-- with 401 if missing/wrong). Replace REPLACE_WITH_ORBOT_API_KEY_VALUE below with the same
-- value configured as the ORBOT_API_KEY secret on the Supabase Edge Function
-- (Project Settings > Edge Functions > Secrets) before running this script.
CREATE OR REPLACE FUNCTION notify_system_log_event()
RETURNS TRIGGER AS $$
DECLARE
  payload jsonb;
BEGIN
  -- Build payload structure expected by status_reporter: {"record": {...}}
  payload := jsonb_build_object('record', row_to_json(NEW));

  -- Invoke status_reporter Edge Function
  -- NOTE: the function requires a valid JWT (anon key below) AND the X-Orbot-Key shared
  -- secret, or Supabase / the function itself returns 401 and the alert never fires.
  PERFORM net.http_post(
    url := 'https://velgortxgdouxbkonirr.supabase.co/functions/v1/status_reporter',
    body := payload,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZlbGdvcnR4Z2RvdXhia29uaXJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyODg3NzAsImV4cCI6MjA5Mjg2NDc3MH0.g0gV69-MABjTt4leFyUPjgScvTplHT2Dcqb_JuYalcY", "X-Orbot-Key": "REPLACE_WITH_ORBOT_API_KEY_VALUE"}'::jsonb,
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists
DROP TRIGGER IF EXISTS trg_system_logs_notification ON system_logs;

-- Create trigger AFTER INSERT on system_logs
CREATE TRIGGER trg_system_logs_notification
AFTER INSERT ON system_logs
FOR EACH ROW
EXECUTE FUNCTION notify_system_log_event();
