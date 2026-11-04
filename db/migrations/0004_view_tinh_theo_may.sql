-- =============================================================================
-- MIGRATION 0004 — View giá vốn & mốc tính theo từng máy (LATERAL) thay vì gom cả bảng
-- v_item_landed_cost / v_item_milestones cũ dùng GROUP BY trên toàn bảng: khi truy vấn khác nối vào theo
-- item_id (vd lãi của MỘT đơn bán), PostgreSQL vẫn phải gom giá vốn của MỌI máy rồi mới lọc — lặp lại cho
-- từng dòng. Viết lại bằng LATERAL: mỗi máy tự cộng các dòng của mình qua chỉ mục (item_id, …) đã có,
-- nên điều kiện item_id được đẩy xuống. Cùng tên cột, cùng kiểu, cùng ý nghĩa → các view phụ thuộc giữ nguyên.
-- Đo trên CSDL thử tải: danh sách Bán hàng 90 ms → vài ms.
-- =============================================================================

CREATE OR REPLACE VIEW v_item_landed_cost AS
SELECT
  i.id       AS item_id,
  i.batch_id,
  x.purchase_vnd,
  x.us_domestic_vnd,
  x.international_vnd,
  x.hn_sg_vnd,
  x.other_vnd,
  x.landed_cost_vnd,
  x.has_estimate
FROM items i
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN
             ('PRICE', 'SALES_TAX', 'SELLER_SHIPPING', 'DISCOUNT', 'PO_FX_FEE')), 0)::bigint AS purchase_vnd,
    COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component = 'US_DOMESTIC_SHIPPING'), 0)::bigint    AS us_domestic_vnd,
    COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN
             ('INTL_SHIPPING', 'INSURANCE', 'CUSTOMS_TAX')), 0)::bigint                     AS international_vnd,
    COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component = 'DOMESTIC_SHIPPING'), 0)::bigint    AS hn_sg_vnd,
    COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN
             ('FX_FEE', 'HANDLING', 'OTHER_LANDED')), 0)::bigint                            AS other_vnd,
    COALESCE(SUM(a.amount_vnd), 0)::bigint AS landed_cost_vnd,
    COALESCE(bool_or(a.is_estimate), false) AS has_estimate
  FROM item_cost_allocations a
  WHERE a.item_id = i.id
) x
WHERE i.deleted_at IS NULL;

-- Chỉ máy có ít nhất một mốc mới có dòng (GROUP BY trong LATERAL: không có mốc → không có dòng), như view cũ.
CREATE OR REPLACE VIEW v_item_milestones AS
SELECT
  i.id AS item_id,
  x.ordered_at,
  x.seller_shipped_at,
  x.us_warehouse_at,
  x.intl_departed_at,
  x.hn_arrived_at,
  x.domestic_departed_at,
  x.sg_received_at,
  x.sold_at,
  x.delivered_at
FROM items i
JOIN LATERAL (
  SELECT
    MIN(e.occurred_at) FILTER (WHERE e.event_type = 'ORDERED')               AS ordered_at,
    MIN(e.occurred_at) FILTER (WHERE e.event_type = 'SELLER_SHIPPED')        AS seller_shipped_at,
    MIN(e.occurred_at) FILTER (WHERE e.event_type = 'US_WAREHOUSE_RECEIVED') AS us_warehouse_at,
    MIN(e.occurred_at) FILTER (WHERE e.event_type = 'INTL_DEPARTED')         AS intl_departed_at,
    MIN(e.occurred_at) FILTER (WHERE e.event_type = 'HN_ARRIVED')            AS hn_arrived_at,
    MIN(e.occurred_at) FILTER (WHERE e.event_type = 'DOMESTIC_DEPARTED')     AS domestic_departed_at,
    MIN(e.occurred_at) FILTER (WHERE e.event_type = 'SG_RECEIVED')           AS sg_received_at,
    MAX(e.occurred_at) FILTER (WHERE e.event_type = 'SOLD')                  AS sold_at,
    MAX(e.occurred_at) FILTER (WHERE e.event_type = 'DELIVERED')             AS delivered_at
  FROM item_events e
  WHERE e.item_id = i.id
  GROUP BY e.item_id
) x ON true;
