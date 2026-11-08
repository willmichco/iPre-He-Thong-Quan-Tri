/**
 * Trợ lý — điều phối hội thoại, trung lập kênh: web (/tro-ly) hôm nay; Telegram / Zalo sau này chỉ cần gọi đúng
 * `handleMessage` / `handleEvent` rồi vẽ `Reply` theo cách của kênh (`replyAsText`).
 *
 * Luật cứng: KHÔNG ghi dữ liệu nghiệp vụ nếu người dùng chưa xác nhận phiếu. Xác nhận chạy trong một transaction:
 * khoá phiếu → dựng lại phiếu từ CSDL hiện tại (không còn điều kiện chặn) → gọi dịch vụ của form tay → đánh dấu đã ghi
 * → một dòng nhật ký không chứa dữ liệu cá nhân. Bấm 2 lần chỉ ghi 1 lần.
 */
import type { Sql, TransactionSql } from "postgres";
import { metaOf } from "@/domain/assistant/dialog";
import { bangKeFromDraft, draftFromSlots, mergeSlots, type Draft } from "@/domain/assistant/drafts";
import { extractSlots } from "@/domain/assistant/extract";
import { fallbackReply } from "@/domain/assistant/examples";
import { isWriteIntent, type WriteIntent } from "@/domain/assistant/intents";
import { hasEditableSlots, parseMessage, type ParseCtx } from "@/domain/assistant/parse";
import type { AssistantEvent, Chip, PreviewCard, Reply } from "@/domain/assistant/reply";
import { applyChoice, buildDraft, errorText, executeDraft, type Built } from "./actions";
import { addBangKe, bangKeAsText, getBangKe, KIND_INTENT, markPromoted } from "./bang-ke";
import { loadParseCtx } from "./context";
import { answerQuery } from "./queries";
import {
  addMessage,
  clearConversation,
  createAction,
  finishAction,
  getAction,
  getConversation,
  purgeOld,
  setState,
  updateActionDraft,
  type ActionRow,
} from "./store";

export interface HandleCtx {
  db: Sql | TransactionSql;
  conversationId: string;
  today: string;
}

interface Turn {
  replies: Reply[];
  intent?: string;
}

const BANG_KE_LINK = { href: "/tro-ly/bang-ke", label: "Mở Bảng kê nháp" };

/** Thẻ phiếu + câu hỏi / lời nhắc. */
function cardReply(actionId: string, b: Built): Reply {
  const blockers = [...b.card.blockers];
  if (b.ask) blockers.unshift(`Đang chờ: ${b.ask.question}`);
  const card: PreviewCard = { kind: "preview", actionId, status: "PENDING", ...b.card, blockers };
  const chips: Chip[] = [];
  if (b.draft.choices) b.draft.choices.options.forEach((o, i) => chips.push({ label: `${i + 1}. ${o.label}`, event: { type: "CHOOSE", actionId, index: i + 1 } }));
  else if (b.ask?.chips?.length) chips.push(...b.ask.chips);
  if (b.ask) chips.push({ label: "Để sau (bảng kê nháp)", event: { type: "TO_BANG_KE", actionId } }, { label: "Huỷ", event: { type: "DISCARD", actionId } });
  const text = b.ask ? b.ask.question : b.card.blockers.length ? "Phiếu còn vướng — sửa rồi mới xác nhận được:" : 'Kiểm tra rồi bấm Xác nhận (hoặc gõ "ok"). Sai chỗ nào thì gõ "sửa …".';
  return { text, cards: [card], ...(chips.length ? { chips } : {}) };
}

async function linkCustomer(db: Sql | TransactionSql, d: Draft, customerId: string | null | undefined) {
  if (!customerId || !d.msgIds?.length) return;
  await db`UPDATE chat_messages SET customer_id = ${customerId} WHERE id = ANY(${d.msgIds}::bigint[]) AND customer_id IS NULL`;
}

/** Dựng phiếu mới từ bản nháp: không tra ra được → vào bảng kê; còn lại → phiếu chờ xác nhận. */
async function startDraft(ctx: HandleCtx, d: Draft, raw: string, userMsgId: number, bangKeId: string | null = null): Promise<Turn> {
  const { db } = ctx;
  d.msgIds = [userMsgId];
  const b = await buildDraft(db, d, { today: ctx.today });
  if (b.unresolvable) {
    if (bangKeId) return { replies: [{ text: `Dòng bảng kê vẫn chưa ghi thật được: ${b.unresolvable}. Sửa lại dòng rồi thử lại.`, link: BANG_KE_LINK }] };
    await addBangKe(db, bangKeFromDraft(b.draft), { reason: b.unresolvable, rawText: raw, sourceMessageId: userMsgId, customerId: b.draft.customerId });
    return {
      intent: d.kind,
      replies: [
        {
          text: `Chưa ghi thật được: ${b.unresolvable}. Mình đã đưa tin này vào Bảng kê nháp — bổ sung rồi bấm "Ghi thật" khi đủ.`,
          link: BANG_KE_LINK,
          chips: [{ label: "Xem bảng kê nháp", text: "bảng kê nháp" }],
        },
      ],
    };
  }
  const id = await createAction(db, ctx.conversationId, b.draft, { bangKeId });
  await linkCustomer(db, b.draft, b.draft.customerId);
  await setState(db, ctx.conversationId, { pendingActionId: id });
  return { intent: d.kind, replies: [cardReply(id, b)] };
}

/** Dựng lại phiếu đang chờ sau khi sửa / chọn. */
async function rebuild(ctx: HandleCtx, a: ActionRow, d: Draft, msgId: number | null): Promise<Turn> {
  if (msgId) d.msgIds = [...(d.msgIds ?? []), msgId];
  const b = await buildDraft(ctx.db, d, { today: ctx.today });
  await updateActionDraft(ctx.db, a.id, b.draft);
  await linkCustomer(ctx.db, b.draft, b.draft.customerId);
  await setState(ctx.db, ctx.conversationId, { pendingActionId: a.id });
  if (b.unresolvable)
    return {
      replies: [
        {
          text: `Chưa ghi được: ${b.unresolvable}.`,
          chips: [
            { label: "Đưa vào bảng kê nháp", event: { type: "TO_BANG_KE", actionId: a.id } },
            { label: "Huỷ phiếu", event: { type: "DISCARD", actionId: a.id } },
          ],
        },
      ],
    };
  return { replies: [cardReply(a.id, b)] };
}

async function confirm(ctx: HandleCtx, actionId: string): Promise<Turn> {
  const { db } = ctx;
  type Outcome = { ok: true; summary: string; href: string; label: string } | { ok: false; reply: Reply };
  let outcome: Outcome;
  try {
    outcome = await db.begin(async (tx): Promise<Outcome> => {
      const a = await getAction(tx, actionId, true);
      if (!a) return { ok: false, reply: { text: "Không thấy phiếu này." } };
      if (a.status === "CONFIRMED") return { ok: false, reply: { text: "Phiếu này đã ghi rồi — không ghi lại lần nữa." } };
      if (a.status !== "PENDING") return { ok: false, reply: { text: "Phiếu này đã huỷ / hết hạn. Nhắn lại để lập phiếu mới." } };
      if (a.expired) {
        await finishAction(tx, a.id, "EXPIRED");
        return { ok: false, reply: { text: "Phiếu đã quá 24 giờ — số liệu có thể đã đổi. Nhắn lại để lập phiếu mới." } };
      }
      // dựng lại từ CSDL hiện tại: máy có thể vừa bán ở form tay, tài khoản vừa ngừng dùng…
      const b = await buildDraft(tx, a.draft, { today: ctx.today });
      if (b.unresolvable || b.ask || b.card.blockers.length)
        return { ok: false, reply: b.unresolvable ? { text: `Chưa ghi được: ${b.unresolvable}.` } : { ...cardReply(a.id, b), text: "Chưa ghi được — phiếu còn vướng:" } };
      const r = await executeDraft(tx, b.draft, { today: ctx.today });
      await finishAction(tx, a.id, "CONFIRMED", { type: r.type, id: r.id, href: r.href, customerId: r.customerId ?? null });
      await tx`INSERT INTO audit_logs (action, entity_type, entity_id, after)
               VALUES ('CREATE', 'assistant_action', ${a.id}, ${tx.json({ kind: a.kind, resultType: r.type, resultId: r.id })})`;
      if (a.bangKeId) await markPromoted(tx, a.bangKeId, r);
      if (r.customerId && b.draft.msgIds?.length)
        await tx`UPDATE chat_messages SET customer_id = ${r.customerId} WHERE id = ANY(${b.draft.msgIds}::bigint[]) AND customer_id IS NULL`;
      return { ok: true, summary: r.summary, href: r.href, label: "Mở" };
    });
  } catch (e) {
    const msg = errorText(e);
    await db`UPDATE chat_actions SET error = ${msg} WHERE id = ${actionId} AND status = 'PENDING'`;
    return {
      replies: [
        {
          text: `Chưa ghi được: ${msg}`,
          chips: [
            { label: "Đưa vào bảng kê nháp", event: { type: "TO_BANG_KE", actionId } },
            { label: "Huỷ phiếu", event: { type: "DISCARD", actionId } },
          ],
        },
      ],
    };
  }
  if (!outcome.ok) return { replies: [outcome.reply] };
  await db`UPDATE chat_actions SET error = NULL WHERE id = ${actionId}`;
  await setState(db, ctx.conversationId, {});
  return { replies: [{ text: `✓ ${outcome.summary}.`, link: { href: outcome.href, label: "Mở bản ghi vừa tạo" } }] };
}

async function discard(ctx: HandleCtx, a: ActionRow): Promise<Turn> {
  if (a.status !== "PENDING") return { replies: [{ text: "Phiếu này không còn chờ xác nhận." }] };
  await finishAction(ctx.db, a.id, "DISCARDED");
  await setState(ctx.db, ctx.conversationId, {});
  return { replies: [{ text: "Đã huỷ phiếu — không ghi gì." }] };
}

async function toBangKe(ctx: HandleCtx, a: ActionRow, raw: string | null): Promise<Turn> {
  if (a.status !== "PENDING") return { replies: [{ text: "Phiếu này không còn chờ xác nhận." }] };
  if (a.bangKeId) {
    await finishAction(ctx.db, a.id, "DISCARDED");
    await setState(ctx.db, ctx.conversationId, {});
    return { replies: [{ text: "Đã để lại dòng trong bảng kê nháp.", link: BANG_KE_LINK }] };
  }
  await addBangKe(ctx.db, bangKeFromDraft(a.draft), { reason: "Để sau", rawText: raw, customerId: a.draft.customerId });
  await finishAction(ctx.db, a.id, "DRAFTED");
  await setState(ctx.db, ctx.conversationId, {});
  return { replies: [{ text: "Đã đưa vào Bảng kê nháp — bổ sung rồi bấm \"Ghi thật\" khi đủ thông tin.", link: BANG_KE_LINK }] };
}

async function pendingAction(ctx: HandleCtx): Promise<ActionRow | null> {
  const conv = await getConversation(ctx.db, ctx.conversationId);
  const id = conv?.state.pendingActionId;
  if (!id) return null;
  const a = await getAction(ctx.db, id);
  return a && a.status === "PENDING" && !a.expired ? a : null;
}

async function saveBot(ctx: HandleCtx, t: Turn) {
  const ids: number[] = [];
  for (const r of t.replies) ids.push(await addMessage(ctx.db, ctx.conversationId, "BOT", r.text, { reply: r, intent: t.intent }));
  return ids;
}

/** Một tin nhắn của người dùng → các câu trả lời (đã lưu vào lịch sử). */
export async function handleMessage(ctx: HandleCtx, rawText: string): Promise<Reply[]> {
  const text = rawText.trim().slice(0, 4000);
  if (!text) return [];
  const { db } = ctx;
  await purgeOld(db);
  const pending = await pendingAction(ctx);
  const userMsgId = await addMessage(db, ctx.conversationId, "USER", text);
  const meta = metaOf(text, !!pending);
  let turn: Turn;
  let pctx: ParseCtx | null = null;
  const parseCtx = async () => (pctx ??= await loadParseCtx(db, ctx.today));

  if (meta?.type === "CLEAR") {
    await clearConversation(db, ctx.conversationId);
    turn = { replies: [{ text: "Đã xoá lịch sử trò chuyện (phiếu đã ghi và bảng kê nháp vẫn giữ)." }] };
  } else if (meta && pending) {
    if (meta.type === "CONFIRM") turn = await confirm(ctx, pending.id);
    else if (meta.type === "CANCEL") turn = await discard(ctx, pending);
    else if (meta.type === "DRAFT") turn = await toBangKe(ctx, pending, text);
    else if (meta.type === "CHOOSE") {
      const d = applyChoice(pending.draft, meta.index);
      turn = d ? await rebuild(ctx, pending, d, userMsgId) : { replies: [{ text: `Không có lựa chọn số ${meta.index}.` }] };
    } else {
      const slots = extractSlots(meta.type === "EDIT" ? meta.text : text, await parseCtx());
      turn = await rebuild(ctx, pending, mergeSlots(pending.draft, slots, meta.type === "EDIT" ? meta.text : text), userMsgId);
    }
  } else {
    const parsed = parseMessage(text, await parseCtx());
    const editsPending =
      pending && !isWriteIntent(parsed.intent) && hasEditableSlots(parsed.slots) && (parsed.intent === "UNKNOWN" || parsed.score < 6 || !!pending.draft.asked);
    if (pending && editsPending) turn = await rebuild(ctx, pending, mergeSlots(pending.draft, parsed.slots, text), userMsgId);
    else if (isWriteIntent(parsed.intent)) turn = await startDraft(ctx, draftFromSlots(parsed.intent, parsed.slots, text), text, userMsgId);
    else {
      const r = await answerQuery({ db, today: ctx.today }, parsed.intent, parsed.slots);
      // câu mơ hồ: gợi ý các ý khác
      if (parsed.intent !== "UNKNOWN" && parsed.alternatives.length && !r.chips?.length) r.chips = parsed.alternatives.map((i) => ({ label: ALT_LABEL[i] ?? i, text: ALT_TEXT[i] ?? text }));
      turn = { intent: parsed.intent, replies: [parsed.intent === "UNKNOWN" ? fallbackReply({ money: parsed.slots.money.length > 0, date: !!parsed.slots.period, product: parsed.slots.variantIds.length > 0, code: parsed.slots.codes.length > 0 }) : r] };
    }
  }
  const botIds = await saveBot(ctx, turn);
  // tin bot của phiếu cũng có thể chứa tên khách → gắn vào phiếu để làm sạch khi ẩn danh hoá
  const pendingNow = await pendingAction(ctx);
  if (pendingNow && turn.replies.some((r) => r.cards?.some((c) => c.kind === "preview" && c.actionId === pendingNow.id))) {
    const d = { ...pendingNow.draft, msgIds: [...new Set([...(pendingNow.draft.msgIds ?? []), userMsgId, ...botIds])] };
    await updateActionDraft(db, pendingNow.id, d);
    await linkCustomer(db, d, d.customerId);
  }
  return turn.replies;
}

const ALT_LABEL: Record<string, string> = { STOCK: "Tồn kho", REVENUE: "Doanh thu", DEBT: "Công nợ", SHIPMENTS: "Kiện đang đi", RECENT_SALES: "Đơn bán gần đây", BALANCE: "Số dư" };
const ALT_TEXT: Record<string, string> = { STOCK: "tồn kho", REVENUE: "doanh thu tháng này", DEBT: "ai còn nợ", SHIPMENTS: "kiện đang đi", RECENT_SALES: "đơn bán tuần này", BALANCE: "số dư" };

/** Bấm nút trên thẻ phiếu (Xác nhận / Huỷ / Để sau / chọn số / sửa). */
export async function handleEvent(ctx: HandleCtx, ev: AssistantEvent): Promise<Reply[]> {
  const a = await getAction(ctx.db, ev.actionId);
  if (!a || (a.conversationId && a.conversationId !== ctx.conversationId)) return [{ text: "Không thấy phiếu này." }];
  let turn: Turn;
  if (ev.type === "CONFIRM") turn = await confirm(ctx, a.id);
  else if (a.status !== "PENDING" || a.expired) turn = { replies: [{ text: "Phiếu này không còn chờ xác nhận." }] };
  else if (ev.type === "DISCARD") turn = await discard(ctx, a);
  else if (ev.type === "TO_BANG_KE") turn = await toBangKe(ctx, a, null);
  else if (ev.type === "CHOOSE") {
    const d = applyChoice(a.draft, ev.index);
    turn = d ? await rebuild(ctx, a, d, null) : { replies: [{ text: "Lựa chọn không còn hợp lệ." }] };
  } else {
    const text = ev.text.trim().slice(0, 500);
    if (!text) return [];
    const userMsgId = await addMessage(ctx.db, ctx.conversationId, "USER", `sửa ${text}`);
    const slots = extractSlots(text, await loadParseCtx(ctx.db, ctx.today));
    turn = await rebuild(ctx, a, mergeSlots(a.draft, slots, text), userMsgId);
  }
  await saveBot(ctx, turn);
  return turn.replies;
}

/** "Ghi thật" một dòng bảng kê nháp: dựng phiếu trong hội thoại để xác nhận như mọi phiếu khác. */
export async function promoteBangKe(ctx: HandleCtx, rowId: string): Promise<Reply[]> {
  const row = await getBangKe(ctx.db, rowId);
  if (!row || row.status !== "DRAFT") return [{ text: "Dòng bảng kê không còn ở trạng thái nháp." }];
  const text = bangKeAsText(row);
  const pctx = await loadParseCtx(ctx.db, ctx.today);
  const parsed = parseMessage(text, pctx);
  const kind: WriteIntent | null = KIND_INTENT[row.kind] ?? (isWriteIntent(parsed.intent) ? parsed.intent : null);
  if (!kind) return [{ text: "Chưa rõ dòng này là bán, nhập hay thu chi — chọn Loại rồi thử lại.", link: BANG_KE_LINK }];
  const userMsgId = await addMessage(ctx.db, ctx.conversationId, "USER", `Ghi thật dòng bảng kê: ${text}`);
  const turn = await startDraft(ctx, draftFromSlots(kind, parsed.slots, text), text, userMsgId, row.id);
  await saveBot(ctx, turn);
  return turn.replies;
}
