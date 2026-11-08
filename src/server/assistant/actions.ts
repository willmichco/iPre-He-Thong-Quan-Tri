/**
 * Trợ lý — từ bản nháp → tra CSDL → phiếu xem trước (kèm cảnh báo, điều kiện chặn, câu hỏi còn thiếu); và khi người dùng
 * bấm Xác nhận → gọi ĐÚNG dịch vụ của form tay (createSale, saveManualEntry, saveCost, appendItems…) với dữ liệu đã kiểm
 * qua cùng lược đồ zod. Bot không có đường ghi riêng nên không thể ghi khác form tay.
 */
import type { Sql, TransactionSql } from "postgres";
import type { z } from "zod";
import { dmy } from "@/domain/assistant/dates";
import { COST_KIND_BY_LEG, type Choice, type Draft, type DraftLine } from "@/domain/assistant/drafts";
import { ACCOUNT_ALIASES } from "@/domain/assistant/extract";
import { formatVnd, shortVnd } from "@/domain/assistant/money";
import { fold } from "@/domain/assistant/normalize";
import type { Chip, PreviewCard } from "@/domain/assistant/reply";
import { validate } from "@/domain/catalog";
import { CostingError } from "@/domain/costing";
import { COST_KIND_LABEL, costSchema } from "@/domain/costs";
import { checkCustomer, normalizePhone } from "@/domain/customers";
import { checkManualEntry, checkTransfer } from "@/domain/ledger";
import { formatBp } from "@/domain/overview";
import { emptyRow, validateGrid, type GridRow } from "@/domain/purchasing-core";
import { CHANNEL_LABEL, previewSale, saleSchema, type Channel } from "@/domain/sales";
import { CostingServiceError } from "@/server/costing/service";
import { CostError, saveCost } from "@/server/costs/service";
import { CustomerError, saveCustomer } from "@/server/customers/service";
import { createTransfer, LedgerError, listAccountBalances, listCategories, saveManualEntry } from "@/server/ledger/service";
import { appendItems, PurchasingError, variantRefs } from "@/server/purchasing/service";
import { addPayment, completeSale, createSale, findItemForSale, SaleError, setEinvoiceNo, setTargetPrice, type SellableItem } from "@/server/sales/service";
import { findCustomers } from "./queries";
import { findBatchByCode, findSaleByCode, findShipmentByCode, itemDates, itemsByPartialCode, openSalesOfCustomer, purchaseOrdersFor, sellableOfVariant } from "./lookups";

type Db = Sql | TransactionSql;

export interface BuildCtx {
  today: string;
}

export type CardBody = Omit<PreviewCard, "kind" | "actionId" | "status">;

export interface Built {
  draft: Draft;
  card: CardBody;
  /** còn thiếu thông tin hỏi được ngay → bot hỏi (phiếu vẫn chờ) */
  ask?: { question: string; chips?: Chip[] };
  /** không tra ra được (máy chưa có, không khớp dòng máy…) → đưa vào bảng kê nháp */
  unresolvable?: string;
}

export interface Executed {
  type: string;
  id: string;
  href: string;
  summary: string;
  customerId?: string | null;
}

/** Lỗi nghiệp vụ → câu tiếng Việt (giống form tay). */
export function errorText(e: unknown): string {
  if (e instanceof AssistantInputError) return e.message;
  if (
    e instanceof SaleError ||
    e instanceof LedgerError ||
    e instanceof CostError ||
    e instanceof CustomerError ||
    e instanceof PurchasingError ||
    e instanceof CostingServiceError ||
    e instanceof CostingError
  ) {
    const rows = (e as { rowErrors?: { message: string }[] }).rowErrors;
    return rows?.length ? `${e.message}: ${rows.map((r) => r.message).join("; ")}` : e.message;
  }
  console.error("[tro-ly]", e instanceof Error ? e.name : "lỗi");
  return "Lỗi hệ thống — chưa ghi được. Thử lại hoặc mở form tay.";
}

export class AssistantInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantInputError";
  }
}

function mustParse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = validate(schema, data);
  if (!r.ok) throw new AssistantInputError(`Kiểm tra lại: ${[...new Set(Object.values(r.errors))].join("; ")}`);
  return r.data;
}

const noonVn = (d: string) => new Date(`${d}T12:00:00+07:00`);
/** thời điểm ghi: hôm nay = bây giờ; ngày khác = 12:00 trưa giờ VN của ngày đó */
export const atOf = (date: string | undefined, today: string) => (!date || date === today ? new Date() : noonVn(date));
const big = (s: string | undefined) => (s ? BigInt(s) : 0n);
const payLabel: Record<string, string> = { TRANSFER: "Chuyển khoản", CASH: "Tiền mặt", DEPOSIT: "Đặt cọc", UNPAID: "Ghi nợ" };

// ---- tài khoản ----------------------------------------------------------------------------------------

interface Acc {
  id: string;
  name: string;
  kind: string;
  currency: string;
}
async function activeAccounts(db: Db): Promise<Acc[]> {
  return db<Acc[]>`SELECT id::text, name, kind::text, currency::text FROM accounts WHERE is_active ORDER BY (kind <> 'BANK'), name`;
}
function matchAccounts(accs: readonly Acc[], hints: readonly string[]): Acc[] {
  const out = new Set<Acc>();
  for (const h of hints) {
    const aliases = ACCOUNT_ALIASES[h] ?? [h];
    for (const a of accs) {
      const n = fold(a.name);
      if (
        aliases.some((x) => n.includes(x)) ||
        n === h ||
        ((h === "tien mat" || aliases.includes("cash")) && a.kind === "CASH") ||
        ((h === "the" || h === "visa") && a.kind === "CARD") ||
        (h === "ngan hang" && a.kind === "BANK")
      )
        out.add(a);
    }
  }
  return [...out];
}
/** Chọn tài khoản: theo từ gợi ý → theo cách trả (tiền mặt → quỹ tiền mặt) → tài khoản VND đầu tiên (ngân hàng trước). */
function pickAccount(accs: readonly Acc[], hints: readonly string[] | undefined, payment: string | undefined, currency = "VND") {
  const pool = accs.filter((a) => a.currency === currency);
  const warn: string[] = [];
  if (hints?.length) {
    const m = matchAccounts(pool, hints);
    if (m.length === 1) return { acc: m[0], warn, choices: null };
    if (m.length > 1) return { acc: null, warn, choices: m };
    warn.push(`Không thấy tài khoản "${hints.join(", ")}" — dùng tài khoản mặc định, sửa bằng "sửa tk …"`);
  }
  if (payment === "CASH") {
    const cash = pool.filter((a) => a.kind === "CASH");
    if (cash.length) return { acc: cash[0], warn, choices: null };
    warn.push("Chưa có tài khoản tiền mặt — tạo ở Danh mục › Tài khoản, hoặc chọn tài khoản khác");
  }
  return { acc: pool.find((a) => a.kind !== "CASH" || payment === "CASH") ?? pool[0] ?? null, warn, choices: null };
}
const accChoices = (field: string, list: readonly Acc[]) => ({ field, options: list.map((a) => ({ value: a.id, label: a.name })) });

// ---- ngày ---------------------------------------------------------------------------------------------

/** Ngày ghi: trong tương lai → chặn; tháng trước / quá 60 ngày / trước ngày đối soát → cảnh báo. */
async function dateChecks(db: Db, date: string, today: string, accountId: string | null, warnings: string[], blockers: string[]) {
  if (date > today) {
    blockers.push(`Ngày ${dmy(date)} ở tương lai — sửa ngày (vd "sửa ngày hôm nay")`);
    return;
  }
  if (date === today) return;
  const days = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
  if (days > 60) warnings.push(`Ghi lùi ${days} ngày (${dmy(date)})`);
  if (date.slice(0, 7) < today.slice(0, 7)) warnings.push(`Ghi vào tháng ${date.slice(5, 7)}/${date.slice(0, 4)} — kiểm tra kỳ đã kê khai thuế chưa`);
  if (accountId) {
    const acc = (await listAccountBalances(db)).find((a) => a.id === accountId);
    const rec = acc?.lastReconciliation?.asOf;
    if (rec && date <= rec) warnings.push(`Tài khoản ${acc!.name} đã đối soát tới ${dmy(rec)} — ghi trước ngày này sẽ làm lệch số đối soát`);
  }
}

// ---- khách --------------------------------------------------------------------------------------------

interface CustomerPick {
  id: string | null;
  name: string | null;
  phone: string | null;
  isNew: boolean;
  choices?: { field: string; options: Choice[] };
  warn?: string;
}
async function pickCustomer(db: Db, d: Draft): Promise<CustomerPick> {
  if (d.customerId) {
    const [c] = await db<{ id: string; full_name: string; phone: string | null }[]>`
      SELECT id::text, full_name, phone FROM customers WHERE id = ${d.customerId} AND deleted_at IS NULL`;
    if (c) return { id: c.id, name: c.full_name, phone: c.phone, isNew: false };
  }
  if (d.phone) {
    const phone = normalizePhone(d.phone) ?? d.phone;
    const [c] = await db<{ id: string; full_name: string }[]>`SELECT id::text, full_name FROM customers WHERE phone = ${phone} AND deleted_at IS NULL LIMIT 1`;
    if (c) {
      const warn = d.customerName && fold(c.full_name) !== fold(d.customerName) ? `SĐT ${phone} đã là của khách "${c.full_name}" — đơn ghi cho khách này` : undefined;
      return { id: c.id, name: c.full_name, phone, isNew: false, warn };
    }
    return { id: null, name: d.customerName ?? null, phone, isNew: true };
  }
  if (d.customerName && !d.forceNewCustomer) {
    const found = await findCustomers(db, { customerName: d.customerName });
    if (found.length === 1) return { id: found[0].id, name: found[0].fullName, phone: found[0].phone, isNew: false };
    if (found.length > 1)
      return {
        id: null,
        name: d.customerName,
        phone: null,
        isNew: false,
        choices: {
          field: "customerId",
          options: [
            ...found.slice(0, 6).map((c) => ({ value: c.id, label: `${c.fullName}${c.phone ? ` · ${c.phone}` : ""}` })),
            { value: "NEW", label: `Khách mới "${d.customerName}"` },
          ],
        },
      };
    return { id: null, name: d.customerName, phone: null, isNew: true };
  }
  if (d.customerName) return { id: null, name: d.customerName, phone: null, isNew: true };
  return { id: null, name: null, phone: null, isNew: false };
}
const customerRow = (c: CustomerPick): [string, string] => [
  "Khách",
  c.name || c.phone ? `${c.name ?? `Khách ${c.phone!.slice(-4)}`}${c.phone ? ` · ${c.phone}` : ""}${c.isNew ? " (khách mới)" : ""}` : "Khách lẻ",
];

// ---- dựng phiếu ---------------------------------------------------------------------------------------

export async function buildDraft(db: Db, input: Draft, ctx: BuildCtx): Promise<Built> {
  const d: Draft = structuredClone(input);
  switch (d.kind) {
    case "SALE":
    case "DEPOSIT":
      return buildSale(db, d, ctx);
    case "PAYMENT":
    case "COMPLETE_DEPOSIT":
      return buildPayment(db, d, ctx);
    case "PURCHASE_ITEMS":
      return buildPurchase(db, d, ctx);
    case "LEDGER_ENTRY":
      return buildLedger(db, d, ctx);
    case "LANDED_COST":
      return buildCost(db, d, ctx);
    case "TRANSFER":
      return buildTransfer(db, d, ctx);
    case "CUSTOMER":
      return buildCustomer(db, d);
    case "EINVOICE":
      return buildEinvoice(db, d);
    case "TARGET_PRICE":
      return buildTargetPrice(db, d);
  }
}

const ask = (d: Draft, field: string, question: string, card: CardBody, chips: Chip[] = []): Built => {
  d.asked = field;
  return { draft: d, card, ask: { question, chips } };
};
const choose = (d: Draft, field: string, options: Choice[], question: string, card: CardBody): Built => {
  d.choices = { field, options };
  d.asked = field;
  return { draft: d, card, ask: { question, chips: [] } };
};

/** Một dòng máy: tra theo mã / vài số cuối / cấu hình (FIFO: tồn lâu nhất trước). */
type LineResult =
  | { t: "error"; msg: string }
  | { t: "unresolvable"; msg: string }
  | { t: "choices"; options: Choice[] }
  | { t: "variantChoices"; options: Choice[] }
  | { t: "missing" }
  | { t: "item"; item: SellableItem; fifo: number };
async function resolveLine(db: Db, l: DraftLine, d: Draft, taken: Set<string>, refs: Awaited<ReturnType<typeof variantRefs>>): Promise<LineResult> {
  if (l.code && l.codeKind === "IMEI_BAD") return { t: "error", msg: `IMEI ${l.code} sai số kiểm tra (chữ số cuối) — gõ lại IMEI đúng` };
  if (l.code && l.codeKind === "PARTIAL") {
    const cands = (await itemsByPartialCode(db, l.code)).filter((c) => !["SOLD", "RETURNED_TO_SELLER", "LOST", "DAMAGED", "PERSONAL_USE"].includes(c.status));
    if (!cands.length) return { t: "unresolvable", msg: `Không thấy máy nào có Serial / IMEI chứa "${l.code}"` };
    if (cands.length > 1)
      return { t: "choices", options: cands.map((c) => ({ value: c.serial_number ?? c.imei1 ?? "", label: `${c.label} · ${c.serial_number ?? c.imei1}` })) };
    l.code = cands[0].serial_number ?? cands[0].imei1 ?? l.code;
    l.codeKind = cands[0].serial_number ? "SERIAL" : "IMEI";
  }
  if (l.code) {
    const it = await findItemForSale(db, l.code);
    if (!it) return { t: "unresolvable", msg: `Máy ${l.code} chưa có trong hệ thống` };
    return { t: "item", item: it, fifo: 0 };
  }
  const vids = d.variantIds ?? [];
  if (!vids.length) return { t: "missing" };
  if (vids.length > 1) return { t: "variantChoices", options: vids.map((id) => ({ value: id, label: refs.find((r) => r.id === id)?.label ?? id })) };
  const cands = (await sellableOfVariant(db, vids[0], 40)).filter((c) => !taken.has(c.id));
  const label = refs.find((r) => r.id === vids[0])?.label ?? d.productText ?? "dòng này";
  if (!cands.length) return { t: "unresolvable", msg: `Hết máy ${label} để bán` };
  const pick = cands.find((c) => c.arrived) ?? cands[0];
  const code = pick.serial_number ?? pick.imei1;
  if (!code) return { t: "unresolvable", msg: `Máy ${label} chưa có Serial / IMEI — bán ở form tay` };
  const it = await findItemForSale(db, code);
  if (!it) return { t: "unresolvable", msg: `Không tra được máy ${code}` };
  l.code = code;
  l.codeKind = pick.serial_number ? "SERIAL" : "IMEI";
  return { t: "item", item: it, fifo: cands.length };
}

async function buildSale(db: Db, d: Draft, ctx: BuildCtx): Promise<Built> {
  const deposit = d.kind === "DEPOSIT";
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const extra: Pick<CardBody, "profit"> = {};
  const card = (): CardBody => ({ title: deposit ? "Phiếu đặt cọc" : "Phiếu bán hàng", rows, warnings, blockers, ...extra });
  const refs = await variantRefs(db);
  if (!d.lines?.length) d.lines = [{}];
  const items: SellableItem[] = [];
  const taken = new Set<string>();
  for (let k = 0; k < d.lines.length; k++) {
    const l = d.lines[k];
    const r = await resolveLine(db, l, d, taken, refs);
    if (r.t === "error") return ask(d, `line:${k}`, r.msg, card(), [{ label: "Đưa vào bảng kê nháp", text: "để sau" }]);
    if (r.t === "unresolvable") return { draft: d, card: card(), unresolvable: r.msg };
    if (r.t === "missing") return ask(d, `line:${k}`, "Bán máy nào? Gõ IMEI / Serial / vài số cuối (vd: đuôi 5672), hoặc dòng máy (vd: pro max 256).", card());
    if (r.t === "choices") return choose(d, `line:${k}`, r.options, `Có ${r.options.length} máy khớp "${l.code}" — chọn máy:`, card());
    if (r.t === "variantChoices") return choose(d, "variantId", r.options, `"${d.productText}" khớp nhiều cấu hình — chọn cấu hình:`, card());
    const it = r.item;
    if (taken.has(it.id)) {
      blockers.push(`Máy ${l.code} bị nhập 2 lần`);
      continue;
    }
    taken.add(it.id);
    l.itemId = it.id;
    l.label = it.label;
    items.push(it);
    if (r.fifo > 1) warnings.push(`Chọn máy tồn lâu nhất của ${it.label} (${l.code}) — còn ${r.fifo - 1} máy khác; muốn máy khác thì gõ IMEI / Serial`);
    rows.push([d.lines.length > 1 ? `Máy ${k + 1}` : "Máy", `${it.label} · ${it.serial ?? ""}${it.imei1 ? ` · IMEI ${it.imei1}` : ""}`]);
    if (it.sellable === "NO") blockers.push(it.reason ?? `Máy ${l.code} không bán được`);
    if (it.sellable === "DEPOSIT_ONLY" && !deposit && !d.directShip)
      blockers.push(`Máy ${l.code} chưa về SG — chuyển thành cọc, hoặc xác nhận bán giao thẳng`);
    if (it.hasEstimate) warnings.push(`Giá vốn máy ${l.code} còn tạm tính (chuyến chưa chốt chi phí)`);
  }
  // giá
  const missingPrice = d.lines.findIndex((l) => !l.price);
  if (missingPrice >= 0) {
    const it = items[missingPrice];
    const chips: Chip[] = [];
    if (it?.targetPriceVnd) chips.push({ label: `${shortVnd(it.targetPriceVnd)} (giá mục tiêu)`, text: String(it.targetPriceVnd) });
    if (it) chips.push({ label: `Giá vốn ${shortVnd(it.costVnd)} + 1tr`, text: String(it.costVnd + 1_000_000n) });
    return ask(d, "price", `Giá bán ${d.lines.length > 1 ? `máy ${missingPrice + 1} ` : ""}bao nhiêu? (vd 25tr5)`, card(), chips);
  }
  for (const l of d.lines) if (l.priceAlt) warnings.push(`Hiểu giá là ${formatVnd(BigInt(l.price!))} — nếu ý là ${formatVnd(BigInt(l.priceAlt))} thì gõ "sửa giá ${BigInt(l.priceAlt).toString()}"`);
  const total = d.lines.reduce((a, l) => a + BigInt(l.price!), 0n);
  rows.push(["Giá bán", d.lines.length > 1 ? `${d.lines.map((l) => shortVnd(BigInt(l.price!))).join(" + ")} = ${formatVnd(total)}` : formatVnd(total)]);
  if (d.discount) rows.push(["Giảm giá", formatVnd(big(d.discount))]);
  if (d.shippingFee) rows.push(["Ship cho khách (shop trả)", formatVnd(big(d.shippingFee))]);
  const pv = previewSale(
    items.map((it, k) => ({ itemId: it.id, priceVnd: BigInt(d.lines![k].price!), costVnd: it.costVnd })),
    big(d.discount),
    d.shippingFee ? [big(d.shippingFee)] : [],
  );
  rows.push(["Giá vốn", formatVnd(pv.costVnd)]);
  extra.profit = { value: `${pv.profitVnd < 0n ? "−" : ""}${formatVnd(pv.profitVnd < 0n ? -pv.profitVnd : pv.profitVnd)}`, margin: pv.marginBp === null ? null : formatBp(pv.marginBp), negative: pv.profitVnd < 0n, provisional: items.some((i) => i.hasEstimate) };
  if (pv.belowCost.length && !deposit) warnings.push(`Bán DƯỚI giá vốn ${pv.belowCost.length} máy — bấm Xác nhận là đồng ý bán lỗ`);

  // khách
  const c = await pickCustomer(db, d);
  if (c.choices) return choose(d, c.choices.field, c.choices.options, `Có nhiều khách tên "${d.customerName}" — chọn khách:`, card());
  if (c.id) d.customerId = c.id;
  if (c.warn) warnings.push(c.warn);
  rows.push(customerRow(c));
  if (deposit && !c.name && !c.phone) return ask(d, "customer", "Khách cọc tên gì / SĐT bao nhiêu? (vd: chị Lan 0901234567)", card());
  if (!c.isNew && c.id && !d.phone && d.customerName && fold(c.name ?? "") !== fold(d.customerName))
    warnings.push(`Khớp khách cũ "${c.name}" — nếu là khách mới, gõ "sửa sđt <số của khách>"`);
  rows.push(["Kênh", CHANNEL_LABEL[(d.channel ?? "OTHER") as Channel] ?? "Khác"]);

  // tiền nhận
  if (deposit && !d.deposit) return ask(d, "deposit", `Khách cọc bao nhiêu? (giá đơn ${shortVnd(total - big(d.discount))})`, card(), [{ label: "Cọc 1tr", text: "cọc 1tr" }, { label: "Cọc 3tr", text: "cọc 3tr" }, { label: "Cọc 5tr", text: "cọc 5tr" }]);
  const payment = deposit ? "DEPOSIT" : (d.payment ?? "TRANSFER");
  d.payment = payment;
  const needsAccount = payment !== "UNPAID" || !!d.paid;
  const net = total - big(d.discount);
  const received = deposit ? big(d.deposit) : payment === "UNPAID" ? big(d.paid) : d.paid ? big(d.paid) : net;
  if (received > net) blockers.push(`Số tiền nhận ${formatVnd(received)} lớn hơn tổng đơn ${formatVnd(net)}`);
  rows.push(["Thanh toán", deposit ? `Cọc ${formatVnd(received)} · còn lại ${formatVnd(net - received)} khi giao` : payment === "UNPAID" ? `Ghi nợ${received ? ` · đã nhận ${formatVnd(received)}` : ""} · còn nợ ${formatVnd(net - received)}` : `${payLabel[payment]} ${formatVnd(received)}${received < net ? ` · còn nợ ${formatVnd(net - received)}` : ""}`]);
  if (needsAccount) {
    const accs = await activeAccounts(db);
    const p = d.accountId ? { acc: accs.find((a) => a.id === d.accountId) ?? null, warn: [], choices: null } : pickAccount(accs, d.accountHints, payment);
    if (p.choices) return choose(d, "accountId", accChoices("accountId", p.choices).options, "Nhận tiền vào tài khoản nào?", card());
    if (!p.acc) blockers.push("Chưa có tài khoản VND để nhận tiền — tạo ở Danh mục › Tài khoản");
    else {
      d.accountId = p.acc.id;
      rows.push(["Tài khoản nhận", p.acc.name]);
    }
    warnings.push(...p.warn);
  }
  // ngày
  const date = d.date ?? ctx.today;
  rows.push(["Ngày", `${dmy(date)}${date === ctx.today ? " (hôm nay)" : ""}`]);
  await dateChecks(db, date, ctx.today, d.accountId ?? null, warnings, blockers);
  if (date < ctx.today && items.length) {
    const dates = await itemDates(
      db,
      items.map((i) => i.id),
    );
    for (const x of dates) {
      const code = d.lines.find((l) => l.itemId === x.id)?.code;
      if (!deposit && !d.directShip && x.sg && date < x.sg) blockers.push(`Máy ${code} về SG ngày ${dmy(x.sg)} — không bán trước ngày đó được`);
      if ((deposit || d.directShip) && x.ordered && date < x.ordered) blockers.push(`Máy ${code} đặt mua ngày ${dmy(x.ordered)} — không bán / cọc trước ngày đó được`);
    }
    if (date.slice(0, 4) < ctx.today.slice(0, 4)) warnings.push(`Đơn ghi vào năm ${date.slice(0, 4)} — mã đơn mang số năm đó (BH-${date.slice(0, 4)}-…)`);
  }
  if (!deposit) rows.push(["Bảo hành", d.warrantyMonths === 0 ? "Không bảo hành" : `${d.warrantyMonths ?? 6} tháng`]);
  if (d.directShip) rows.push(["Giao", "Bán giao thẳng (máy chưa về SG)"]);
  if (d.einvoiceNo) rows.push(["Số hoá đơn", d.einvoiceNo]);
  if (d.note) rows.push(["Ghi chú", d.note]);
  return { draft: d, card: card() };
}

async function buildPayment(db: Db, d: Draft, ctx: BuildCtx): Promise<Built> {
  const complete = d.kind === "COMPLETE_DEPOSIT";
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: complete ? "Hoàn tất đơn cọc" : "Thu thêm tiền đơn bán", rows, warnings, blockers });
  // đơn
  let sale = d.saleId ? await findSaleById(db, d.saleId) : d.saleCode ? await findSaleByCode(db, d.saleCode) : null;
  if (d.saleCode && !sale) return { draft: d, card: card(), unresolvable: `Không thấy đơn ${d.saleCode}` };
  if (!sale) {
    const c = await pickCustomer(db, d);
    if (c.choices) return choose(d, "customerId", c.choices.options.filter((o) => o.value !== "NEW"), `Có nhiều khách tên "${d.customerName}" — chọn khách:`, card());
    if (!c.id) return ask(d, "sale", "Đơn nào? Gõ mã đơn (BH-2026-…) hoặc tên / SĐT khách.", card());
    const open = await openSalesOfCustomer(db, c.id, complete);
    if (!open.length) return { draft: d, card: card(), unresolvable: complete ? `${c.name} không có đơn cọc nào đang mở` : `${c.name} không còn nợ đơn nào` };
    if (open.length > 1)
      return choose(d, "saleId", open.map((o) => ({ value: o.id, label: `${o.code} · ${o.items} · còn ${shortVnd(o.balanceVnd)}` })), "Khách có nhiều đơn — chọn đơn:", card());
    sale = open[0];
  }
  d.saleId = sale.id;
  d.saleCode = sale.code;
  if (sale.customerId) d.customerId = sale.customerId;
  rows.push(["Đơn", `${sale.code} · ${sale.items}`], ["Khách", sale.customer ?? "Khách lẻ"], ["Tổng đơn", formatVnd(sale.revenueVnd)], ["Còn nợ", formatVnd(sale.balanceVnd)]);
  if (complete && sale.status !== "DEPOSITED") blockers.push(`Đơn ${sale.code} không phải đơn đang cọc`);
  if (!complete && sale.status === "CANCELLED") blockers.push(`Đơn ${sale.code} đã huỷ`);
  const amount = complete ? (d.amount ? BigInt(d.amount) : sale.balanceVnd) : d.amount ? BigInt(d.amount) : null;
  if (!complete && amount === null)
    return ask(d, "amount", `Khách trả bao nhiêu? (còn nợ ${formatVnd(sale.balanceVnd)})`, card(), [{ label: `Trả đủ ${shortVnd(sale.balanceVnd)}`, text: String(sale.balanceVnd) }]);
  if (amount !== null && amount > sale.balanceVnd) blockers.push(`Khách chỉ còn nợ ${formatVnd(sale.balanceVnd)}`);
  if (amount !== null && amount > 0n) {
    d.amount = amount.toString();
    rows.push([complete ? "Thu khi giao" : "Thu thêm", formatVnd(amount)]);
    const accs = await activeAccounts(db);
    const p = d.accountId ? { acc: accs.find((a) => a.id === d.accountId) ?? null, warn: [], choices: null } : pickAccount(accs, d.accountHints, d.payment);
    if (p.choices) return choose(d, "accountId", accChoices("accountId", p.choices).options, "Nhận tiền vào tài khoản nào?", card());
    if (!p.acc) blockers.push("Chưa có tài khoản VND để nhận tiền");
    else {
      d.accountId = p.acc.id;
      rows.push(["Tài khoản nhận", p.acc.name]);
    }
    warnings.push(...p.warn);
  }
  if (complete) {
    rows.push(["Bảo hành", d.warrantyMonths === 0 ? "Không bảo hành" : `${d.warrantyMonths ?? 6} tháng`]);
    if (d.directShip) rows.push(["Giao", "Bán giao thẳng (máy chưa về SG)"]);
  }
  const date = d.date ?? ctx.today;
  rows.push(["Ngày", `${dmy(date)}${date === ctx.today ? " (hôm nay)" : ""}`]);
  await dateChecks(db, date, ctx.today, d.accountId ?? null, warnings, blockers);
  return { draft: d, card: card() };
}

async function findSaleById(db: Db, id: string) {
  const [r] = await db<{ code: string }[]>`SELECT code FROM sales WHERE id = ${id}`;
  return r ? findSaleByCode(db, r.code) : null;
}

async function buildPurchase(db: Db, d: Draft, ctx: BuildCtx): Promise<Built> {
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: "Nhập máy vào đơn mua", rows, warnings, blockers });
  const refs = await variantRefs(db);
  // đơn mua
  const pos = await purchaseOrdersFor(db, d.batchCode);
  if (d.batchCode && !(await findBatchByCode(db, d.batchCode))) return { draft: d, card: card(), unresolvable: `Không thấy chuyến ${d.batchCode} — tạo chuyến / đơn mua ở trang Chuyến hàng trước` };
  let po = pos.find((p) => p.id === d.purchaseOrderId);
  if (!po) {
    if (!pos.length) return { draft: d, card: card(), unresolvable: d.batchCode ? `Chuyến ${d.batchCode} chưa có đơn mua` : "Chưa có đơn mua nào đang mở — tạo đơn mua ở trang Chuyến hàng trước" };
    if (pos.length > 1 || !d.batchCode)
      return choose(d, "purchaseOrderId", pos.map((p) => ({ value: p.id, label: `${p.batchCode} · ${p.label} · ${dmy(p.orderedAt)} · ${p.currency}` })), "Nhập vào đơn mua nào?", card());
    po = pos[0];
  }
  d.purchaseOrderId = po.id;
  d.batchCode = po.batchCode;
  rows.push(["Đơn mua", `${po.batchCode} · ${po.label} · ${po.currency}`]);
  // cấu hình
  if (!d.variantId) {
    const vids = d.variantIds ?? [];
    if (vids.length > 1) return choose(d, "variantId", vids.map((id) => ({ value: id, label: refs.find((r) => r.id === id)?.label ?? id })), `"${d.productText}" khớp nhiều cấu hình — chọn:`, card());
    if (!vids.length) return ask(d, "variant", "Máy cấu hình gì? (vd: pro max 256 silver)", card());
    d.variantId = vids[0];
  }
  const variant = refs.find((r) => r.id === d.variantId);
  if (!variant) return { draft: d, card: card(), unresolvable: "Không thấy cấu hình máy — thêm ở Danh mục › Mã máy" };
  rows.push(["Cấu hình", variant.label]);
  // đơn giá theo tiền tệ đơn mua
  const codes = d.codes ?? [];
  const n = codes.length || d.qty || 1;
  const priceOf = (c?: { usd?: string; vnd?: string }) => (po!.currency === "USD" ? (c?.usd ?? d.usd) : (c?.vnd ?? d.amount));
  if (!priceOf(codes[0])) {
    if (po.currency === "USD" && d.amount && !d.usd)
      return ask(d, "usd", `Đơn mua tính bằng USD — đơn giá bao nhiêu đô? (vd $999). Số ${shortVnd(BigInt(d.amount))} là VND.`, card());
    return ask(d, "price", `Đơn giá mỗi máy bao nhiêu ${po.currency === "USD" ? "USD (vd $999)" : "VND (vd 25tr)"}?`, card());
  }
  const grid: GridRow[] = [];
  for (let k = 0; k < n; k++) {
    const c = codes[k];
    grid.push({
      ...emptyRow(),
      variantId: variant.id,
      unitPrice: priceOf(c) ?? "",
      serial: c && c.kind === "SERIAL" ? c.value : "",
      imei1: c && c.kind !== "SERIAL" ? c.value : "",
      weightKg: variant.defaultWeightKg ?? "",
    });
  }
  const v = validateGrid(grid, refs);
  for (const i of v.issues) (i.severity === "error" ? blockers : warnings).push(`Dòng ${i.row + 1}: ${i.message}`);
  const dup = await db<{ code: string }[]>`
    SELECT COALESCE(serial_number, imei1) AS code FROM items WHERE deleted_at IS NULL
       AND (serial_number = ANY(${codes.map((c) => c.value)}) OR imei1 = ANY(${codes.map((c) => c.value)}) OR imei2 = ANY(${codes.map((c) => c.value)}))`;
  for (const x of dup) blockers.push(`Máy ${x.code} đã có trong hệ thống`);
  rows.push(["Số máy", `${n}${codes.length ? `: ${codes.map((c) => c.value).join(", ")}` : " (chưa có IMEI / Serial)"}`]);
  if (!codes.length) warnings.push("Chưa có IMEI / Serial — bổ sung ở lưới nhập máy khi hàng về (hoặc quét mã)");
  const prices = [...new Set(grid.map((g) => g.unitPrice))];
  rows.push(["Đơn giá", prices.map((p) => (po!.currency === "USD" ? `$${p}` : formatVnd(BigInt(p.split(".")[0])))).join(" / ")]);
  if (d.date) warnings.push("Ngày đặt mua lấy theo đơn mua — ngày trong tin không dùng cho máy nhập");
  void ctx;
  return { draft: d, card: card() };
}

async function buildLedger(db: Db, d: Draft, ctx: BuildCtx): Promise<Built> {
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: "Phiếu thu chi", rows, warnings, blockers });
  const cats = (await listCategories(db)).filter((c) => c.manual);
  let cat = cats.find((c) => c.code === d.categoryCode);
  if (!cat) {
    // danh mục người dùng tự tạo: khớp theo tên
    const f = fold(`${d.productText ?? ""} ${d.note ?? ""}`);
    cat = cats.find((c) => !c.isSystem && f.includes(fold(c.name)));
  }
  if (!cat)
    return choose(
      d,
      "categoryCode",
      cats.map((c) => ({ value: c.code, label: `${c.direction === "IN" ? "Thu" : "Chi"} · ${c.name}` })),
      "Khoản này thuộc danh mục nào?",
      card(),
    );
  d.categoryCode = cat.code;
  rows.push(["Danh mục", `${cat.direction === "IN" ? "Thu" : "Chi"} · ${cat.name}`]);
  if (!d.amount) return ask(d, "amount", `Số tiền bao nhiêu? (vd 2tr)`, card());
  const accs = await activeAccounts(db);
  const p = d.accountId ? { acc: accs.find((a) => a.id === d.accountId) ?? null, warn: [], choices: null } : pickAccount(accs, d.accountHints, d.payment);
  if (p.choices) return choose(d, "accountId", accChoices("accountId", p.choices).options, cat.direction === "IN" ? "Nhận vào tài khoản nào?" : "Chi từ tài khoản nào?", card());
  if (!p.acc) return { draft: d, card: card(), unresolvable: "Chưa có tài khoản nào — tạo ở Danh mục › Tài khoản" };
  d.accountId = p.acc.id;
  warnings.push(...p.warn);
  rows.push(["Số tiền", formatVnd(BigInt(d.amount))]);
  if (d.amountAlt) warnings.push(`Hiểu là ${formatVnd(BigInt(d.amount))} — nếu ý là ${formatVnd(BigInt(d.amountAlt))} thì gõ "sửa ${d.amountAlt}"`);
  rows.push([cat.direction === "IN" ? "Vào tài khoản" : "Từ tài khoản", p.acc.name]);
  if (p.acc.currency !== "VND") blockers.push(`Tài khoản ${p.acc.name} là ${p.acc.currency} — ghi ở Sổ thu chi (cần tỷ giá)`);
  const date = d.date ?? ctx.today;
  rows.push(["Ngày", `${dmy(date)}${date === ctx.today ? " (hôm nay)" : ""}`]);
  await dateChecks(db, date, ctx.today, d.accountId, warnings, blockers);
  if (d.counterparty) rows.push(["Đối tượng", d.counterparty]);
  if (d.note) rows.push(["Ghi chú", d.note]);
  return { draft: d, card: card() };
}

async function buildCost(db: Db, d: Draft, ctx: BuildCtx): Promise<Built> {
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: "Chi phí vào giá vốn", rows, warnings, blockers });
  // gắn vào đâu: kiện (vận đơn) → chuyến
  if (!d.target) {
    if (d.tracking) {
      const sh = await findShipmentByCode(db, d.tracking);
      if (!sh) return { draft: d, card: card(), unresolvable: `Chưa có kiện ${d.tracking} — thêm kiện ở trang Vận chuyển trước` };
      d.target = `SHIPMENT:${sh.id}`;
      d.targetLabel = `Kiện ${sh.label} (${sh.itemCount} máy)`;
      if (!d.costKind) d.costKind = COST_KIND_BY_LEG[sh.legType] ?? "OTHER_LANDED";
      if (!sh.itemCount) blockers.push(`Kiện ${sh.label} chưa có máy — gán máy vào kiện trước rồi mới chia chi phí được`);
    } else if (d.batchCode) {
      const b = await findBatchByCode(db, d.batchCode);
      if (!b) return { draft: d, card: card(), unresolvable: `Không thấy chuyến ${d.batchCode}` };
      d.target = `BATCH:${b.id}`;
      d.targetLabel = `Chuyến ${b.code}`;
    } else return ask(d, "target", "Chi phí này của kiện / chuyến nào? Gõ mã vận đơn hoặc mã chuyến (CH-2026-…).", card());
  }
  rows.push(["Gắn vào", d.targetLabel ?? d.target]);
  if (!d.costKind) {
    const opts = Object.entries(COST_KIND_LABEL).map(([value, label]) => ({ value, label }));
    return choose(d, "costKind", opts, "Loại chi phí nào?", card());
  }
  rows.push(["Loại", COST_KIND_LABEL[d.costKind as keyof typeof COST_KIND_LABEL] ?? d.costKind]);
  if (!d.amount && !d.usd) return ask(d, "amount", "Số tiền bao nhiêu? (vd 3tr5 hoặc $120)", card());
  rows.push(["Số tiền", d.usd ? `$${d.usd}` : formatVnd(BigInt(d.amount!))]);
  if (d.usd && !d.fxRate) blockers.push("Chi phí bằng USD cần tỷ giá — ghi ở form Chi phí của chuyến, hoặc nhắn số tiền VND");
  const date = d.date ?? ctx.today;
  rows.push(["Ngày phát sinh", dmy(date)]);
  if (date > ctx.today) blockers.push("Ngày ở tương lai");
  if (d.payment || d.accountHints?.length || d.accountId) {
    const accs = await activeAccounts(db);
    const p = d.accountId ? { acc: accs.find((a) => a.id === d.accountId) ?? null, warn: [], choices: null } : pickAccount(accs, d.accountHints, d.payment);
    if (p.choices) return choose(d, "accountId", accChoices("accountId", p.choices).options, "Trả từ tài khoản nào?", card());
    if (p.acc) {
      d.accountId = p.acc.id;
      rows.push(["Đã trả từ", p.acc.name]);
    }
    warnings.push(...p.warn);
  } else rows.push(["Thanh toán", "Chưa trả (vào công nợ phải trả) — gõ \"sửa tk …\" nếu đã trả"]);
  warnings.push("Giá vốn các máy liên quan sẽ được tính lại ngay khi ghi");
  return { draft: d, card: card() };
}

async function buildTransfer(db: Db, d: Draft, ctx: BuildCtx): Promise<Built> {
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: "Chuyển tiền nội bộ", rows, warnings, blockers });
  const accs = await activeAccounts(db);
  if (!d.fromAccountId) {
    const m = d.fromHints?.length ? matchAccounts(accs, d.fromHints) : [];
    if (m.length !== 1) return choose(d, "fromAccountId", accs.map((a) => ({ value: a.id, label: a.name })), "Chuyển TỪ tài khoản nào?", card());
    d.fromAccountId = m[0].id;
  }
  if (!d.accountId) {
    const m = d.accountHints?.length ? matchAccounts(accs, d.accountHints).filter((a) => a.id !== d.fromAccountId) : [];
    if (m.length !== 1) return choose(d, "accountId", accs.filter((a) => a.id !== d.fromAccountId).map((a) => ({ value: a.id, label: a.name })), "Chuyển SANG tài khoản nào?", card());
    d.accountId = m[0].id;
  }
  const from = accs.find((a) => a.id === d.fromAccountId);
  const to = accs.find((a) => a.id === d.accountId);
  if (!from || !to) return { draft: d, card: card(), unresolvable: "Không thấy tài khoản" };
  rows.push(["Từ", from.name], ["Sang", to.name]);
  if (from.id === to.id) blockers.push("Hai tài khoản trùng nhau");
  if (from.currency !== to.currency) blockers.push("Khác loại tiền — đổi ngoại tệ ở Sổ thu chi (cần tỷ giá)");
  if (!d.amount) return ask(d, "amount", "Chuyển bao nhiêu?", card());
  rows.push(["Số tiền", formatVnd(BigInt(d.amount))]);
  const date = d.date ?? ctx.today;
  rows.push(["Ngày", dmy(date)]);
  await dateChecks(db, date, ctx.today, from.id, warnings, blockers);
  return { draft: d, card: card() };
}

async function buildCustomer(db: Db, d: Draft): Promise<Built> {
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: "Thêm khách hàng", rows, warnings, blockers });
  if (!d.customerName) return ask(d, "customer", "Tên khách là gì? (vd: chị Lan 0901234567)", card());
  rows.push(["Tên", d.customerName]);
  if (d.phone) {
    rows.push(["SĐT", d.phone]);
    const [dup] = await db<{ full_name: string }[]>`SELECT full_name FROM customers WHERE phone = ${normalizePhone(d.phone) ?? d.phone} AND deleted_at IS NULL`;
    if (dup) blockers.push(`SĐT ${d.phone} đã là của khách "${dup.full_name}"`);
  }
  if (d.zalo) rows.push(["Zalo", d.zalo]);
  const same = await findCustomers(db, { customerName: d.customerName });
  if (same.length) warnings.push(`Đã có ${same.length} khách tên giống: ${same.slice(0, 3).map((c) => c.fullName + (c.phone ? ` (${c.phone})` : "")).join(", ")}`);
  if (d.note) rows.push(["Ghi chú", d.note]);
  return { draft: d, card: card() };
}

async function buildEinvoice(db: Db, d: Draft): Promise<Built> {
  const rows: [string, string][] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: "Ghi số hoá đơn điện tử", rows, warnings: [], blockers });
  if (!d.saleCode) return ask(d, "sale", "Hoá đơn của đơn nào? Gõ mã đơn BH-…", card());
  const s = await findSaleByCode(db, d.saleCode);
  if (!s) return { draft: d, card: card(), unresolvable: `Không thấy đơn ${d.saleCode}` };
  d.saleId = s.id;
  rows.push(["Đơn", `${s.code} · ${s.customer ?? "khách lẻ"} · ${formatVnd(s.revenueVnd)}`]);
  if (!d.einvoiceNo) return ask(d, "einvoice", "Số hoá đơn là gì?", card());
  rows.push(["Số hoá đơn", d.einvoiceNo]);
  if (s.status === "CANCELLED") blockers.push("Đơn đã huỷ");
  return { draft: d, card: card() };
}

async function buildTargetPrice(db: Db, d: Draft): Promise<Built> {
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const card = (): CardBody => ({ title: "Đặt giá bán mục tiêu", rows, warnings, blockers });
  const ids: string[] = [];
  const costs: bigint[] = [];
  for (const l of d.lines ?? []) {
    if (l.codeKind === "PARTIAL") {
      const c = await itemsByPartialCode(db, l.code ?? "");
      if (c.length !== 1) return { draft: d, card: card(), unresolvable: `"${l.code}" khớp ${c.length} máy — gõ đủ IMEI / Serial` };
      l.code = c[0].serial_number ?? c[0].imei1 ?? l.code;
    }
    const it = l.code ? await findItemForSale(db, l.code) : null;
    if (!it) return { draft: d, card: card(), unresolvable: `Không thấy máy ${l.code}` };
    ids.push(it.id);
    costs.push(it.costVnd);
    rows.push(["Máy", `${it.label} · ${it.serial ?? it.imei1}`]);
  }
  if (!ids.length && d.variantIds?.length === 1) {
    const list = await sellableOfVariant(db, d.variantIds[0], 200);
    const ready = list.filter((x) => x.arrived);
    if (!ready.length) return { draft: d, card: card(), unresolvable: `Không có máy ${d.productText} trong kho` };
    ids.push(...ready.map((x) => x.id));
    const refs = await variantRefs(db);
    rows.push(["Máy", `${ready.length} máy ${refs.find((r) => r.id === d.variantIds![0])?.label ?? ""} đang tồn`]);
  }
  if (!ids.length) return ask(d, "line:0", "Đặt giá cho máy nào? Gõ IMEI / Serial hoặc dòng máy.", card());
  d.itemIds = ids;
  if (!d.amount) return ask(d, "amount", "Giá bán mục tiêu bao nhiêu?", card());
  rows.push(["Giá mục tiêu", formatVnd(BigInt(d.amount))]);
  for (const c of costs) if (c > BigInt(d.amount)) warnings.push(`Thấp hơn giá vốn ${formatVnd(c)}`);
  return { draft: d, card: card() };
}

// ---- chọn ---------------------------------------------------------------------------------------------

/** Áp lựa chọn số `index` (1-based) của câu hỏi đang chờ vào bản nháp. */
export function applyChoice(d: Draft, index: number): Draft | null {
  const c = d.choices;
  if (!c) return null;
  const opt = c.options[index - 1];
  if (!opt) return null;
  const out: Draft = structuredClone(d);
  delete out.choices;
  delete out.asked;
  if (c.field.startsWith("line:")) {
    const k = Number(c.field.slice(5));
    const l = out.lines?.[k];
    if (l) {
      l.code = opt.value;
      l.codeKind = /^\d{15}$/.test(opt.value) ? "IMEI" : "SERIAL";
      delete l.itemId;
    }
  } else if (c.field === "customerId") {
    if (opt.value === "NEW") {
      // khách mới trùng tên khách cũ: ghi tên, không gắn khách cũ
      delete out.customerId;
      out.forceNewCustomer = true;
    } else out.customerId = opt.value;
  } else if (c.field === "variantId") {
    out.variantIds = [opt.value];
    out.variantId = opt.value;
  } else (out as unknown as Record<string, unknown>)[c.field] = opt.value;
  return out;
}

// ---- ghi thật -----------------------------------------------------------------------------------------

export async function executeDraft(tx: TransactionSql, d: Draft, ctx: BuildCtx): Promise<Executed> {
  const at = atOf(d.date, ctx.today);
  const date = d.date ?? ctx.today;
  switch (d.kind) {
    case "SALE":
    case "DEPOSIT": {
      const deposit = d.kind === "DEPOSIT";
      const forceNew = d.forceNewCustomer;
      const input = mustParse(saleSchema, {
        lines: (d.lines ?? []).map((l) => ({ itemId: l.itemId ?? "", price: l.price ?? "" })),
        customerPhone: d.customerId ? "" : (d.phone ?? ""),
        customerName: d.customerId ? "" : (d.customerName ?? ""),
        customerId: forceNew ? "" : (d.customerId ?? ""),
        channel: d.channel ?? "OTHER",
        discount: d.discount ?? "",
        shippingFee: d.shippingFee ?? "",
        otherFee: "",
        payment: deposit ? "DEPOSIT" : (d.payment ?? "TRANSFER"),
        accountId: d.accountId ?? "",
        paidAmount: deposit ? (d.deposit ?? "") : (d.paid ?? ""),
        warrantyMonths: String(d.warrantyMonths ?? 6),
        directShip: d.directShip ? "true" : "",
        // phiếu đã hiện cảnh báo "bán dưới giá vốn" — bấm Xác nhận là đồng ý
        confirmBelowCost: "true",
        einvoiceNo: d.einvoiceNo ?? "",
        note: d.note ?? "",
      });
      const r = await createSale(tx, input, at);
      const [s] = await tx<{ customer_id: string | null }[]>`SELECT customer_id::text FROM sales WHERE id = ${r.id}`;
      return { type: "sale", id: r.id, href: `/ban-hang/${r.id}`, summary: `${deposit ? "Đã ghi đơn cọc" : "Đã ghi đơn bán"} ${r.code}`, customerId: s?.customer_id ?? null };
    }
    case "PAYMENT": {
      if (!d.saleId || !d.accountId || !d.amount) throw new AssistantInputError("Thiếu đơn / tài khoản / số tiền");
      await addPayment(tx, d.saleId, d.accountId, BigInt(d.amount), at);
      return { type: "sale", id: d.saleId, href: `/ban-hang/${d.saleId}`, summary: `Đã thu ${formatVnd(BigInt(d.amount))} cho đơn ${d.saleCode}`, customerId: d.customerId ?? null };
    }
    case "COMPLETE_DEPOSIT": {
      if (!d.saleId) throw new AssistantInputError("Thiếu đơn");
      await completeSale(tx, d.saleId, { directShip: !!d.directShip, warrantyMonths: d.warrantyMonths ?? 6, accountId: d.accountId ?? null, paidAmount: d.amount ? BigInt(d.amount) : 0n }, at);
      return { type: "sale", id: d.saleId, href: `/ban-hang/${d.saleId}`, summary: `Đã hoàn tất đơn ${d.saleCode}`, customerId: d.customerId ?? null };
    }
    case "PURCHASE_ITEMS": {
      if (!d.purchaseOrderId || !d.variantId) throw new AssistantInputError("Thiếu đơn mua / cấu hình");
      const refs = await variantRefs(tx);
      const variant = refs.find((r) => r.id === d.variantId);
      const [po] = await tx<{ currency: string; batch_id: string }[]>`SELECT currency::text, batch_id::text FROM purchase_orders WHERE id = ${d.purchaseOrderId}`;
      if (!po || !variant) throw new AssistantInputError("Không thấy đơn mua / cấu hình");
      const codes = d.codes ?? [];
      const n = codes.length || d.qty || 1;
      const rows: GridRow[] = Array.from({ length: n }, (_, k) => {
        const c = codes[k];
        return {
          ...emptyRow(),
          variantId: variant.id,
          unitPrice: (po.currency === "USD" ? (c?.usd ?? d.usd) : (c?.vnd ?? d.amount)) ?? "",
          serial: c && c.kind === "SERIAL" ? c.value : "",
          imei1: c && c.kind !== "SERIAL" ? c.value : "",
          weightKg: variant.defaultWeightKg ?? "",
        };
      });
      const r = await appendItems(tx, d.purchaseOrderId, rows);
      return { type: "purchase_order", id: d.purchaseOrderId, href: `/chuyen-hang/${po.batch_id}`, summary: `Đã nhập ${r.newIds.length} máy vào đơn mua ${d.batchCode ?? ""}`.trim() };
    }
    case "LEDGER_ENTRY": {
      const c = checkManualEntry({ accountId: d.accountId ?? "", categoryCode: d.categoryCode ?? "", amount: d.amount ?? "", fxRate: "", occurredAt: date, counterparty: d.counterparty ?? "", note: d.note ?? "" });
      if (!c.ok) throw new AssistantInputError(`Kiểm tra lại: ${Object.values(c.errors).join("; ")}`);
      const id = await saveManualEntry(tx, null, c.data);
      return { type: "cash_transaction", id, href: `/thu-chi/${id}`, summary: `Đã ghi ${formatVnd(BigInt(d.amount!))} vào sổ thu chi` };
    }
    case "LANDED_COST": {
      const input = mustParse(costSchema, {
        kind: d.costKind ?? "",
        target: d.target ?? "",
        currency: d.usd ? "USD" : "VND",
        amount: d.usd ?? d.amount ?? "",
        fxRate: d.fxRate ?? "",
        incurredAt: date,
        accountId: d.accountId ?? "",
        paidAt: d.accountId ? date : "",
        note: d.note ?? "",
      });
      const r = await saveCost(tx, null, input);
      const [x] = await tx<{ batch: string | null }[]>`
        SELECT COALESCE(c.batch_id, po.batch_id, i.batch_id,
                        (SELECT i2.batch_id FROM shipment_items si JOIN items i2 ON i2.id = si.item_id WHERE si.shipment_id = c.shipment_id LIMIT 1))::text AS batch
          FROM costs c LEFT JOIN purchase_orders po ON po.id = c.purchase_order_id LEFT JOIN items i ON i.id = c.item_id WHERE c.id = ${r.id}`;
      return { type: "cost", id: r.id, href: x?.batch ? `/chuyen-hang/${x.batch}` : "/chuyen-hang", summary: `Đã ghi chi phí ${d.usd ? `$${d.usd}` : formatVnd(BigInt(d.amount!))} — giá vốn đã tính lại` };
    }
    case "TRANSFER": {
      const c = checkTransfer({ fromAccountId: d.fromAccountId ?? "", toAccountId: d.accountId ?? "", amountFrom: d.amount ?? "", amountTo: "", fxRate: "", occurredAt: date, note: d.note ?? "" });
      if (!c.ok) throw new AssistantInputError(`Kiểm tra lại: ${Object.values(c.errors).join("; ")}`);
      const id = await createTransfer(tx, c.data);
      return { type: "transfer", id, href: "/thu-chi", summary: `Đã chuyển ${formatVnd(BigInt(d.amount!))}` };
    }
    case "CUSTOMER": {
      const c = checkCustomer({ fullName: d.customerName ?? "", phone: d.phone ?? "", zalo: d.zalo ?? "", note: d.note ?? "" });
      if (!c.ok) throw new AssistantInputError(`Kiểm tra lại: ${Object.values(c.errors).join("; ")}`);
      const id = await saveCustomer(tx, null, c.data);
      return { type: "customer", id, href: `/ban-hang/khach-hang/${id}`, summary: `Đã thêm khách ${c.data.fullName}`, customerId: id };
    }
    case "EINVOICE": {
      if (!d.saleId || !d.einvoiceNo) throw new AssistantInputError("Thiếu đơn / số hoá đơn");
      await setEinvoiceNo(tx, d.saleId, d.einvoiceNo);
      return { type: "sale", id: d.saleId, href: `/ban-hang/${d.saleId}`, summary: `Đã ghi hoá đơn ${d.einvoiceNo} cho đơn ${d.saleCode}` };
    }
    case "TARGET_PRICE": {
      if (!d.itemIds?.length || !d.amount) throw new AssistantInputError("Thiếu máy / giá");
      const n = await setTargetPrice(tx, d.itemIds, BigInt(d.amount));
      return { type: "item", id: d.itemIds[0], href: n === 1 ? `/kho/${d.itemIds[0]}` : "/kho", summary: `Đã đặt giá mục tiêu ${formatVnd(BigInt(d.amount))} cho ${n} máy` };
    }
  }
}
