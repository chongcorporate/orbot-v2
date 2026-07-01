-- v8: Multi-shop foundation (Phase 0).
-- Introduces `shops` as a first-class entity and attributes products + orders to a shop.
-- Backfills all existing data to the current single brand ("Blocked Off"). Safe/idempotent.

-- 1. shops table -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shops (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name              text NOT NULL,
    slug              text UNIQUE NOT NULL,
    sku_prefix        text NOT NULL,                       -- e.g. 'BLO'
    email_aliases     text[] NOT NULL DEFAULT '{}',        -- shop/seller names seen in order emails (Scout routing)
    product_model     text NOT NULL DEFAULT 'generic'      -- 'lego_display' gates the LEGO-specific matching stages
                       CHECK (product_model IN ('lego_display', 'generic')),
    default_currency  text NOT NULL DEFAULT 'MYR',
    waybill_folder_id text,                                -- per-shop Drive subfolder (Phase 3); NULL = use root
    ai_copy_profile   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- brand voice / product domain for Launch AI (Phase 2)
    is_active         boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 2. Seed the existing brand as the first shop (fixed id so DEFAULT + backfill can reference it) --
INSERT INTO shops (id, name, slug, sku_prefix, email_aliases, product_model, default_currency, ai_copy_profile)
VALUES (
    'e653db17-f5da-4a1d-87ed-bae349a9bfa9',
    'Blocked Off',
    'blocked-off',
    'BLO',
    ARRAY['Blocked Off','blockedoff','blockedoff.my','blockedoff.sg','blockedoff.ph','blockedoff.th'],
    'lego_display',
    'MYR',
    '{"domain":"custom 3D-printed LEGO display accessories","brand":"Blocked Off","region":"Malaysia","material_default":"PLA+"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- 3. products.shop_id ------------------------------------------------------------
-- DEFAULT to Blocked Off so existing insert paths (catalog import) keep attributing
-- correctly until Phase 2 wires shop selection into the importer explicitly.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS shop_id uuid
    REFERENCES shops(id) ON DELETE RESTRICT
    DEFAULT 'e653db17-f5da-4a1d-87ed-bae349a9bfa9';
UPDATE products SET shop_id = 'e653db17-f5da-4a1d-87ed-bae349a9bfa9' WHERE shop_id IS NULL;
ALTER TABLE products ALTER COLUMN shop_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_shop_id ON products(shop_id);

-- 4. orders.shop_id --------------------------------------------------------------
-- Nullable: NULL = "Unassigned" (Scout could not resolve the shop). No DEFAULT — orders
-- must be attributed per-shop by Scout, not silently forced to Blocked Off.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS shop_id uuid
    REFERENCES shops(id) ON DELETE SET NULL;
UPDATE orders SET shop_id = 'e653db17-f5da-4a1d-87ed-bae349a9bfa9' WHERE shop_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders(shop_id);
