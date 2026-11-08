/**
 * Trợ lý — phân tích một câu nhắn: trích ô thông tin → chấm điểm intent → luật bổ sung khi câu chỉ có mã / tên.
 */
import { extractSlots, type ExtractCtx, type Slots } from "./extract";
import { MIN_SCORE, scoreIntents, type Intent } from "./intents";
import { fold, isQuestion } from "./normalize";

export interface Parsed {
  intent: Intent;
  score: number;
  /** intent điểm sát intent chọn (để hỏi lại khi mơ hồ) */
  alternatives: Intent[];
  slots: Slots;
  question: boolean;
}

export type ParseCtx = ExtractCtx;

/** Câu có ô thông tin dùng được để sửa phiếu đang chờ (giá, ngày, khách…) */
export function hasEditableSlots(s: Slots): boolean {
  return !!(
    s.money.length ||
    s.usd.length ||
    s.date ||
    s.phone ||
    s.customerName ||
    s.channel ||
    s.payment ||
    s.accountHints.length ||
    s.warrantyMonths !== undefined ||
    s.codes.length ||
    s.einvoiceNo ||
    s.directShip ||
    s.note ||
    s.variantIds.length
  );
}

export function parseMessage(text: string, ctx: ParseCtx): Parsed {
  const slots = extractSlots(text, ctx);
  const question = isQuestion(text);
  const scored = scoreIntents(text, slots);
  const top = scored[0];
  let intent: Intent = top && top.score >= MIN_SCORE ? top.intent : "UNKNOWN";
  let score = top?.score ?? 0;
  const restWords = fold(slots.rest)
    .split(/\s+/)
    .filter((w) => w && !/^(may|con|cai|chiec|xem|tra|cho|minh|em|anh|chi|nay|nhe|nha|voi|thong|tin|cua|la|gi|sao|the|nao|\?)$/.test(w));

  // câu chỉ có mã: IMEI / Serial → tra máy · BH-… → xem đơn · CH-… → chuyến · vận đơn → kiện · SĐT / tên → khách
  if (intent === "UNKNOWN" || (score < 5 && !question && restWords.length <= 1)) {
    if (slots.saleCode && !slots.money.length) intent = "SALE_LOOKUP";
    else if (slots.batchCode && !slots.money.length && !slots.usd.length) intent = "BATCH";
    else if (slots.tracking && !slots.money.length) intent = "SHIPMENTS";
    else if (slots.codes.length && !slots.money.length && intent === "UNKNOWN") intent = "ITEM_LOOKUP";
    else if ((slots.phone || slots.customerName) && !slots.money.length && intent === "UNKNOWN") intent = "CUSTOMER_LOOKUP";
    else if (intent === "UNKNOWN" && slots.variantIds.length && !slots.money.length) intent = "STOCK";
  }
  // bán mà có tiền cọc → cọc; có số hoá đơn + mã đơn → ghi số hoá đơn
  if (intent === "SALE" && slots.money.some((m) => m.role === "deposit")) intent = "DEPOSIT";
  if ((intent === "SALE_LOOKUP" || intent === "SALE") && slots.einvoiceNo && slots.saleCode) intent = "EINVOICE";
  // "trả thêm 3tr" kèm mã đơn → thu tiền đơn
  if ((intent === "SALE" || intent === "DEPOSIT") && slots.saleCode && slots.money.some((m) => m.role === "paid")) intent = "PAYMENT";
  // hỏi lãi / giá vốn kèm IMEI → tra máy
  if ((intent === "REVENUE" || intent === "STOCK") && slots.codes.length) intent = "ITEM_LOOKUP";
  // "doanh thu năm / ngưỡng thuế"
  if (intent === "REVENUE" && slots.period?.ky === "nam" && /thue|nguong/.test(fold(text))) intent = "TAX";
  if (intent !== (top?.intent ?? "UNKNOWN")) score = Math.max(score, MIN_SCORE);

  const alternatives = scored
    .filter((s) => s.intent !== intent && s.score >= MIN_SCORE && s.score >= score - 1)
    .map((s) => s.intent)
    .slice(0, 3);
  return { intent, score, alternatives, slots, question };
}
