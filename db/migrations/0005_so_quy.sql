-- =============================================================================
-- MIGRATION 0005 — Sổ quỹ (Thu chi) + công nợ
-- • Bút toán TỰ SINH: mỗi đơn mua / chi phí / chi phí bán hàng đã trả (có tài khoản + ngày trả) có đúng MỘT
--   bút toán liên kết ngược về chứng từ gốc. Lớp dịch vụ đồng bộ trong cùng transaction với thao tác sửa;
--   chỉ mục duy nhất bên dưới chặn việc ghi trùng.
-- • Danh mục mới: hoàn phí vận chuyển (chi phí âm), điều chỉnh khi đối soát.
-- • Bảng đối soát: số dư thực tế (sao kê) so với số dư hệ thống tại một ngày.
-- • ledger_backfill(): ghi bổ sung bút toán còn thiếu cho dữ liệu nhập trước khi có sổ quỹ (chạy lại an toàn).
-- =============================================================================

INSERT INTO cash_categories (code, name, direction, is_operating, is_system) VALUES
  ('LANDED_COST_REFUND', 'Hoàn phí vận chuyển / thông quan', 'IN',  false, true),
  ('ADJUST_IN',          'Điều chỉnh đối soát (tăng)',       'IN',  false, true),
  ('ADJUST_OUT',         'Điều chỉnh đối soát (giảm)',       'OUT', false, true)
ON CONFLICT (code) DO NOTHING;

-- một chứng từ gốc ↔ tối đa một bút toán còn hiệu lực (đơn bán có nhiều lần thu nên không ràng buộc)
CREATE UNIQUE INDEX cash_transactions_po_uq           ON cash_transactions (purchase_order_id) WHERE purchase_order_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX cash_transactions_cost_uq         ON cash_transactions (cost_id)           WHERE cost_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX cash_transactions_sale_expense_uq ON cash_transactions (sale_expense_id)   WHERE sale_expense_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX cash_transactions_occurred_idx ON cash_transactions (occurred_at) WHERE deleted_at IS NULL;
CREATE INDEX cash_transactions_transfer_idx ON cash_transactions (transfer_group_id) WHERE transfer_group_id IS NOT NULL;

CREATE TABLE account_reconciliations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id),
  as_of              date NOT NULL,                     -- số dư cuối ngày (giờ Việt Nam)
  statement_balance  numeric(16,2) NOT NULL,            -- số dư trên sao kê / đếm thực tế
  system_balance     numeric(16,2) NOT NULL,            -- số dư hệ thống lúc đối soát
  adjustment_txn_id  uuid REFERENCES cash_transactions(id), -- bút toán điều chỉnh (nếu chọn ghi)
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_reconciliations_account_idx ON account_reconciliations (account_id, as_of DESC);

-- Số tiền theo tiền tệ của tài khoản: tài khoản VND → số VND; tài khoản USD → số USD của chứng từ USD.
-- Chứng từ VND trả từ tài khoản USD không quy đổi được → bỏ qua (lớp dịch vụ chặn từ lúc nhập).
CREATE OR REPLACE FUNCTION ledger_backfill() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer := 0; k integer;
BEGIN
  INSERT INTO cash_transactions (account_id, direction, amount, amount_vnd, occurred_at, category_code, purchase_order_id, counterparty)
  SELECT po.payment_account_id, 'OUT',
         CASE WHEN a.currency = 'VND' THEN po.total_vnd ELSE po.subtotal + po.sales_tax + po.seller_shipping - po.discount END,
         po.total_vnd, po.paid_at, 'PURCHASE', po.id, sp.name
    FROM purchase_orders po JOIN accounts a ON a.id = po.payment_account_id LEFT JOIN suppliers sp ON sp.id = po.supplier_id
   WHERE po.deleted_at IS NULL AND po.paid_at IS NOT NULL AND po.total_vnd > 0
     AND (a.currency = 'VND' OR po.currency = 'USD')
     AND (a.currency = 'VND' OR po.subtotal + po.sales_tax + po.seller_shipping - po.discount > 0)
     AND NOT EXISTS (SELECT 1 FROM cash_transactions t WHERE t.purchase_order_id = po.id AND t.deleted_at IS NULL);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  INSERT INTO cash_transactions (account_id, direction, amount, amount_vnd, occurred_at, category_code, cost_id, note)
  SELECT c.account_id, CASE WHEN c.amount_vnd > 0 THEN 'OUT' ELSE 'IN' END::txn_direction,
         CASE WHEN a.currency = 'VND' THEN abs(c.amount_vnd) ELSE abs(c.amount) END,
         abs(c.amount_vnd), c.paid_at, CASE WHEN c.amount_vnd > 0 THEN 'LANDED_COST' ELSE 'LANDED_COST_REFUND' END, c.id, c.description
    FROM costs c JOIN accounts a ON a.id = c.account_id
   WHERE c.deleted_at IS NULL AND c.paid_at IS NOT NULL AND c.amount_vnd <> 0
     AND (a.currency = 'VND' OR c.currency = 'USD')
     AND NOT EXISTS (SELECT 1 FROM cash_transactions t WHERE t.cost_id = c.id AND t.deleted_at IS NULL);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  INSERT INTO cash_transactions (account_id, direction, amount, amount_vnd, occurred_at, category_code, sale_expense_id)
  SELECT e.account_id, 'OUT', e.amount_vnd, e.amount_vnd, e.paid_at, 'SALE_EXPENSE', e.id
    FROM sale_expenses e JOIN accounts a ON a.id = e.account_id AND a.currency = 'VND'
   WHERE e.paid_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM cash_transactions t WHERE t.sale_expense_id = e.id AND t.deleted_at IS NULL);
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  RETURN n;
END $$;

SELECT ledger_backfill();
