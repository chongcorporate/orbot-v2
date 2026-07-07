-- Schema v13: per-line revenue for analytics.
--
-- Scout's Gemini extraction already pulls OrderItem.item_subtotal from order
-- emails (main.py) but only used it for coverage verification, then discarded
-- it. Persist it so the Analytics tab can attribute revenue per SKU.
--
-- NOTE: on Shopee the extracted value may be a UNIT price ("RM x.xx xN")
-- rather than a line total — analytics must only ever use it as an
-- allocation WEIGHT within an order, never as an absolute amount.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS item_subtotal NUMERIC(10, 2);

COMMENT ON COLUMN order_items.item_subtotal IS
  'Line price extracted from the order email; NULL for pre-v13 rows or when any merged line lacked a price. May be a unit price rather than a line total - use as allocation weight only.';

-- Seed cost parameters for the Analytics tab so it has values on first load.
-- The frontend upserts this key from the "Costs" panel; ON CONFLICT DO NOTHING
-- keeps any values already saved.
INSERT INTO app_settings (key, value) VALUES ('cost_params',
  '{"filament_cost_per_gram":0.09,"machine_cost_per_hour":0.50,"labor_cost_per_item":0.50,"platform_fee_rate_shopee":0.12,"platform_fee_rate_lazada":0.12,"launch_flag_days":21,"printer_capacity_hours_per_day":0}')
ON CONFLICT (key) DO NOTHING;
