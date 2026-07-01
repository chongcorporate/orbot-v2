-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Trigger function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 1. Product table (Master products)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    brand_name TEXT NOT NULL,
    product_category TEXT,
    master_sku TEXT UNIQUE NOT NULL,
    product_base_name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger for products
DROP TRIGGER IF EXISTS update_products_updated_at ON products;
CREATE TRIGGER update_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. Variants table (Physical properties of each variation)
CREATE TABLE IF NOT EXISTS variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    variant_sku TEXT UNIQUE NOT NULL,
    variant_name TEXT NOT NULL,
    variant_type TEXT NOT NULL,  -- Free-form: LEGO shops use BASE/DS/WM/DS-NP/FWM/Skadis/Lift/SKADIS/VDS/Keychain;
                                  -- generic (non-LEGO) shops use their own type names. Not DB-constrained.
    set_number TEXT,       -- LEGO set number (e.g. "75389"); NULL for F1/generic SKUs
    plaque_count INTEGER,  -- N for DS-N variants; NULL for DS-NP/WM/FWM/BASE
    seal_sticker_gdrive_url TEXT,
    print_files_gdrive_url TEXT,
    pictures_gdrive_url TEXT,
    new_print_files_gdrive_url TEXT,
    new_pictures_gdrive_url TEXT,
    file_checklist TEXT,
    adobe_express_url TEXT,
    reference_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_variants_product_id ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_set_number ON variants(set_number);
CREATE INDEX IF NOT EXISTS idx_variants_set_type_plaque ON variants(set_number, variant_type, plaque_count);

-- Trigger for variants
DROP TRIGGER IF EXISTS update_variants_updated_at ON variants;
CREATE TRIGGER update_variants_updated_at
BEFORE UPDATE ON variants
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3. Print Files table (Handles multiple files per variant)
CREATE TABLE IF NOT EXISTS print_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id UUID REFERENCES variants(id) ON DELETE CASCADE,
    print_file_name TEXT NOT NULL,
    variant_sku TEXT,
    simplyprint_file_id TEXT,
    weight_g NUMERIC DEFAULT 0,
    print_time_m INTEGER DEFAULT 0,
    reference_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_print_files_variant_id ON print_files(variant_id);

-- Trigger for print_files
DROP TRIGGER IF EXISTS update_print_files_updated_at ON print_files;
CREATE TRIGGER update_print_files_updated_at
BEFORE UPDATE ON print_files
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 4. Listings table (One entry per "Shop Listing")
CREATE TABLE IF NOT EXISTS listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    platform_listing_name TEXT UNIQUE NOT NULL,
    platform_listing_description TEXT,
    price_myr NUMERIC(10, 2),
    price_sgd NUMERIC(10, 2),
    shopee_my TEXT, 
    shopee_sg TEXT, 
    shopee_ph TEXT, 
    shopee_th TEXT, 
    lazada_my TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listings_product_id ON listings(product_id);

-- Trigger for listings
DROP TRIGGER IF EXISTS update_listings_updated_at ON listings;
CREATE TRIGGER update_listings_updated_at
BEFORE UPDATE ON listings
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. Listing Variations (Bridging table for translation)
CREATE TABLE IF NOT EXISTS listing_variations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES variants(id) ON DELETE CASCADE,
    platform_variation_name TEXT DEFAULT '' NOT NULL,       -- Raw name from platform
    normalized_variation_name TEXT NOT NULL DEFAULT '',     -- Canonical form for matching
    match_source TEXT NOT NULL DEFAULT 'catalog',           -- 'catalog' | 'self_heal' | 'manual'
    reference_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(listing_id, platform_variation_name)
);

CREATE INDEX IF NOT EXISTS idx_listing_variations_variant_id ON listing_variations(variant_id);
CREATE INDEX IF NOT EXISTS idx_listing_variations_listing_id ON listing_variations(listing_id);
CREATE INDEX IF NOT EXISTS idx_lv_listing_norm ON listing_variations(listing_id, normalized_variation_name);

-- Trigger for listing_variations
DROP TRIGGER IF EXISTS update_listing_variations_updated_at ON listing_variations;
CREATE TRIGGER update_listing_variations_updated_at
BEFORE UPDATE ON listing_variations
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 6. Orders table (Overall customer order)
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    platform_order_id TEXT UNIQUE NOT NULL,
    order_timestamp TIMESTAMP WITH TIME ZONE,
    sales_platform TEXT, 
    customer_name TEXT,
    order_subtotal NUMERIC(10, 2),
    order_currency TEXT DEFAULT 'MYR',
    raw_waybill_gdrive_url TEXT, 
    processed_waybill_gdrive_url TEXT, 
    waybill_processing_status TEXT DEFAULT 'pending',
    overall_order_status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger for orders
DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 7. Order Items table (What the customer bought)
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    variant_id UUID REFERENCES variants(id) ON DELETE SET NULL, 
    variant_sku TEXT,
    variant_name TEXT,
    purchased_quantity INTEGER DEFAULT 1,
    item_print_status TEXT DEFAULT 'pending',
    sent_to_print_timestamp TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_variant_id ON order_items(variant_id);

-- Trigger for order_items
DROP TRIGGER IF EXISTS update_order_items_updated_at ON order_items;
CREATE TRIGGER update_order_items_updated_at
BEFORE UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 8. Print Jobs table
CREATE TABLE IF NOT EXISTS print_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_item_id UUID REFERENCES order_items(id) ON DELETE CASCADE,
    print_file_id UUID REFERENCES print_files(id) ON DELETE SET NULL,
    print_file_name TEXT,
    simplyprint_job_id TEXT,
    job_execution_status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_order_item_id ON print_jobs(order_item_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_print_file_id ON print_jobs(print_file_id);

-- Trigger for print_jobs
DROP TRIGGER IF EXISTS update_print_jobs_updated_at ON print_jobs;
CREATE TRIGGER update_print_jobs_updated_at
BEFORE UPDATE ON print_jobs
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 9. System Logs
CREATE TABLE IF NOT EXISTS system_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name TEXT NOT NULL,
    log_level TEXT NOT NULL, 
    log_message TEXT NOT NULL,
    additional_details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on all tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_variations ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- Database Schema Comments for Agent Introspection
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
COMMENT ON COLUMN variants.variant_type IS 'Free-form. LEGO shops (shops.product_model=lego_display) use BASE/DS/WM/DS-NP/FWM/Skadis/Lift/SKADIS/VDS/Keychain; generic shops use their own type names.';
COMMENT ON COLUMN variants.adobe_express_url IS 'Link to the Adobe Express sticker template.';
COMMENT ON COLUMN print_files.simplyprint_file_id IS 'External file reference ID on SimplyPrint API.';
COMMENT ON COLUMN listings.shopee_my IS 'Listing item ID on Shopee MY Seller Center.';
COMMENT ON COLUMN listing_variations.platform_variation_name IS 'Exact string name of variation on sales channel.';

-- Status CHECK constraints
ALTER TABLE orders ADD CONSTRAINT chk_overall_order_status CHECK (LOWER(overall_order_status) IN ('pending', 'printing', 'printed', 'completed', 'hold', 'on hold', 'cancelled', 'failed'));
ALTER TABLE orders ADD CONSTRAINT chk_waybill_processing_status CHECK (LOWER(waybill_processing_status) IN ('pending', 'processing', 'ready', 'ready to print', 'printed', 'completed', 'failed'));
ALTER TABLE order_items ADD CONSTRAINT chk_item_print_status CHECK (LOWER(item_print_status) IN ('pending', 'printing', 'completed', 'failed', 'not_applicable'));
ALTER TABLE print_jobs ADD CONSTRAINT chk_job_execution_status CHECK (LOWER(job_execution_status) IN ('pending', 'printing', 'completed', 'failed'));

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_orders_overall_order_status ON orders(overall_order_status);
CREATE INDEX IF NOT EXISTS idx_print_files_simplyprint_id ON print_files(simplyprint_file_id) WHERE simplyprint_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_system_logs_level_created ON system_logs(log_level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created_at_desc ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waybill_jobs_created_at_desc ON waybill_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_jobs_created_at_desc ON print_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at_desc ON system_logs(created_at DESC);
