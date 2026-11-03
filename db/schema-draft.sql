-- =============================================================================
-- iPre — Hệ thống quản trị nhập hàng Apple (Mỹ → Việt Nam)
-- LƯỢC ĐỒ CƠ SỞ DỮ LIỆU — BẢN NHÁP THIẾT KẾ (PostgreSQL 16+)
--
-- Quy ước:
--   * Tiền VND lưu bằng BIGINT (đơn vị: đồng) — không bao giờ dùng số thực (float).
--   * Tiền ngoại tệ lưu NUMERIC(16,2) kèm cột currency; tỷ giá NUMERIC(12,4).
--   * Mọi mốc thời gian lưu TIMESTAMPTZ (UTC), hiển thị theo Asia/Ho_Chi_Minh.
--   * Không xoá cứng dữ liệu tài chính: dùng deleted_at (xoá mềm) + audit_logs.
--   * Giá vốn từng máy do "bộ máy tính giá vốn" (costing engine) ở tầng ứng dụng
--     tính và ghi vào item_cost_allocations — báo cáo chỉ việc cộng.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. KIỂU LIỆT KÊ (ENUM)
-- -----------------------------------------------------------------------------
CREATE TYPE currency_code     AS ENUM ('VND', 'USD');
CREATE TYPE product_category  AS ENUM ('IPHONE', 'IPAD', 'MAC', 'AIRPODS', 'WATCH', 'ACCESSORY', 'OTHER');
CREATE TYPE item_condition    AS ENUM ('NEW_SEALED', 'OPEN_BOX', 'LIKE_NEW', 'USED', 'REFURBISHED');

-- Trạng thái hiện tại của một máy (được suy ra từ item_events, lưu cache ở items.status)
CREATE TYPE item_status AS ENUM (
  'ORDERED',              -- Đã đặt mua
  'US_IN_TRANSIT',        -- Đang ship nội địa Mỹ
  'AT_US_WAREHOUSE',      -- Đã về kho Mỹ (forwarder)
  'INTL_IN_TRANSIT',      -- Đang vận chuyển Mỹ → VN
  'AT_HN',                -- Đã về Hà Nội
  'DOMESTIC_IN_TRANSIT',  -- Đang chuyển HN → SG
  'IN_STOCK',             -- Tồn kho tại SG, sẵn sàng bán
  'RESERVED',             -- Khách đã cọc (kể cả đặt trước khi máy về)
  'SOLD',                 -- Đã bán
  'RETURNED_TO_SELLER',   -- Trả lại người bán ở Mỹ
  'WARRANTY',             -- Đang bảo hành
  'LOST',                 -- Thất lạc
  'DAMAGED',              -- Hư hỏng / lỗi không bán được
  'PERSONAL_USE'          -- Rút ra dùng cá nhân / tặng
);

CREATE TYPE item_event_type AS ENUM (
  'ORDERED', 'SELLER_SHIPPED', 'US_WAREHOUSE_RECEIVED', 'INTL_DEPARTED',
  'HN_ARRIVED', 'CUSTOMS_CLEARED', 'DOMESTIC_DEPARTED', 'SG_RECEIVED',
  'LISTED', 'RESERVED', 'SOLD', 'DELIVERED', 'RETURNED_BY_CUSTOMER',
  'RETURNED_TO_SELLER', 'WARRANTY_IN', 'WARRANTY_OUT', 'LOST', 'DAMAGED',
  'PERSONAL_USE', 'NOTE'
);

CREATE TYPE leg_type          AS ENUM ('US_DOMESTIC', 'US_TO_VN', 'HN_TO_SG', 'SG_LOCAL', 'OTHER');
CREATE TYPE leg_status        AS ENUM ('PLANNED', 'IN_TRANSIT', 'ARRIVED', 'HOLD', 'LOST', 'CANCELLED');
CREATE TYPE allocation_method AS ENUM ('BY_QUANTITY', 'BY_VALUE', 'BY_WEIGHT', 'MANUAL');
CREATE TYPE batch_status      AS ENUM ('DRAFT', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED', 'COSTS_FINALIZED', 'CLOSED');

CREATE TYPE cost_kind AS ENUM (
  'US_DOMESTIC_SHIPPING',  -- Phí ship nội địa Mỹ (ngoài phí người bán đã thu trong đơn)
  'INTL_SHIPPING',         -- Cước Mỹ → VN
  'DOMESTIC_SHIPPING',     -- Cước HN → SG
  'INSURANCE',             -- Bảo hiểm hàng hoá / phụ thu hàng giá trị cao
  'CUSTOMS_TAX',           -- Thuế, phí thông quan (nếu có)
  'FX_FEE',                -- Phí chuyển đổi ngoại tệ / phí chuyển tiền phát sinh riêng
  'HANDLING',              -- Phí kiểm hàng, đóng gói, lưu kho
  'OTHER_LANDED'           -- Chi phí khác cấu thành giá vốn
);

CREATE TYPE txn_direction AS ENUM ('IN', 'OUT');
CREATE TYPE sale_status   AS ENUM ('DEPOSITED', 'COMPLETED', 'CANCELLED');

-- -----------------------------------------------------------------------------
-- 1. DANH MỤC
-- -----------------------------------------------------------------------------
CREATE TABLE product_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    product_category NOT NULL,
  name        text NOT NULL,                       -- vd: 'iPhone 17 Pro Max'
  release_year smallint,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, name)
);

CREATE TABLE product_variants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id          uuid NOT NULL REFERENCES product_models(id),
  sku               text NOT NULL UNIQUE,          -- mã nội bộ, vd: IP17PM-256-SLV
  apple_part_number text,                          -- vd: MXXX3LL/A
  storage           text,                          -- '256GB', '1TB'
  color             text,
  chip              text,                          -- Mac: 'M4 Pro'
  memory            text,                          -- Mac: '24GB'
  connectivity      text,                          -- 'Wi-Fi', 'Cellular', 'eSIM only'
  default_weight_kg numeric(6,3) CHECK (default_weight_kg > 0),  -- dùng phân bổ cước theo cân nặng
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (                           -- Nơi mua hàng tại Mỹ
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,                -- Apple Store, Best Buy, Costco, Amazon, eBay…
  kind        text NOT NULL DEFAULT 'RETAILER'
              CHECK (kind IN ('RETAILER', 'MARKETPLACE', 'INDIVIDUAL', 'OTHER')),
  us_state    char(2),                             -- bang (ảnh hưởng sales tax)
  return_days smallint,                            -- số ngày đổi trả mặc định
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE carriers (                            -- Đơn vị vận chuyển / forwarder
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL UNIQUE,
  leg_types             leg_type[] NOT NULL,       -- các chặng mà đơn vị này phục vụ
  tracking_url_template text,                      -- vd: https://…/track?no={tracking}
  default_lead_days     smallint,                  -- thời gian giao dự kiến (để tự tính ETA)
  contact               text,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE accounts (                            -- Tài khoản tiền: tiền mặt, ngân hàng, thẻ…
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  currency        currency_code NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('CASH', 'BANK', 'CARD', 'EWALLET', 'OTHER')),
  opening_balance numeric(16,2) NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_categories (                     -- Danh mục thu chi
  code         text PRIMARY KEY,                   -- 'PURCHASE', 'SALE_RECEIPT', 'OPEX_ADS'…
  name         text NOT NULL,
  direction    txn_direction NOT NULL,
  is_operating boolean NOT NULL DEFAULT false,     -- true = chi phí vận hành chung (trừ vào lãi ròng)
  is_system    boolean NOT NULL DEFAULT false      -- do hệ thống tự sinh, không cho xoá
);

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL,
  phone       text,
  zalo        text,
  facebook    text,
  address     text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX customers_phone_idx ON customers (phone);

CREATE TABLE exchange_rates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_date  date NOT NULL,
  base       currency_code NOT NULL DEFAULT 'USD',
  quote      currency_code NOT NULL DEFAULT 'VND',
  rate       numeric(12,4) NOT NULL CHECK (rate > 0),
  source     text NOT NULL,                        -- 'BANK_SELL', 'MANUAL', 'CARD_STATEMENT'…
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rate_date, base, quote, source)
);

-- -----------------------------------------------------------------------------
-- 2. CHUYẾN HÀNG — ĐƠN MUA — MÁY
-- -----------------------------------------------------------------------------
CREATE TABLE batches (                             -- Chuyến hàng (lô)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,         -- CH-2026-011
  name               text,
  status             batch_status NOT NULL DEFAULT 'DRAFT',
  planned_fx_rate    numeric(12,4) CHECK (planned_fx_rate > 0),
  costs_finalized_at timestamptz,                  -- thời điểm chốt chi phí → lãi lỗ "chốt"
  closed_at          timestamptz,                  -- bán hết, quyết toán
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (                     -- Đơn mua tại Mỹ
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL REFERENCES batches(id),
  supplier_id        uuid NOT NULL REFERENCES suppliers(id),
  order_number       text,                         -- mã đơn của người bán
  ordered_at         timestamptz NOT NULL,
  currency           currency_code NOT NULL DEFAULT 'USD',
  subtotal           numeric(14,2) NOT NULL CHECK (subtotal >= 0),      -- để đối soát với Σ đơn giá máy
  sales_tax          numeric(14,2) NOT NULL DEFAULT 0 CHECK (sales_tax >= 0),
  seller_shipping    numeric(14,2) NOT NULL DEFAULT 0 CHECK (seller_shipping >= 0),
  discount           numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0), -- coupon, gift card, cashback
  fx_rate            numeric(12,4) NOT NULL CHECK (fx_rate > 0),        -- tỷ giá THỰC TẾ đã trả
  fx_fee_vnd         bigint NOT NULL DEFAULT 0 CHECK (fx_fee_vnd >= 0), -- phí chuyển đổi ngoại tệ của ngân hàng
  total_vnd          bigint GENERATED ALWAYS AS (
                       round((subtotal + sales_tax + seller_shipping - discount) * fx_rate)::bigint + fx_fee_vnd
                     ) STORED,
  payment_account_id uuid REFERENCES accounts(id),
  paid_at            timestamptz,
  return_deadline    date,                         -- hạn đổi trả với người bán
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX purchase_orders_batch_idx ON purchase_orders (batch_id);

CREATE TABLE items (                               -- Từng máy (đơn vị hàng hoá có serial/IMEI)
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES batches(id),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id),
  variant_id        uuid NOT NULL REFERENCES product_variants(id),
  serial_number     text,                          -- có thể chưa biết lúc đặt, cập nhật khi nhận máy
  imei1             text,
  imei2             text,
  condition         item_condition NOT NULL DEFAULT 'NEW_SEALED',
  unit_price        numeric(14,2) NOT NULL CHECK (unit_price >= 0),     -- theo tiền tệ của đơn mua
  weight_kg         numeric(6,3) CHECK (weight_kg > 0),                 -- trống = lấy default của variant
  status            item_status NOT NULL DEFAULT 'ORDERED',             -- cache, suy ra từ item_events
  target_price_vnd  bigint CHECK (target_price_vnd >= 0),               -- giá bán mục tiêu
  market_price_vnd  bigint CHECK (market_price_vnd >= 0),               -- giá thị trường tham khảo
  icloud_checked    boolean NOT NULL DEFAULT false,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX items_serial_uq ON items (serial_number) WHERE serial_number IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX items_imei1_uq  ON items (imei1)         WHERE imei1 IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX items_batch_idx  ON items (batch_id);
CREATE INDEX items_status_idx ON items (status) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 3. VẬN CHUYỂN (CHẶNG) & MỐC THỜI GIAN
-- -----------------------------------------------------------------------------
CREATE TABLE shipments (                           -- Một kiện / một chặng vận chuyển
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid REFERENCES batches(id),  -- để trống nếu kiện gom máy của nhiều chuyến
  leg_type             leg_type NOT NULL,
  carrier_id           uuid REFERENCES carriers(id),
  tracking_number      text,
  reference_code       text,                       -- mã bill/AWB/mã khách của forwarder
  status               leg_status NOT NULL DEFAULT 'PLANNED',
  shipped_at           timestamptz,                -- ngày gửi đi
  eta                  date,                       -- ngày dự kiến nhận
  arrived_at           timestamptz,                -- ngày nhận thực tế
  chargeable_weight_kg numeric(8,3) CHECK (chargeable_weight_kg > 0),
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, leg_type),                           -- phục vụ khoá ngoại tổ hợp bên dưới
  CHECK (arrived_at IS NULL OR shipped_at IS NULL OR arrived_at >= shipped_at)
);
CREATE INDEX shipments_status_idx ON shipments (status, eta);

CREATE TABLE shipment_items (                      -- Máy nào nằm trong kiện nào
  shipment_id      uuid NOT NULL,
  leg_type         leg_type NOT NULL,
  item_id          uuid NOT NULL REFERENCES items(id),
  PRIMARY KEY (shipment_id, item_id),
  FOREIGN KEY (shipment_id, leg_type) REFERENCES shipments(id, leg_type) ON DELETE CASCADE,
  UNIQUE (item_id, leg_type)                       -- mỗi máy chỉ thuộc 1 kiện trên mỗi chặng
);

CREATE TABLE shipment_tracking_events (            -- Nhật ký tracking (nhập tay hoặc đồng bộ API)
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  location    text,
  description text NOT NULL,
  source      text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'API')),
  raw         jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_tracking_events_idx ON shipment_tracking_events (shipment_id, occurred_at);

CREATE TABLE item_events (                         -- Dòng thời gian của từng máy (nguồn sự thật về mốc)
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id),
  event_type  item_event_type NOT NULL,
  occurred_at timestamptz NOT NULL,
  shipment_id uuid REFERENCES shipments(id),
  sale_id     uuid,                                -- FK thêm sau khi tạo bảng sales
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_events_item_idx ON item_events (item_id, occurred_at);

-- -----------------------------------------------------------------------------
-- 4. CHI PHÍ & PHÂN BỔ GIÁ VỐN
-- -----------------------------------------------------------------------------
CREATE TABLE costs (                               -- Mọi chi phí cấu thành giá vốn (ngoài giá mua)
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              cost_kind NOT NULL,
  -- gắn vào ĐÚNG MỘT đối tượng; phân bổ cho các máy thuộc đối tượng đó
  batch_id          uuid REFERENCES batches(id),
  purchase_order_id uuid REFERENCES purchase_orders(id),
  shipment_id       uuid REFERENCES shipments(id),
  item_id           uuid REFERENCES items(id),
  description       text,
  currency          currency_code NOT NULL DEFAULT 'VND',
  amount            numeric(16,2) NOT NULL CHECK (amount <> 0),   -- âm = hoàn phí / điều chỉnh giảm
  fx_rate           numeric(12,4) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  amount_vnd        bigint GENERATED ALWAYS AS (round(amount * fx_rate)::bigint) STORED,
  allocation_method allocation_method NOT NULL DEFAULT 'BY_VALUE',
  is_estimate       boolean NOT NULL DEFAULT false, -- dự toán (chưa có hoá đơn) / thực tế
  has_valid_invoice boolean NOT NULL DEFAULT false, -- có chứng từ hợp lệ (phục vụ khai thuế theo thu nhập)
  incurred_at       date NOT NULL,
  account_id        uuid REFERENCES accounts(id),
  paid_at           timestamptz,                    -- NULL = chưa trả (công nợ phải trả)
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (num_nonnulls(batch_id, purchase_order_id, shipment_id, item_id) = 1),
  CHECK (currency <> 'VND' OR fx_rate = 1)
);

CREATE TABLE cost_manual_shares (                  -- Tỷ lệ/số tiền khi allocation_method = MANUAL
  cost_id    uuid NOT NULL REFERENCES costs(id) ON DELETE CASCADE,
  item_id    uuid NOT NULL REFERENCES items(id),
  amount_vnd bigint NOT NULL,
  PRIMARY KEY (cost_id, item_id)
);

-- Kết quả của costing engine: mỗi dòng = 1 thành phần giá vốn của 1 máy.
-- Engine xoá & ghi lại toàn bộ dòng của các máy bị ảnh hưởng trong CÙNG transaction.
CREATE TABLE item_cost_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  component   text NOT NULL CHECK (component IN (
                'PRICE', 'SALES_TAX', 'SELLER_SHIPPING', 'DISCOUNT', 'PO_FX_FEE',  -- từ đơn mua
                'US_DOMESTIC_SHIPPING', 'INTL_SHIPPING', 'DOMESTIC_SHIPPING',       -- từ bảng costs
                'INSURANCE', 'CUSTOMS_TAX', 'FX_FEE', 'HANDLING', 'OTHER_LANDED')),
  cost_id     uuid REFERENCES costs(id) ON DELETE CASCADE,  -- NULL với thành phần từ đơn mua
  amount_vnd  bigint NOT NULL,                              -- DISCOUNT mang giá trị âm
  is_estimate boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX item_cost_allocations_uq
  ON item_cost_allocations (item_id, component, COALESCE(cost_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- -----------------------------------------------------------------------------
-- 5. BÁN HÀNG
-- -----------------------------------------------------------------------------
CREATE TABLE sales (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,               -- BH-2026-0001
  customer_id  uuid REFERENCES customers(id),
  channel      text NOT NULL DEFAULT 'OTHER'
               CHECK (channel IN ('FACEBOOK', 'ZALO', 'TIKTOK', 'SHOPEE', 'WALK_IN', 'REFERRAL', 'OTHER')),
  status       sale_status NOT NULL DEFAULT 'COMPLETED',
  sold_at      timestamptz NOT NULL,               -- thời điểm ghi nhận doanh thu
  delivered_at timestamptz,
  discount_vnd bigint NOT NULL DEFAULT 0 CHECK (discount_vnd >= 0),   -- giảm giá trên tổng đơn
  einvoice_no  text,                               -- số hoá đơn điện tử đã xuất (nếu có)
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_sold_at_idx ON sales (sold_at);

ALTER TABLE item_events
  ADD CONSTRAINT item_events_sale_fk FOREIGN KEY (sale_id) REFERENCES sales(id);

CREATE TABLE sale_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id            uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_id            uuid NOT NULL REFERENCES items(id),
  price_vnd          bigint NOT NULL CHECK (price_vnd >= 0),
  discount_alloc_vnd bigint NOT NULL DEFAULT 0,   -- phần giảm giá đơn phân bổ cho máy (engine tính)
  expense_alloc_vnd  bigint NOT NULL DEFAULT 0,   -- phần chi phí bán hàng phân bổ cho máy (engine tính)
  cost_snapshot_vnd  bigint,                       -- giá vốn tại thời điểm bán (để so sánh khi chốt)
  warranty_until     date,                         -- bảo hành của shop
  voided_at          timestamptz,                  -- huỷ bán / khách trả lại
  void_reason        text
);
CREATE UNIQUE INDEX sale_items_active_uq ON sale_items (item_id) WHERE voided_at IS NULL;

CREATE TABLE sale_expenses (                       -- Chi phí bán hàng (không vào giá vốn)
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id    uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('SHIPPING_TO_CUSTOMER', 'PLATFORM_FEE', 'COD_FEE', 'GIFT', 'OTHER')),
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0),
  account_id uuid REFERENCES accounts(id),
  paid_at    timestamptz,
  note       text
);

-- -----------------------------------------------------------------------------
-- 6. SỔ THU CHI (đa tài khoản, ghi sổ đơn — đủ cho hộ kinh doanh)
-- -----------------------------------------------------------------------------
CREATE TABLE cash_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id),
  direction         txn_direction NOT NULL,
  amount            numeric(16,2) NOT NULL CHECK (amount > 0),  -- theo tiền tệ của tài khoản
  amount_vnd        bigint NOT NULL CHECK (amount_vnd > 0),     -- quy đổi để báo cáo
  occurred_at       timestamptz NOT NULL,
  category_code     text NOT NULL REFERENCES cash_categories(code),
  -- liên kết chứng từ nguồn (tối đa một)
  purchase_order_id uuid REFERENCES purchase_orders(id),
  cost_id           uuid REFERENCES costs(id),
  sale_id           uuid REFERENCES sales(id),
  sale_expense_id   uuid REFERENCES sale_expenses(id),
  transfer_group_id uuid,                          -- 2 bút toán của một lần chuyển tiền / đổi ngoại tệ
  counterparty      text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (num_nonnulls(purchase_order_id, cost_id, sale_id, sale_expense_id) <= 1)
);
CREATE INDEX cash_transactions_account_idx ON cash_transactions (account_id, occurred_at);
CREATE INDEX cash_transactions_sale_idx    ON cash_transactions (sale_id) WHERE sale_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 7. CHỨNG TỪ, NHẬT KÝ, CẤU HÌNH
-- -----------------------------------------------------------------------------
CREATE TABLE attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN
                ('BATCH', 'PURCHASE_ORDER', 'ITEM', 'SHIPMENT', 'COST', 'SALE', 'CASH_TRANSACTION')),
  entity_id   uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('INVOICE', 'RECEIPT', 'AWB', 'CUSTOMS', 'PHOTO', 'OTHER')),
  file_key    text NOT NULL,                       -- khoá object trên S3/R2
  file_name   text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  sha256      text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'RESTORE', 'FINALIZE', 'REOPEN', 'LOGIN')),
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at);

CREATE TABLE app_settings (
  key        text PRIMARY KEY,                     -- 'alert.aging_days', 'tax.revenue_threshold_vnd'…
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 8. VIEW BÁO CÁO
-- -----------------------------------------------------------------------------

-- 8.1 Giá vốn về tay của từng máy, tách theo nhóm chi phí
CREATE VIEW v_item_landed_cost AS
SELECT
  i.id       AS item_id,
  i.batch_id,
  COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN
           ('PRICE', 'SALES_TAX', 'SELLER_SHIPPING', 'DISCOUNT', 'PO_FX_FEE')), 0)::bigint AS purchase_vnd,
  COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component = 'US_DOMESTIC_SHIPPING'), 0)::bigint AS us_domestic_vnd,
  COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN
           ('INTL_SHIPPING', 'INSURANCE', 'CUSTOMS_TAX')), 0)::bigint                     AS international_vnd,
  COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component = 'DOMESTIC_SHIPPING'), 0)::bigint    AS hn_sg_vnd,
  COALESCE(SUM(a.amount_vnd) FILTER (WHERE a.component IN
           ('FX_FEE', 'HANDLING', 'OTHER_LANDED')), 0)::bigint                            AS other_vnd,
  COALESCE(SUM(a.amount_vnd), 0)::bigint AS landed_cost_vnd,
  COALESCE(bool_or(a.is_estimate), false) AS has_estimate
FROM items i
LEFT JOIN item_cost_allocations a ON a.item_id = i.id
WHERE i.deleted_at IS NULL
GROUP BY i.id, i.batch_id;

-- 8.2 Các mốc thời gian của từng máy (pivot từ item_events)
CREATE VIEW v_item_milestones AS
SELECT
  item_id,
  MIN(occurred_at) FILTER (WHERE event_type = 'ORDERED')               AS ordered_at,
  MIN(occurred_at) FILTER (WHERE event_type = 'SELLER_SHIPPED')        AS seller_shipped_at,
  MIN(occurred_at) FILTER (WHERE event_type = 'US_WAREHOUSE_RECEIVED') AS us_warehouse_at,
  MIN(occurred_at) FILTER (WHERE event_type = 'INTL_DEPARTED')         AS intl_departed_at,
  MIN(occurred_at) FILTER (WHERE event_type = 'HN_ARRIVED')            AS hn_arrived_at,
  MIN(occurred_at) FILTER (WHERE event_type = 'DOMESTIC_DEPARTED')     AS domestic_departed_at,
  MIN(occurred_at) FILTER (WHERE event_type = 'SG_RECEIVED')           AS sg_received_at,
  MAX(occurred_at) FILTER (WHERE event_type = 'SOLD')                  AS sold_at,
  MAX(occurred_at) FILTER (WHERE event_type = 'DELIVERED')             AS delivered_at
FROM item_events
GROUP BY item_id;

-- 8.3 Thời gian từng chặng (ngày) — phục vụ theo dõi tiến độ & so sánh đơn vị vận chuyển
CREATE VIEW v_item_lead_times AS
SELECT
  m.item_id,
  EXTRACT(EPOCH FROM (m.us_warehouse_at      - m.seller_shipped_at))    / 86400 AS us_domestic_days,
  EXTRACT(EPOCH FROM (m.intl_departed_at     - m.us_warehouse_at))      / 86400 AS wait_us_warehouse_days,
  EXTRACT(EPOCH FROM (m.hn_arrived_at        - m.intl_departed_at))     / 86400 AS international_days,
  EXTRACT(EPOCH FROM (m.domestic_departed_at - m.hn_arrived_at))        / 86400 AS wait_hn_days,
  EXTRACT(EPOCH FROM (m.sg_received_at       - m.domestic_departed_at)) / 86400 AS hn_sg_days,
  EXTRACT(EPOCH FROM (m.sg_received_at       - m.ordered_at))           / 86400 AS order_to_stock_days,
  EXTRACT(EPOCH FROM (COALESCE(m.sold_at, now()) - m.sg_received_at))   / 86400 AS days_in_stock,
  EXTRACT(EPOCH FROM (m.sold_at              - m.ordered_at))           / 86400 AS order_to_sale_days
FROM v_item_milestones m;

-- 8.4 Lãi lỗ từng máy đã bán
CREATE VIEW v_sale_item_profit AS
SELECT
  si.id        AS sale_item_id,
  s.id         AS sale_id,
  s.code       AS sale_code,
  s.sold_at,
  s.channel,
  i.id         AS item_id,
  i.batch_id,
  pm.category,
  si.price_vnd - si.discount_alloc_vnd                                   AS net_revenue_vnd,
  lc.landed_cost_vnd                                                      AS cogs_vnd,
  si.price_vnd - si.discount_alloc_vnd - lc.landed_cost_vnd               AS gross_profit_vnd,
  si.expense_alloc_vnd                                                    AS selling_expense_vnd,
  si.price_vnd - si.discount_alloc_vnd - lc.landed_cost_vnd - si.expense_alloc_vnd AS profit_vnd,
  -- "Chốt" khi chuyến đã chốt chi phí và không còn dòng dự toán; ngược lại là "Tạm tính"
  (b.costs_finalized_at IS NOT NULL AND NOT lc.has_estimate)              AS is_final
FROM sale_items si
JOIN sales s              ON s.id = si.sale_id AND s.status = 'COMPLETED'
JOIN items i              ON i.id = si.item_id
JOIN product_variants pv  ON pv.id = i.variant_id
JOIN product_models pm    ON pm.id = pv.model_id
JOIN batches b            ON b.id = i.batch_id
JOIN v_item_landed_cost lc ON lc.item_id = i.id
WHERE si.voided_at IS NULL;

-- 8.5 Tổng hợp theo chuyến hàng
CREATE VIEW v_batch_summary AS
SELECT
  b.id AS batch_id,
  b.code,
  b.status,
  COUNT(i.id)                                                AS item_count,
  COUNT(p.sale_item_id)                                      AS sold_count,
  COALESCE(SUM(lc.landed_cost_vnd), 0)::bigint               AS total_landed_cost_vnd,
  COALESCE(SUM(p.net_revenue_vnd), 0)::bigint                AS revenue_vnd,
  COALESCE(SUM(p.cogs_vnd), 0)::bigint                       AS cogs_sold_vnd,
  COALESCE(SUM(p.profit_vnd), 0)::bigint                     AS realized_profit_vnd,
  COALESCE(SUM(lc.landed_cost_vnd) FILTER (WHERE p.sale_item_id IS NULL), 0)::bigint AS unsold_cost_vnd,
  CASE WHEN SUM(p.cogs_vnd) > 0
       THEN ROUND(100.0 * SUM(p.profit_vnd) / SUM(p.cogs_vnd), 2) END AS roi_on_sold_pct
FROM batches b
LEFT JOIN items i               ON i.batch_id = b.id AND i.deleted_at IS NULL
LEFT JOIN v_item_landed_cost lc ON lc.item_id = i.id
LEFT JOIN v_sale_item_profit p  ON p.item_id = i.id
GROUP BY b.id, b.code, b.status;

-- 8.6 Tồn kho & tuổi tồn (máy đã về SG, chưa bán)
CREATE VIEW v_inventory_aging AS
SELECT
  i.id AS item_id,
  i.batch_id,
  i.status,
  pm.category,
  pm.name AS model_name,
  pv.storage,
  pv.color,
  i.serial_number,
  lc.landed_cost_vnd,
  i.target_price_vnd,
  i.market_price_vnd,
  m.sg_received_at,
  FLOOR(EXTRACT(EPOCH FROM (now() - m.sg_received_at)) / 86400)::int AS days_in_stock,
  CASE
    WHEN now() - m.sg_received_at <= interval '15 days' THEN '0-15'
    WHEN now() - m.sg_received_at <= interval '30 days' THEN '16-30'
    WHEN now() - m.sg_received_at <= interval '60 days' THEN '31-60'
    ELSE '>60'
  END AS aging_bucket
FROM items i
JOIN product_variants pv   ON pv.id = i.variant_id
JOIN product_models pm     ON pm.id = pv.model_id
JOIN v_item_landed_cost lc ON lc.item_id = i.id
JOIN v_item_milestones m   ON m.item_id = i.id
WHERE i.deleted_at IS NULL
  AND i.status IN ('IN_STOCK', 'RESERVED');

-- 8.7 Vốn đang nằm ở đâu (theo trạng thái) — widget chính của Dashboard
CREATE VIEW v_capital_by_stage AS
SELECT
  i.status,
  COUNT(*)                              AS item_count,
  SUM(lc.landed_cost_vnd)::bigint       AS capital_vnd
FROM items i
JOIN v_item_landed_cost lc ON lc.item_id = i.id
WHERE i.deleted_at IS NULL
  AND i.status IN ('ORDERED', 'US_IN_TRANSIT', 'AT_US_WAREHOUSE', 'INTL_IN_TRANSIT',
                   'AT_HN', 'DOMESTIC_IN_TRANSIT', 'IN_STOCK', 'RESERVED', 'WARRANTY')
GROUP BY i.status;

-- 8.8 Lãi lỗ theo tháng (giờ Việt Nam)
CREATE VIEW v_monthly_pnl AS
WITH sales_m AS (
  SELECT date_trunc('month', sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS month,
         SUM(net_revenue_vnd)     AS revenue_vnd,
         SUM(cogs_vnd)            AS cogs_vnd,
         SUM(gross_profit_vnd)    AS gross_profit_vnd,
         SUM(selling_expense_vnd) AS selling_expense_vnd,
         SUM(profit_vnd)          AS profit_after_selling_vnd,
         COUNT(*)                 AS units_sold
  FROM v_sale_item_profit
  GROUP BY 1
),
opex_m AS (
  SELECT date_trunc('month', ct.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS month,
         SUM(CASE WHEN ct.direction = 'OUT' THEN ct.amount_vnd ELSE -ct.amount_vnd END) AS opex_vnd
  FROM cash_transactions ct
  JOIN cash_categories cc ON cc.code = ct.category_code AND cc.is_operating
  WHERE ct.deleted_at IS NULL
  GROUP BY 1
)
SELECT
  COALESCE(s.month, o.month)                     AS month,
  COALESCE(s.units_sold, 0)                      AS units_sold,
  COALESCE(s.revenue_vnd, 0)::bigint             AS revenue_vnd,
  COALESCE(s.cogs_vnd, 0)::bigint                AS cogs_vnd,
  COALESCE(s.gross_profit_vnd, 0)::bigint        AS gross_profit_vnd,
  COALESCE(s.selling_expense_vnd, 0)::bigint     AS selling_expense_vnd,
  COALESCE(o.opex_vnd, 0)::bigint                AS opex_vnd,
  (COALESCE(s.profit_after_selling_vnd, 0) - COALESCE(o.opex_vnd, 0))::bigint AS net_profit_before_tax_vnd
FROM sales_m s
FULL JOIN opex_m o ON o.month = s.month;

-- 8.9 Doanh thu luỹ kế theo năm — phục vụ theo dõi ngưỡng thuế hộ kinh doanh
CREATE VIEW v_yearly_revenue AS
SELECT
  EXTRACT(YEAR FROM s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS year,
  SUM(si.price_vnd - si.discount_alloc_vnd)::bigint                 AS revenue_vnd,
  COUNT(*)                                                          AS units_sold
FROM sales s
JOIN sale_items si ON si.sale_id = s.id AND si.voided_at IS NULL
WHERE s.status = 'COMPLETED'
GROUP BY 1;

-- -----------------------------------------------------------------------------
-- 9. DỮ LIỆU KHỞI TẠO
-- -----------------------------------------------------------------------------
INSERT INTO cash_categories (code, name, direction, is_operating, is_system) VALUES
  ('PURCHASE',        'Thanh toán đơn mua tại Mỹ',          'OUT', false, true),
  ('LANDED_COST',     'Chi phí vận chuyển / thông quan',    'OUT', false, true),
  ('SALE_DEPOSIT',    'Khách đặt cọc',                       'IN',  false, true),
  ('SALE_RECEIPT',    'Khách thanh toán',                    'IN',  false, true),
  ('SALE_REFUND',     'Hoàn tiền cho khách',                 'OUT', false, true),
  ('SALE_EXPENSE',    'Chi phí bán hàng',                    'OUT', false, true),
  ('SELLER_REFUND',   'Người bán Mỹ hoàn tiền',              'IN',  false, true),
  ('CAPITAL_IN',      'Góp vốn / bổ sung vốn',               'IN',  false, true),
  ('CAPITAL_OUT',     'Rút vốn / rút lãi',                   'OUT', false, true),
  ('TRANSFER_IN',     'Chuyển tiền vào (nội bộ)',            'IN',  false, true),
  ('TRANSFER_OUT',    'Chuyển tiền ra (nội bộ)',             'OUT', false, true),
  ('TAX',             'Nộp thuế',                            'OUT', true,  true),
  ('OPEX_ADS',        'Quảng cáo',                           'OUT', true,  false),
  ('OPEX_TELECOM',    'Điện thoại, internet, phần mềm',      'OUT', true,  false),
  ('OPEX_RENT',       'Mặt bằng, kho',                       'OUT', true,  false),
  ('OPEX_OTHER',      'Chi phí vận hành khác',               'OUT', true,  false),
  ('OTHER_IN',        'Thu khác',                            'IN',  false, false);

INSERT INTO app_settings (key, value) VALUES
  ('alert.aging_days',            '30'),
  ('alert.eta_grace_days',        '2'),
  ('alert.return_deadline_days',  '3'),
  ('tax.revenue_threshold_vnd',   '1000000000'),
  ('tax.threshold_warning_ratio', '0.8'),
  ('allocation.default.US_DOMESTIC', '"BY_QUANTITY"'),
  ('allocation.default.US_TO_VN',    '"BY_WEIGHT"'),
  ('allocation.default.HN_TO_SG',    '"BY_QUANTITY"');

COMMIT;
