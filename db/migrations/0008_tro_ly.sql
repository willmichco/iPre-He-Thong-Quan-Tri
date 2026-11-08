-- Trợ lý nhập liệu bằng chat (/tro-ly) + Bảng kê nháp.
-- Nguyên tắc: bot KHÔNG tự ghi — mỗi thao tác ghi là một "phiếu" (chat_actions) chờ người dùng bấm Xác nhận; khi xác nhận,
-- phiếu gọi đúng dịch vụ của form tay (cùng kiểm tra, cùng nhật ký). Tin nhắn có thể chứa tên / SĐT khách → để ở bảng riêng,
-- xoá được, làm sạch được khi ẩn danh hoá khách (Luật 91/2025/QH15); KHÔNG chép vào audit_logs (chỉ thêm, không sửa được).

CREATE TABLE chat_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     text NOT NULL DEFAULT 'WEB' CHECK (channel IN ('WEB', 'TELEGRAM', 'ZALO')),
  external_id text NOT NULL,                       -- WEB: 'owner' · kênh khác: mã cuộc trò chuyện của kênh
  -- phiếu đang chờ xác nhận / câu hỏi bot đang chờ trả lời
  state       jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);

-- CHỨA DỮ LIỆU CÁ NHÂN: xoá theo hạn lưu, làm sạch khi ẩn danh hoá khách
CREATE TABLE chat_messages (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('USER', 'BOT')),
  text            text NOT NULL,
  reply           jsonb,                           -- thẻ / nút của tin bot
  intent          text,
  customer_id     uuid REFERENCES customers (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conv_idx ON chat_messages (conversation_id, id);
CREATE INDEX chat_messages_customer_idx ON chat_messages (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX chat_messages_created_idx ON chat_messages (created_at);

-- Phiếu ghi chờ xác nhận
CREATE TABLE chat_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES chat_conversations (id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('SALE', 'DEPOSIT', 'PAYMENT', 'COMPLETE_DEPOSIT', 'PURCHASE_ITEMS', 'LEDGER_ENTRY',
                                                'LANDED_COST', 'TRANSFER', 'CUSTOMER', 'EINVOICE', 'TARGET_PRICE')),
  payload         jsonb NOT NULL,                  -- bản nháp: chuỗi đúng dạng form + id đã tra (máy, khách, tài khoản…)
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'CONFIRMED', 'DISCARDED', 'FAILED', 'EXPIRED', 'DRAFTED')),
  result_type     text,                            -- sale · cash_transaction · cost · transfer · customer · item · purchase_order
  result_id       text,
  result_href     text,
  error           text,
  customer_id     uuid REFERENCES customers (id),
  bang_ke_id      uuid,                            -- phiếu tạo từ một dòng bảng kê nháp
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '1 day',
  CONSTRAINT chat_actions_confirmed_has_result CHECK (status <> 'CONFIRMED' OR result_type IS NOT NULL)
);
CREATE INDEX chat_actions_conv_idx ON chat_actions (conversation_id, created_at DESC);
CREATE INDEX chat_actions_result_idx ON chat_actions (result_type, result_id) WHERE result_id IS NOT NULL;

-- Bảng kê nháp: tin chưa đủ / chưa khớp để ghi thật — bổ sung rồi "Ghi thật"
CREATE TABLE bang_ke_nhap (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('SALE', 'DEPOSIT', 'PURCHASE', 'EXPENSE', 'INCOME', 'PAYMENT', 'OTHER')),
  occurred_on       date,
  model_text        text,                          -- dòng máy gõ tự do
  code              text,                          -- IMEI / Serial
  price_text        text,                          -- số tiền gõ tự do ("25tr5", "$899")
  customer_text     text,                          -- DỮ LIỆU CÁ NHÂN
  customer_phone    text,                          -- DỮ LIỆU CÁ NHÂN
  customer_id       uuid REFERENCES customers (id),
  channel           text,
  payment           text,
  ref_text          text,                          -- mã chuyến / đơn / vận đơn người dùng gõ
  note              text,
  reason            text,                          -- vì sao chưa ghi thật được
  raw_text          text,                          -- DỮ LIỆU CÁ NHÂN: tin gốc
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PROMOTED', 'DISCARDED')),
  promoted_type     text,
  promoted_id       text,
  promoted_href     text,
  source_message_id bigint REFERENCES chat_messages (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bang_ke_nhap_status_idx ON bang_ke_nhap (status, occurred_on);
ALTER TABLE chat_actions ADD CONSTRAINT chat_actions_bang_ke_fk FOREIGN KEY (bang_ke_id) REFERENCES bang_ke_nhap (id) ON DELETE SET NULL;
