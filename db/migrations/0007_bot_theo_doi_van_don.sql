-- Bot theo dõi vận đơn (2 lần / ngày) + mốc "người bán tạo nhãn".
-- Bot chỉ ĐỌC dữ liệu hãng và báo — không tự đổi trạng thái kiện / máy (người dùng xác nhận trên kiện).

-- Hãng nào → nguồn dữ liệu nào (UPS, USPS, FEDEX, DHL). Trống = đoán theo dạng mã vận đơn.
ALTER TABLE carriers ADD COLUMN tracking_provider text CHECK (tracking_provider IN ('UPS', 'USPS', 'FEDEX', 'DHL'));
UPDATE carriers SET tracking_provider = 'UPS' WHERE tracking_provider IS NULL AND name ~* '^\s*ups\M';
UPDATE carriers SET tracking_provider = 'USPS' WHERE tracking_provider IS NULL AND name ~* '^\s*usps\M';
UPDATE carriers SET tracking_provider = 'FEDEX' WHERE tracking_provider IS NULL AND name ~* '^\s*fed\s*ex\M';
UPDATE carriers SET tracking_provider = 'DHL' WHERE tracking_provider IS NULL AND name ~* '^\s*dhl\M';

ALTER TABLE shipments
  ADD COLUMN label_created_at    timestamptz,                -- người bán tạo nhãn (trước khi gửi)
  ADD COLUMN track_enabled       boolean NOT NULL DEFAULT true,
  ADD COLUMN track_status        text CHECK (track_status IN ('LABEL_CREATED', 'IN_TRANSIT', 'DELAYED', 'OUT_FOR_DELIVERY', 'DELIVERED',
                                                              'EXCEPTION', 'NOT_FOUND', 'UNKNOWN')),
  ADD COLUMN track_status_text   text,
  ADD COLUMN track_eta           date,                       -- ngày giao hãng hẹn (theo nơi nhận)
  ADD COLUMN track_eta_window    text,
  ADD COLUMN track_last_event_at timestamptz,
  ADD COLUMN track_picked_up_at  timestamptz,
  ADD COLUMN track_delivered_at  timestamptz,
  ADD COLUMN track_checked_at    timestamptz,
  ADD COLUMN track_error         text,
  ADD CONSTRAINT shipments_label_before_ship CHECK (label_created_at IS NULL OR shipped_at IS NULL OR label_created_at <= shipped_at);

-- Sự kiện từ hãng: chống ghi trùng qua nhiều lần kiểm tra
ALTER TABLE shipment_tracking_events ADD COLUMN external_key text;
CREATE UNIQUE INDEX shipment_tracking_events_ext_uq ON shipment_tracking_events (shipment_id, external_key) WHERE external_key IS NOT NULL;

-- Kiện bot cần kiểm tra
CREATE INDEX shipments_track_idx ON shipments (track_checked_at NULLS FIRST)
  WHERE track_enabled AND tracking_number IS NOT NULL AND status IN ('PLANNED', 'IN_TRANSIT', 'HOLD');

-- Mỗi lần bot chạy
CREATE TABLE tracking_runs (
  id          bigserial PRIMARY KEY,
  trigger     text NOT NULL CHECK (trigger IN ('SCHEDULE', 'MANUAL', 'ADD')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  checked     int NOT NULL DEFAULT 0,
  changed     int NOT NULL DEFAULT 0,
  failed      int NOT NULL DEFAULT 0,
  note        text
);
CREATE INDEX tracking_runs_started_idx ON tracking_runs (started_at DESC);
