/**
 * Trợ lý — lưu hội thoại, tin nhắn, phiếu chờ xác nhận. Tin nhắn chứa dữ liệu cá nhân: xoá theo hạn lưu (`purgeOld`),
 * làm sạch khi ẩn danh hoá khách (`scrubCustomerChat`). Không ghi gì của chat vào audit_logs ngoài mã phiếu / mã kết quả.
 */
import type { Sql, TransactionSql } from "postgres";
import type { Draft } from "@/domain/assistant/drafts";
import type { ActionStatus, Reply } from "@/domain/assistant/reply";

type Db = Sql | TransactionSql;

/** Hạn lưu tin nhắn (ngày). */
export const RETENTION_DAYS = 90;

export interface ConversationState {
  /** phiếu đang chờ (xác nhận / trả lời câu hỏi) */
  pendingActionId?: string;
}

export interface Conversation {
  id: string;
  state: ConversationState;
}

const json = (db: Db, v: unknown) => db.json(JSON.parse(JSON.stringify(v ?? null, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as never);

export async function getOrCreateConversation(db: Db, channel = "WEB", externalId = "owner"): Promise<Conversation> {
  const [c] = await db<{ id: string; state: ConversationState }[]>`
    INSERT INTO chat_conversations (channel, external_id) VALUES (${channel}, ${externalId})
    ON CONFLICT (channel, external_id) DO UPDATE SET updated_at = chat_conversations.updated_at
    RETURNING id::text, state`;
  return { id: c.id, state: c.state ?? {} };
}

export async function getConversation(db: Db, id: string): Promise<Conversation | null> {
  const [c] = await db<{ id: string; state: ConversationState }[]>`SELECT id::text, state FROM chat_conversations WHERE id = ${id}`;
  return c ? { id: c.id, state: c.state ?? {} } : null;
}

export async function setState(db: Db, id: string, state: ConversationState) {
  await db`UPDATE chat_conversations SET state = ${json(db, state)}, updated_at = now() WHERE id = ${id}`;
}

export async function addMessage(
  db: Db,
  conversationId: string,
  role: "USER" | "BOT",
  text: string,
  opts: { reply?: Reply; intent?: string; customerId?: string | null } = {},
): Promise<number> {
  const [m] = await db<{ id: string }[]>`
    INSERT INTO chat_messages (conversation_id, role, text, reply, intent, customer_id)
    VALUES (${conversationId}, ${role}, ${text.slice(0, 4000)}, ${opts.reply ? json(db, opts.reply) : null}, ${opts.intent ?? null}, ${opts.customerId ?? null})
    RETURNING id::text`;
  return Number(m.id);
}

export interface MessageRow {
  id: number;
  role: "USER" | "BOT";
  text: string;
  reply: Reply | null;
  at: string;
}

/** Tin nhắn gần nhất (cũ → mới). Thẻ phiếu được cập nhật trạng thái hiện tại của phiếu (đã ghi / đã huỷ…). */
export async function listMessages(db: Db, conversationId: string, limit = 60): Promise<MessageRow[]> {
  const rows = await db<{ id: string; role: "USER" | "BOT"; text: string; reply: Reply | null; at: string }[]>`
    SELECT id::text, role, text, reply, created_at::text AS at FROM (
      SELECT * FROM chat_messages WHERE conversation_id = ${conversationId} ORDER BY id DESC LIMIT ${limit}) m
     ORDER BY id`;
  const ids = [
    ...new Set(rows.flatMap((r) => (r.reply?.cards ?? []).flatMap((c) => (c.kind === "preview" ? [c.actionId] : [])))),
  ];
  const states = ids.length ? await actionStates(db, ids) : new Map();
  return rows.map((r) => ({
    id: Number(r.id),
    role: r.role,
    text: r.text,
    at: r.at,
    reply: r.reply ? withActionStates(r.reply, states) : null,
  }));
}

export interface ActionState {
  status: ActionStatus;
  resultHref: string | null;
  resultLabel: string | null;
  error: string | null;
  expired: boolean;
}

export async function actionStates(db: Db, ids: readonly string[]): Promise<Map<string, ActionState>> {
  const rows = await db<{ id: string; status: ActionStatus; result_href: string | null; result_type: string | null; error: string | null; expired: boolean }[]>`
    SELECT id::text, status, result_href, result_type, error, expires_at < now() AS expired FROM chat_actions WHERE id = ANY(${[...ids]}::uuid[])`;
  return new Map(
    rows.map((r) => [
      r.id,
      { status: r.status, resultHref: r.result_href, resultLabel: r.result_type ? RESULT_LABEL[r.result_type] ?? "Xem" : null, error: r.error, expired: r.expired },
    ]),
  );
}

export const RESULT_LABEL: Record<string, string> = {
  sale: "Mở đơn bán",
  cash_transaction: "Mở phiếu thu chi",
  cost: "Mở chi phí",
  transfer: "Mở sổ quỹ",
  customer: "Mở khách hàng",
  item: "Mở máy",
  purchase_order: "Mở chuyến hàng",
};

/** Ghi trạng thái hiện tại của phiếu vào thẻ xem trước (thẻ lưu trong tin là ảnh chụp lúc tạo). */
export function withActionStates(reply: Reply, states: Map<string, ActionState>): Reply {
  if (!reply.cards?.some((c) => c.kind === "preview")) return reply;
  return {
    ...reply,
    cards: reply.cards.map((c) => {
      if (c.kind !== "preview") return c;
      const s = states.get(c.actionId);
      if (!s) return c;
      const status: ActionStatus = s.status === "PENDING" && s.expired ? "EXPIRED" : s.status;
      return {
        ...c,
        status,
        ...(s.resultHref ? { result: { href: s.resultHref, label: s.resultLabel ?? "Xem" } } : {}),
        ...(s.error && (status === "FAILED" || status === "PENDING") ? { error: s.error } : {}),
      };
    }),
  };
}

// ---- Phiếu --------------------------------------------------------------------------------------------

export interface ActionRow {
  id: string;
  conversationId: string | null;
  kind: Draft["kind"];
  draft: Draft;
  status: ActionStatus;
  expired: boolean;
  bangKeId: string | null;
  customerId: string | null;
}

export async function createAction(db: Db, conversationId: string | null, draft: Draft, opts: { bangKeId?: string | null } = {}): Promise<string> {
  const [a] = await db<{ id: string }[]>`
    INSERT INTO chat_actions (conversation_id, kind, payload, customer_id, bang_ke_id)
    VALUES (${conversationId}, ${draft.kind}, ${json(db, draft)}, ${draft.customerId ?? null}, ${opts.bangKeId ?? null})
    RETURNING id::text`;
  return a.id;
}

export async function getAction(db: Db, id: string, lock = false): Promise<ActionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = lock
    ? await db<RawAction[]>`SELECT ${ACTION_COLS(db)} FROM chat_actions WHERE id = ${id} FOR UPDATE`
    : await db<RawAction[]>`SELECT ${ACTION_COLS(db)} FROM chat_actions WHERE id = ${id}`;
  return rows[0] ? mapAction(rows[0]) : null;
}

interface RawAction {
  id: string;
  conversation_id: string | null;
  kind: Draft["kind"];
  payload: Draft;
  status: ActionStatus;
  expired: boolean;
  bang_ke_id: string | null;
  customer_id: string | null;
}
const ACTION_COLS = (db: Db) =>
  db.unsafe(`id::text, conversation_id::text, kind, payload, status, expires_at < now() AS expired, bang_ke_id::text, customer_id::text`);
const mapAction = (r: RawAction): ActionRow => ({
  id: r.id,
  conversationId: r.conversation_id,
  kind: r.kind,
  draft: r.payload,
  status: r.status,
  expired: r.expired,
  bangKeId: r.bang_ke_id,
  customerId: r.customer_id,
});

export async function updateActionDraft(db: Db, id: string, draft: Draft) {
  await db`
    UPDATE chat_actions SET payload = ${json(db, draft)}, kind = ${draft.kind}, customer_id = ${draft.customerId ?? null},
           expires_at = now() + interval '1 day'
     WHERE id = ${id} AND status = 'PENDING'`;
}

export async function finishAction(
  db: Db,
  id: string,
  status: Exclude<ActionStatus, "PENDING">,
  result: { type?: string; id?: string; href?: string; error?: string; customerId?: string | null } = {},
) {
  await db`
    UPDATE chat_actions
       SET status = ${status}, result_type = ${result.type ?? null}, result_id = ${result.id ?? null}, result_href = ${result.href ?? null},
           error = ${result.error ?? null}, decided_at = now(), customer_id = COALESCE(${result.customerId ?? null}::uuid, customer_id)
     WHERE id = ${id}`;
}

// ---- Dữ liệu cá nhân ----------------------------------------------------------------------------------

/** Xoá tin nhắn quá hạn lưu và chữ gốc của dòng bảng kê đã xử lý xong. */
export async function purgeOld(db: Db, days = RETENTION_DAYS) {
  const cutoff = `${days} days`;
  const msgs = await db`DELETE FROM chat_messages WHERE created_at < now() - ${cutoff}::interval`;
  await db`UPDATE bang_ke_nhap SET raw_text = NULL WHERE raw_text IS NOT NULL AND status <> 'DRAFT' AND updated_at < now() - ${cutoff}::interval`;
  await db`UPDATE chat_actions SET payload = payload - 'customerName' - 'phone' - 'zalo' - 'counterparty'
            WHERE status <> 'PENDING' AND created_at < now() - ${cutoff}::interval AND (payload ? 'customerName' OR payload ? 'phone')`;
  return { messages: msgs.count };
}

/**
 * Ẩn danh hoá khách: làm sạch mọi dấu vết trong trợ lý — tin nhắn gắn với khách, tên / SĐT trong phiếu, dòng bảng kê.
 * Gọi trong cùng transaction với anonymizeCustomer.
 */
export async function scrubCustomerChat(tx: Db, customerId: string) {
  await tx`UPDATE chat_messages SET text = '[đã ẩn danh]', reply = NULL WHERE customer_id = ${customerId}`;
  await tx`UPDATE chat_actions SET payload = payload - 'customerName' - 'phone' - 'zalo' - 'counterparty' WHERE customer_id = ${customerId}`;
  await tx`UPDATE bang_ke_nhap SET customer_text = NULL, customer_phone = NULL, raw_text = NULL, note = NULL, updated_at = now() WHERE customer_id = ${customerId}`;
}

/** Xoá toàn bộ lịch sử trò chuyện (phiếu và bảng kê giữ lại). */
export async function clearConversation(db: Db, conversationId: string) {
  await db`DELETE FROM chat_messages WHERE conversation_id = ${conversationId}`;
  await db`UPDATE chat_actions SET status = 'EXPIRED', decided_at = now() WHERE conversation_id = ${conversationId} AND status = 'PENDING'`;
  await setState(db, conversationId, {});
}
