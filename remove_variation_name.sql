-- Migration to remove variation_name column from listing_variations
ALTER TABLE listing_variations DROP COLUMN IF EXISTS variation_name;
