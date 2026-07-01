-- v7: allow 'compiled' waybill_processing_status
-- Batch PDF compilation sets orders.waybill_processing_status = 'compiled'
-- (see main.py run_batch_compile), but the v5 constraint omitted it, causing
-- 23514 check-constraint violations on batch compile.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_waybill_processing_status;
ALTER TABLE orders ADD CONSTRAINT chk_waybill_processing_status
  CHECK (LOWER(waybill_processing_status) IN (
    'pending', 'processing', 'ready', 'ready to print',
    'printed', 'completed', 'failed', 'compiled'
  ));
