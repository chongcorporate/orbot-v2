-- Create waybill_jobs queue table
CREATE TABLE IF NOT EXISTS waybill_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload JSONB,
    result JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create agent_heartbeats table
CREATE TABLE IF NOT EXISTS agent_heartbeats (
    agent_name TEXT PRIMARY KEY,
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger to auto-update updated_at for waybill_jobs
DROP TRIGGER IF EXISTS update_waybill_jobs_updated_at ON waybill_jobs;
CREATE TRIGGER update_waybill_jobs_updated_at
BEFORE UPDATE ON waybill_jobs
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS
ALTER TABLE waybill_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_heartbeats ENABLE ROW LEVEL SECURITY;
