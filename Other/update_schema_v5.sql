-- 1. Remove redundant columns
ALTER TABLE listing_variations DROP COLUMN IF EXISTS product_base_name;

-- 2. Enforce case-insensitive status CHECK constraints
-- overall_order_status: 'pending', 'printing', 'printed', 'completed', 'hold', 'on hold', 'cancelled', 'failed'
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_overall_order_status;
ALTER TABLE orders ADD CONSTRAINT chk_overall_order_status CHECK (LOWER(overall_order_status) IN ('pending', 'printing', 'printed', 'completed', 'hold', 'on hold', 'cancelled', 'failed'));

-- waybill_processing_status: 'pending', 'processing', 'ready', 'ready to print', 'printed', 'completed', 'failed'
ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_waybill_processing_status;
ALTER TABLE orders ADD CONSTRAINT chk_waybill_processing_status CHECK (LOWER(waybill_processing_status) IN ('pending', 'processing', 'ready', 'ready to print', 'printed', 'completed', 'failed'));

-- item_print_status: 'pending', 'printing', 'completed', 'failed', 'not_applicable'
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS chk_item_print_status;
ALTER TABLE order_items ADD CONSTRAINT chk_item_print_status CHECK (LOWER(item_print_status) IN ('pending', 'printing', 'completed', 'failed', 'not_applicable'));

-- job_execution_status: 'pending', 'printing', 'completed', 'failed'
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS chk_job_execution_status;
ALTER TABLE print_jobs ADD CONSTRAINT chk_job_execution_status CHECK (LOWER(job_execution_status) IN ('pending', 'printing', 'completed', 'failed'));

-- 3. Create performance indexes
CREATE INDEX IF NOT EXISTS idx_orders_overall_order_status ON orders(overall_order_status);
CREATE INDEX IF NOT EXISTS idx_print_files_simplyprint_id ON print_files(simplyprint_file_id) WHERE simplyprint_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_system_logs_level_created ON system_logs(log_level, created_at DESC);
