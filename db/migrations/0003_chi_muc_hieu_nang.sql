-- =============================================================================
-- MIGRATION 0003 — Chỉ mục cho các khoá ngoại hay tra cứu
-- Đo trên CSDL thử tải (3.000 máy, 2.500 đơn bán): thiếu chỉ mục sale_items(sale_id) làm truy vấn công nợ
-- của trang Tổng quan quét cả bảng cho từng đơn (≈ 430 ms). PostgreSQL không tự tạo chỉ mục cho khoá ngoại,
-- nên mọi khoá ngoại được tra cứu theo chiều "con của cha" đều cần chỉ mục riêng.
-- Bảng danh mục rất nhỏ (cash_categories, accounts…) không cần.
-- =============================================================================

-- Bán hàng: dòng của đơn, chi phí bán, khách
CREATE INDEX sale_items_sale_idx      ON sale_items (sale_id);
CREATE INDEX sale_expenses_sale_idx   ON sale_expenses (sale_id);
CREATE INDEX sales_customer_idx       ON sales (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX sales_status_idx         ON sales (status, sold_at);

-- Máy theo đơn mua / theo mẫu máy (lưới nhập máy, kiểm tra trước khi xoá mẫu)
CREATE INDEX items_purchase_order_idx ON items (purchase_order_id) WHERE deleted_at IS NULL;
CREATE INDEX items_variant_idx        ON items (variant_id);

-- Chi phí theo đối tượng gắn (chuyến / đơn mua / kiện / máy)
CREATE INDEX costs_batch_idx          ON costs (batch_id)          WHERE batch_id IS NOT NULL;
CREATE INDEX costs_purchase_order_idx ON costs (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX costs_shipment_idx       ON costs (shipment_id)       WHERE shipment_id IS NOT NULL;
CREATE INDEX costs_item_idx           ON costs (item_id)           WHERE item_id IS NOT NULL;
CREATE INDEX cost_manual_shares_item_idx ON cost_manual_shares (item_id);
CREATE INDEX item_cost_allocations_cost_idx ON item_cost_allocations (cost_id) WHERE cost_id IS NOT NULL;

-- Mốc của máy theo đơn bán / theo kiện (huỷ cọc, khách trả lại, gỡ máy khỏi kiện)
CREATE INDEX item_events_sale_idx     ON item_events (sale_id)     WHERE sale_id IS NOT NULL;
CREATE INDEX item_events_shipment_idx ON item_events (shipment_id) WHERE shipment_id IS NOT NULL;

-- Sổ thu chi theo chứng từ nguồn
CREATE INDEX cash_transactions_cost_idx ON cash_transactions (cost_id)           WHERE cost_id IS NOT NULL;
CREATE INDEX cash_transactions_po_idx   ON cash_transactions (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

-- Danh mục & vận chuyển
CREATE INDEX product_variants_model_idx ON product_variants (model_id);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);
CREATE INDEX shipments_batch_idx      ON shipments (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX scan_captures_item_idx   ON scan_captures (item_id) WHERE item_id IS NOT NULL;
