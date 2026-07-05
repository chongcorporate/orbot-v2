-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Trigger function to auto-update updated_at (if not already exists)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 1. Upgrade variants table
ALTER TABLE variants RENAME COLUMN seal_sticker_gdrive TO seal_sticker_gdrive_url;
ALTER TABLE variants RENAME COLUMN design_files_gdrive TO design_files_gdrive_url;
ALTER TABLE variants RENAME COLUMN product_pictures_gdrive TO product_pictures_gdrive_url;
ALTER TABLE variants RENAME COLUMN express_delivery TO adobe_express_template_url;

-- Ensure triggers exist on variants
DROP TRIGGER IF EXISTS update_variants_updated_at ON variants;
CREATE TRIGGER update_variants_updated_at
BEFORE UPDATE ON variants
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. Upgrade listings table
ALTER TABLE listings RENAME COLUMN shopee_my TO shopee_my_id;
ALTER TABLE listings RENAME COLUMN shopee_sg TO shopee_sg_id;
ALTER TABLE listings RENAME COLUMN shopee_ph TO shopee_ph_id;
ALTER TABLE listings RENAME COLUMN shopee_th TO shopee_th_id;
ALTER TABLE listings RENAME COLUMN lazada_my TO lazada_my_id;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Ensure triggers exist on listings
DROP TRIGGER IF EXISTS update_listings_updated_at ON listings;
CREATE TRIGGER update_listings_updated_at
BEFORE UPDATE ON listings
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3. Upgrade print_files table
ALTER TABLE print_files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

DROP TRIGGER IF EXISTS update_print_files_updated_at ON print_files;
CREATE TRIGGER update_print_files_updated_at
BEFORE UPDATE ON print_files
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 4. Upgrade listing_variations table
ALTER TABLE listing_variations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

DROP TRIGGER IF EXISTS update_listing_variations_updated_at ON listing_variations;
CREATE TRIGGER update_listing_variations_updated_at
BEFORE UPDATE ON listing_variations
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. Upgrade orders table
ALTER TABLE orders RENAME COLUMN raw_waybill_gdrive TO raw_waybill_gdrive_url;
ALTER TABLE orders RENAME COLUMN processed_waybill_gdrive TO processed_waybill_gdrive_url;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 6. Upgrade order_items table
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

DROP TRIGGER IF EXISTS update_order_items_updated_at ON order_items;
CREATE TRIGGER update_order_items_updated_at
BEFORE UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 7. Upgrade print_jobs table
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

DROP TRIGGER IF EXISTS update_print_jobs_updated_at ON print_jobs;
CREATE TRIGGER update_print_jobs_updated_at
BEFORE UPDATE ON print_jobs
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 8. Enable Row-Level Security on all tables (in case it is disabled)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_variations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- 9. Add system schema comments for AI agents
COMMENT ON TABLE products IS 'Master product catalog containing LEGO sets and brands.';
COMMENT ON TABLE variants IS 'Physical variant properties for each product variation.';
COMMENT ON TABLE print_files IS 'G-code print files associated with product variants.';
COMMENT ON TABLE listings IS 'Storefront listings mapping to base products.';
COMMENT ON TABLE listing_variations IS 'Bridging table mapping platform option labels to physical variants.';
COMMENT ON TABLE orders IS 'Customer orders received from sales platforms.';
COMMENT ON TABLE order_items IS 'Line items purchased in a customer order.';
COMMENT ON TABLE print_jobs IS 'SimplyPrint queue dispatch records for individual items.';
COMMENT ON TABLE system_logs IS 'System-wide monitoring, warning, and error logs.';

COMMENT ON COLUMN products.master_sku IS 'Unique master set SKU without suffixes.';
COMMENT ON COLUMN variants.variant_sku IS 'Unique physical SKU including variation type.';
COMMENT ON COLUMN variants.variant_type IS 'Must be one of: BASE, DS, WM, DS-NP, FWM, Skadis, Lift, SKADIS, VDS, Keychain.';
COMMENT ON COLUMN variants.adobe_express_template_url IS 'Link to the Adobe Express sticker template.';
COMMENT ON COLUMN print_files.simplyprint_file_id IS 'External file reference ID on SimplyPrint API.';
COMMENT ON COLUMN listings.shopee_my_id IS 'Lising item ID on Shopee MY Seller Center.';
COMMENT ON COLUMN listing_variations.platform_variation_name IS 'Exact string name of variation on sales channel.';
