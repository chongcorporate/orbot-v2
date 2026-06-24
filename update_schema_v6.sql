-- Schema v6: first-class set_number + plaque_count on variants;
--            normalized_variation_name + match_source on listing_variations.

-- ── 1. variants: add computed columns ─────────────────────────────────────
ALTER TABLE variants ADD COLUMN IF NOT EXISTS set_number TEXT;
ALTER TABLE variants ADD COLUMN IF NOT EXISTS plaque_count INTEGER;

-- Backfill set_number from SKU pattern BLO-{THEME}-{SET}-{SUFFIX}
UPDATE variants
SET set_number = (regexp_match(variant_sku, '-(\d{4,6})-'))[1]
WHERE set_number IS NULL;

-- Backfill plaque_count from SKU suffix -DS-N (only for DS type)
UPDATE variants
SET plaque_count = CAST((regexp_match(variant_sku, '-DS-(\d+)$'))[1] AS INTEGER)
WHERE variant_sku ~ '-DS-\d+$'
  AND variant_type = 'DS'
  AND plaque_count IS NULL;

-- Indexes for Stage 2 direct lookup
CREATE INDEX IF NOT EXISTS idx_variants_set_number
  ON variants(set_number);

CREATE INDEX IF NOT EXISTS idx_variants_set_type_plaque
  ON variants(set_number, variant_type, plaque_count);

-- ── 2. listing_variations: add matching columns ────────────────────────────
ALTER TABLE listing_variations
  ADD COLUMN IF NOT EXISTS normalized_variation_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS match_source TEXT NOT NULL DEFAULT 'catalog';

-- Index for Stage 1 fast path
CREATE INDEX IF NOT EXISTS idx_lv_listing_norm
  ON listing_variations(listing_id, normalized_variation_name);

-- NOTE: After running this migration, run scratch/backfill_normalized_variations.py
-- to populate normalized_variation_name for all existing listing_variations rows.
