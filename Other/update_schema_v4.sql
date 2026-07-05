-- 1. Upgrade variants table
ALTER TABLE variants RENAME COLUMN design_files_gdrive_url TO print_files_gdrive_url;
ALTER TABLE variants RENAME COLUMN product_pictures_gdrive_url TO pictures_gdrive_url;
ALTER TABLE variants RENAME COLUMN adobe_express_template_url TO adobe_express_url;

-- 2. Upgrade listings table
ALTER TABLE listings RENAME COLUMN shopee_my_id TO shopee_my;
ALTER TABLE listings RENAME COLUMN shopee_sg_id TO shopee_sg;
ALTER TABLE listings RENAME COLUMN shopee_ph_id TO shopee_ph;
ALTER TABLE listings RENAME COLUMN shopee_th_id TO shopee_th;
ALTER TABLE listings RENAME COLUMN lazada_my_id TO lazada_my;

-- 3. Upgrade listing_variations table (add denormalized columns)
ALTER TABLE listing_variations ADD COLUMN IF NOT EXISTS product_base_name TEXT;
ALTER TABLE listing_variations ADD COLUMN IF NOT EXISTS variation_name TEXT;

-- 4. Upgrade print_files table
ALTER TABLE print_files RENAME COLUMN material_weight_grams TO weight_g;
ALTER TABLE print_files RENAME COLUMN print_duration_minutes TO print_time_m;

-- 5. Upgrade orders table
ALTER TABLE orders RENAME COLUMN order_subtotal_amount TO order_subtotal;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_currency TEXT DEFAULT 'MYR';

-- 6. Upgrade order_items table (add denormalized columns & timestamp)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_sku TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_name TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS sent_to_print_timestamp TIMESTAMP WITH TIME ZONE;

-- 7. Upgrade print_jobs table (add denormalized column)
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_file_name TEXT;

-- 8. Refresh comments schema for AI introspection
COMMENT ON COLUMN variants.print_files_gdrive_url IS 'GDrive link to the print package files.';
COMMENT ON COLUMN variants.pictures_gdrive_url IS 'GDrive link to product pictures.';
COMMENT ON COLUMN variants.adobe_express_url IS 'Sticker template URL on Adobe Express.';
COMMENT ON COLUMN listings.shopee_my IS 'Shopee Malaysia listing item ID.';
COMMENT ON COLUMN print_files.weight_g IS 'Material weight in grams.';
COMMENT ON COLUMN print_files.print_time_m IS 'Print duration in minutes.';
COMMENT ON COLUMN orders.order_subtotal IS 'Order subtotal amount before shipping.';
COMMENT ON COLUMN orders.order_currency IS 'Currency of the subtotal amount (e.g. MYR, SGD).';
COMMENT ON COLUMN order_items.sent_to_print_timestamp IS 'Timestamp when this item was dispatched to SimplyPrint.';
COMMENT ON COLUMN print_jobs.print_file_name IS 'Cached name of the printed file.';
