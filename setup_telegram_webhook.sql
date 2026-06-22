-- Enable pg_net extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create or replace trigger function to call status_reporter edge function
CREATE OR REPLACE FUNCTION notify_system_log_event()
RETURNS TRIGGER AS $$
DECLARE
  payload text;
BEGIN
  -- Build payload structure expected by status_reporter: {"record": {...}}
  payload := jsonb_build_object('record', row_to_json(NEW))::text;

  -- Invoke status_reporter Edge Function
  PERFORM net.http_post(
    url := 'https://velgortxgdouxbkonirr.supabase.co/functions/v1/status_reporter',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := payload,
    timeout_ms := 5000
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
