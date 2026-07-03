-- v10: app-wide settings that must sync across every browser/device the dashboard
-- is opened from (previously stored in localStorage, so they only ever applied to
-- whichever single browser they were typed into). Key-value so future toggles don't
-- need another migration.

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value)
VALUES ('sp_dispatch_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
