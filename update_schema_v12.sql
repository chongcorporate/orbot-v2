-- Schema v12: lossless email ingestion + extraction verification
-- Every order email is stored verbatim BEFORE parsing, so a bad LLM parse can
-- never lose order content. Orders gain a link back to their source email and
-- a hold_reason explaining why verification held them.

CREATE TABLE IF NOT EXISTS ingested_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gmail_message_id TEXT UNIQUE NOT NULL,
    subject TEXT,
    sender TEXT,
    received_at TIMESTAMPTZ,
    raw_body TEXT,               -- full extracted text, pre-cleaning (source of truth)
    cleaned_body TEXT,           -- what was actually sent to the LLM
    parse_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (parse_status IN ('pending', 'parsed', 'held', 'failed', 'not_order')),
    parse_error TEXT,
    order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingested_emails_parse_status ON ingested_emails(parse_status);
CREATE INDEX IF NOT EXISTS idx_ingested_emails_order_id ON ingested_emails(order_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_email_id UUID REFERENCES ingested_emails(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_reason TEXT;

-- RLS: same anon_full_access pattern as v11 (frontend reads raw emails for the
-- side-by-side review pane; backend uses the service key and bypasses RLS).
ALTER TABLE ingested_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_full_access" ON ingested_emails;
CREATE POLICY "anon_full_access" ON ingested_emails
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);
