/**
 * Bảng kê nháp — tin nhắn chưa đủ / chưa khớp để ghi thật. Người dùng sửa từng ô rồi "Ghi thật": dòng được dựng lại thành
 * một phiếu của trợ lý (cùng kiểm tra, cùng xác nhận) — không có đường ghi riêng.
 */
import type { Sql, TransactionSql } from "postgres";
import { dmy } from "@/domain/assistant/dates";
import type { BangKeDraft } from "@/domain/assistant/drafts";
import type { WriteIntent } from "@/domain/assistant/intents";

type Db = Sql | TransactionSql;

export const BANG_KE_KINDS = ["SALE", "DEPOSIT", "PURCHASE", "EXPENSE", "INCOME", "PAYMENT", "OTHER"] as const;
export type BangKeKind = (typeof BANG_KE_KINDS)[number];
export const BANG_KE_KIND_LABEL: Record<BangKeKind, string> = {
  SALE: "Bán",
  DEPOSIT: "Cọc",
  PURCHASE: "Nhập máy",
  EXPENSE: "Chi",
  INCOME: "Thu",
  PAYMENT: "Thu nợ",
  OTHER: "Khác",
};

export interface BangKeRow {
  id: string;
  kind: BangKeKind;
  occurredOn: string | null;
  modelText: string | null;
  code: string | null;
  priceText: string | null;
  customerText: string | null;
  customerPhone: string | null;
  channel: string | null;
  payment: string | null;
  refText: string | null;
  note: string | null;
  reason: string | null;
  status: "DRAFT" | "PROMOTED" | "DISCARDED";
  promotedHref: string | null;
  createdAt: string;
}

interface Raw {
  id: string;
  kind: BangKeKind;
  occurred_on: string | null;
  model_text: string | null;
  code: string | null;
  price_text: string | null;
  customer_text: string | null;
  customer_phone: string | null;
  channel: string | null;
  payment: string | null;
  ref_text: string | null;
  note: string | null;
  reason: string | null;
  status: BangKeRow["status"];
  promoted_href: string | null;
  created_at: string;
}
const map = (r: Raw): BangKeRow => ({
  id: r.id,
  kind: r.kind,
  occurredOn: r.occurred_on,
  modelText: r.model_text,
  code: r.code,
  priceText: r.price_text,
  customerText: r.customer_text,
  customerPhone: r.customer_phone,
  channel: r.channel,
  payment: r.payment,
  refText: r.ref_text,
  note: r.note,
  reason: r.reason,
  status: r.status,
  promotedHref: r.promoted_href,
  createdAt: r.created_at,
});
const COLS = (db: Db) =>
  db.unsafe(`id::text, kind, occurred_on::text, model_text, code, price_text, customer_text, customer_phone, channel, payment, ref_text, note, reason,
             status, promoted_href, created_at::text`);

export async function addBangKe(
  db: Db,
  row: BangKeDraft,
  opts: { reason?: string | null; rawText?: string | null; sourceMessageId?: number | null; customerId?: string | null } = {},
): Promise<string> {
  const [r] = await db<{ id: string }[]>`
    INSERT INTO bang_ke_nhap (kind, occurred_on, model_text, code, price_text, customer_text, customer_phone, customer_id, channel, payment, ref_text,
                              note, reason, raw_text, source_message_id)
    VALUES (${row.kind}, ${row.occurredOn}, ${row.modelText}, ${row.code}, ${row.priceText}, ${row.customerText}, ${row.customerPhone},
            ${opts.customerId ?? null}, ${row.channel}, ${row.payment}, ${row.refText}, ${row.note}, ${opts.reason ?? null},
            ${opts.rawText?.slice(0, 4000) ?? null}, ${opts.sourceMessageId ?? null})
    RETURNING id::text`;
  return r.id;
}

export async function listBangKe(db: Db, opts: { status?: BangKeRow["status"] | "ALL"; from?: string; toExcl?: string } = {}): Promise<BangKeRow[]> {
  const st = opts.status ?? "DRAFT";
  const rows = await db<Raw[]>`
    SELECT ${COLS(db)} FROM bang_ke_nhap
     WHERE ${st === "ALL" ? db`true` : db`status = ${st}`}
       ${opts.from ? db`AND COALESCE(occurred_on, (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) >= ${opts.from}::date` : db``}
       ${opts.toExcl ? db`AND COALESCE(occurred_on, (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) < ${opts.toExcl}::date` : db``}
     ORDER BY COALESCE(occurred_on, created_at::date) DESC, created_at DESC LIMIT 500`;
  return rows.map(map);
}

export async function getBangKe(db: Db, id: string): Promise<BangKeRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [r] = await db<Raw[]>`SELECT ${COLS(db)} FROM bang_ke_nhap WHERE id = ${id}`;
  return r ? map(r) : null;
}

export class BangKeError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export async function saveBangKe(db: Db, id: string, f: Partial<Record<keyof Omit<BangKeRow, "id" | "status" | "promotedHref" | "createdAt" | "reason">, string>>) {
  const t = (v: string | undefined, max = 200) => (v ?? "").trim().slice(0, max) || null;
  const kind = (f.kind ?? "") as BangKeKind;
  if (!BANG_KE_KINDS.includes(kind)) throw new BangKeError("Chọn loại dòng");
  const date = t(f.occurredOn);
  if (date && (!DATE_RE.test(date) || Number.isNaN(Date.parse(date)))) throw new BangKeError("Ngày không hợp lệ");
  const r = await db`
    UPDATE bang_ke_nhap
       SET kind = ${kind}, occurred_on = ${date}, model_text = ${t(f.modelText)}, code = ${t(f.code, 400)}, price_text = ${t(f.priceText, 60)},
           customer_text = ${t(f.customerText, 120)}, customer_phone = ${t(f.customerPhone, 20)}, channel = ${t(f.channel, 20)}, payment = ${t(f.payment, 40)},
           ref_text = ${t(f.refText, 60)}, note = ${t(f.note, 500)}, updated_at = now()
     WHERE id = ${id} AND status = 'DRAFT'`;
  if (!r.count) throw new BangKeError("Dòng không còn ở trạng thái nháp");
}

export async function discardBangKe(db: Db, ids: readonly string[]) {
  await db`UPDATE bang_ke_nhap SET status = 'DISCARDED', updated_at = now() WHERE id = ANY(${[...ids]}::uuid[]) AND status = 'DRAFT'`;
}

export async function markPromoted(db: Db, id: string, result: { type: string; id: string; href: string }) {
  await db`
    UPDATE bang_ke_nhap SET status = 'PROMOTED', promoted_type = ${result.type}, promoted_id = ${result.id}, promoted_href = ${result.href}, updated_at = now()
     WHERE id = ${id}`;
}

const CHANNEL_WORD: Record<string, string> = { FACEBOOK: "fb", ZALO: "zalo", TIKTOK: "tiktok", SHOPEE: "shopee", WALK_IN: "tại shop", REFERRAL: "giới thiệu" };
const PAYMENT_WORD: Record<string, string> = { TRANSFER: "ck", CASH: "tiền mặt", UNPAID: "ghi nợ" };
export const KIND_INTENT: Record<BangKeKind, WriteIntent | null> = {
  SALE: "SALE",
  DEPOSIT: "DEPOSIT",
  PURCHASE: "PURCHASE_ITEMS",
  EXPENSE: "LEDGER_ENTRY",
  INCOME: "LEDGER_ENTRY",
  PAYMENT: "PAYMENT",
  OTHER: null,
};

/** Dòng bảng kê → câu nhắn tương đương (để dùng lại đúng bộ đọc câu của trợ lý). */
export function bangKeAsText(r: BangKeRow): string {
  const kindWord = { SALE: "bán", DEPOSIT: "cọc", PURCHASE: "nhập máy", EXPENSE: "chi", INCOME: "thu khác", PAYMENT: "thu nợ", OTHER: "" }[r.kind];
  const price = r.priceText ?? "";
  const pay = r.payment ? (PAYMENT_WORD[r.payment] ?? r.payment) : "";
  const parts = [
    kindWord,
    // mã không phải IMEI: ghi "serial …" để chắc được đọc là mã máy (kể cả Serial dài / vài số cuối)
    ...(r.code ?? "")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((c) => (/^\d{15}$/.test(c) ? c : `serial ${c}`)),
    r.modelText ?? "",
    r.kind === "DEPOSIT" && !/coc/i.test(pay) ? `giá ${price}` : price,
    r.customerText ? `khách ${r.customerText.replace(/^khách\s+/i, "")}` : "",
    r.customerPhone ?? "",
    r.channel ? (CHANNEL_WORD[r.channel] ?? "") : "",
    pay,
    r.refText ?? "",
    r.occurredOn ? `ngày ${dmy(r.occurredOn)}` : "",
    r.note ? (r.kind === "EXPENSE" || r.kind === "INCOME" ? r.note : `ghi chú ${r.note}`) : "",
  ];
  return parts.filter(Boolean).join(" ");
}
