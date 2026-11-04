-- =============================================================================
-- MIGRATION 0002 — Xoá mềm chuyến hàng
-- Chuyến từng có đơn mua (dù đã xoá mềm) không được xoá cứng: giữ lịch sử & nhật ký kiểm toán.
-- Chuyến chưa từng có đơn mua thì xoá hẳn được.
-- =============================================================================
ALTER TABLE batches ADD COLUMN deleted_at timestamptz;
CREATE INDEX batches_active_idx ON batches (created_at) WHERE deleted_at IS NULL;
