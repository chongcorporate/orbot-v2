-- =============================================================================
-- Data fixes from the 2026-07-05 full-system debug. REVIEW, THEN RUN ONCE against
-- the live DB (Supabase SQL editor, or:
--   npx supabase db query --linked -f data_fixes_2026-07-05.sql ).
-- All statements are idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Backfill listing_variations.normalized_variation_name (63 rows affected as
--    of 2026-07-05). /catalog/import never set this column, so every variation
--    imported since the last one-time backfill has '' — invisible to Stage 1
--    exact matching, which is why orders kept landing as "FUZZY MATCH — VERIFY
--    SKU" warnings. The code fix (main.py process_catalog now writes the field)
--    stops new rows regressing; this repairs the existing ones.
--    Mirrors normalize_variation() in main.py: lowercase, ' - ' around hyphens,
--    no spaces around commas, collapsed whitespace.
-- -----------------------------------------------------------------------------
UPDATE listing_variations
SET normalized_variation_name = regexp_replace(
      regexp_replace(
        regexp_replace(
          lower(trim(platform_variation_name)),
          '\s*-\s*', ' - ', 'g'),
        '\s*,\s*', ',', 'g'),
      '\s+', ' ', 'g')
WHERE normalized_variation_name = ''
  AND trim(platform_variation_name) <> '';

-- -----------------------------------------------------------------------------
-- 2. Add the missing listing for the NASA Space Shuttle Discovery wall mount.
--    Order 260703PRBGA7CS ("Wall Mount for Lego NASA Space Shuttle Discovery
--    (10283) (2 in 1)", variation None) failed all matching stages because no
--    listings row exists for it, and is still stuck in 'pending' with an
--    unmatched item. Variant BLO-ICN-10283-WM exists; link a listing +
--    blank-variation mapping so future orders Stage-1 match.
-- -----------------------------------------------------------------------------
INSERT INTO listings (product_id, platform_listing_name, is_active)
SELECT v.product_id,
       'Wall Mount for Lego NASA Space Shuttle Discovery (10283) (2 in 1)',
       true
FROM variants v
WHERE v.variant_sku = 'BLO-ICN-10283-WM'
ON CONFLICT (platform_listing_name) DO NOTHING;

INSERT INTO listing_variations (listing_id, variant_id, platform_variation_name,
                                normalized_variation_name, match_source, reference_name)
SELECT l.id, v.id, '', '', 'catalog',
       'Wall Mount for Lego NASA Space Shuttle Discovery (10283) (2 in 1) [Base]'
FROM listings l
JOIN variants v ON v.variant_sku = 'BLO-ICN-10283-WM'
WHERE l.platform_listing_name = 'Wall Mount for Lego NASA Space Shuttle Discovery (10283) (2 in 1)'
ON CONFLICT (listing_id, platform_variation_name) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Remove stale agent_heartbeats rows. The backend consolidated to
--    'orbot_service' + 'scout'; 'waybill_agent' (stale since 2026-06-20) and
--    'archivist' (stale since 2026-06-16) are leftovers that make status
--    surfaces show dead agents.
-- -----------------------------------------------------------------------------
DELETE FROM agent_heartbeats WHERE agent_name IN ('waybill_agent', 'archivist');

-- -----------------------------------------------------------------------------
-- 4. Repair the stuck order 260703PRBGA7CS: point its placeholder item at the
--    real variant. Left as item_print_status='not_applicable' ON PURPOSE so
--    Foreman does NOT auto-print it — Joel deleted this order once already and
--    may have fulfilled it manually. To actually print it, set
--    item_print_status='pending' afterwards and trigger Foreman.
-- -----------------------------------------------------------------------------
UPDATE order_items oi
SET variant_id   = v.id,
    variant_sku  = v.variant_sku,
    variant_name = v.variant_name
FROM variants v
WHERE v.variant_sku = 'BLO-ICN-10283-WM'
  AND oi.id = '9d26180b-32ac-4daf-855d-5b2750fe8d24'
  AND oi.variant_id IS NULL;
