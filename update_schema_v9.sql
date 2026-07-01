-- v9: multi-shop Phase 2 — generic (non-LEGO) shops need arbitrary variant_type values,
-- not just the LEGO-specific set (DS/WM/DS-NP/FWM/Skadis/Lift/SKADIS/VDS/Keychain/BASE).
--
-- Note: live prod was found to have NO CHECK constraint on variants.variant_type (schema
-- drift from init_schema.sql, which documented one that was apparently never applied or
-- was dropped ad-hoc). This migration is a defensive no-op for prod, and brings any
-- environment bootstrapped from the old init_schema.sql (which DID define the constraint)
-- in line with the now-corrected schema file.

ALTER TABLE variants DROP CONSTRAINT IF EXISTS variants_variant_type_check;

COMMENT ON COLUMN variants.variant_type IS
  'Free-form. LEGO shops (shops.product_model=lego_display) use BASE/DS/WM/DS-NP/FWM/Skadis/Lift/SKADIS/VDS/Keychain; generic shops use their own type names.';
