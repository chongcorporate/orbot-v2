-- Migration to remove unused reference columns
ALTER TABLE order_items DROP COLUMN IF EXISTS reference_name;
ALTER TABLE print_jobs DROP COLUMN IF EXISTS reference_name;
ALTER TABLE variants DROP COLUMN IF EXISTS reference_product;
