CREATE TABLE IF NOT EXISTS simplyprint_printers (
    id integer PRIMARY KEY,
    name text NOT NULL,
    state text NOT NULL,
    online boolean NOT NULL,
    nozzle_temp numeric,
    nozzle_target numeric,
    bed_temp numeric,
    bed_target numeric,
    model_name text,
    model_brand text,
    current_job_name text,
    percent_complete numeric,
    remaining_seconds numeric,
    updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS simplyprint_queue (
    id integer PRIMARY KEY,
    name text NOT NULL,
    position integer NOT NULL,
    estimate_seconds numeric,
    updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS and public select permissions
ALTER TABLE simplyprint_printers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public select on simplyprint_printers" ON simplyprint_printers;
CREATE POLICY "Allow public select on simplyprint_printers" ON simplyprint_printers FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow all on simplyprint_printers for service role" ON simplyprint_printers;
CREATE POLICY "Allow all on simplyprint_printers for service role" ON simplyprint_printers USING (true) WITH CHECK (true);

ALTER TABLE simplyprint_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public select on simplyprint_queue" ON simplyprint_queue;
CREATE POLICY "Allow public select on simplyprint_queue" ON simplyprint_queue FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow all on simplyprint_queue for service role" ON simplyprint_queue;
CREATE POLICY "Allow all on simplyprint_queue for service role" ON simplyprint_queue USING (true) WITH CHECK (true);
