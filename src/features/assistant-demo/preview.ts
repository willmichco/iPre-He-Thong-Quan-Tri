/**
 * Chat demo (bản xem thử tĩnh) — lập phiếu xem trước NGAY TRONG TRÌNH DUYỆT từ gói dữ liệu mẫu.
 * Bản rút gọn của `buildDraft` (src/server/assistant/actions.ts): cùng cách tra máy (mã / vài số cuối / cấu hình — tồn lâu
 * nhất trước), khách, tài khoản, cùng cảnh báo và điều kiện chặn chính. Không ghi gì: Xác nhận chỉ báo "bản xem thử".
 */
import { dmy } from "@/domain/assistant/dates";
import type { DemoItem, DemoPack } from "@/domain/assistant/demo";
import type { Choice, Draft, DraftLine } from "@/domain/assistant/drafts";
import { ACCOUNT_ALIASES } from "@/domain/assistant/extract";
import { formatVnd, shortVnd } from "@/domain/assistant/money";
import { fold } from "@/domain/assistant/normalize";
import type { Chip, PreviewCard } from "@/domain/assistant/reply";
import { formatBp } from "@/domain/overview";
import { CHANNEL_LABEL, previewSale, type Channel } from "@/domain/sales-core";

export type CardBody = Omit<PreviewCard, "kind" | "actionId" | "status">;
export interface DemoBuilt {
  draft: Draft;
  card: CardBody;
  ask?: { question: string; chips?: Chip[] };
  unresolvable?: string;
}

const COST_KIND_LABEL: Record<string, string> = {
  US_DOMESTIC_SHIPPING: "Ship nội địa Mỹ",
  INTL_SHIPPING: "Cước Mỹ → VN",
  INSURANCE: "Bảo hiểm / phụ thu",
  CUSTOMS_TAX: "Thuế, phí thông quan",
  DOMESTIC_SHIPPING: "Cước HN → SG",
  FX_FEE: "Phí chuyển tiền / ngoại tệ",
  HANDLING: "Kiểm máy, đóng gói, lưu kho",
  OTHER_LANDED: "Chi phí khác (vào giá vốn)",
};
const LEG_COST: Record<string, string> = { US_DOMESTIC: "US_DOMESTIC_SHIPPING", US_TO_VN: "INTL_SHIPPING", HN_TO_SG: "DOMESTIC_SHIPPING" };
const PAY: Record<string, string> = { TRANSFER: "Chuyển khoản", CASH: "Tiền mặt", DEPOSIT: "Đặt cọc", UNPAID: "Ghi nợ" };
const big = (s: string | undefined | null) => (s ? BigInt(s) : 0n);
const codeOf = (i: DemoItem) => i.serial ?? i.imei ?? i.id;

function ask(d: Draft, field: string, question: string, card: CardBody, chips: Chip[] = []): DemoBuilt {
  d.asked = field;
  return { draft: d, card, ask: { question, chips } };
}
function choose(d: Draft, field: string, options: Choice[], question: string, card: CardBody): DemoBuilt {
  d.choices = { field, options };
  d.asked = field;
  return { draft: d, card, ask: { question } };
}

function findItem(pack: DemoPack, code: string): DemoItem | null {
  const c = code.toUpperCase();
  return pack.items.find((i) => i.serial === c || i.imei === c) ?? null;
}
function partial(pack: DemoPack, code: string) {
  const c = code.toUpperCase();
  return pack.items.filter((i) => (i.serial ?? "").includes(c) || (i.imei ?? "").includes(c));
}

function pickAccount(pack: DemoPack, hints: readonly string[] | undefined, payment: string | undefined) {
  const pool = pack.accounts.filter((a) => a.currency === "VND");
  if (hints?.length) {
    const m = pool.filter((a) => {
      const n = fold(a.name);
      return hints.some((h) => (ACCOUNT_ALIASES[h] ?? [h]).some((x) => n.includes(x)) || (h === "tien mat" && a.kind === "CASH") || (h === "ngan hang" && a.kind === "BANK"));
    });
    if (m.length >= 1) return { acc: m[0], choices: m.length > 1 ? m : null };
  }
  if (payment === "CASH") {
    const cash = pool.find((a) => a.kind === "CASH");
    if (cash) return { acc: cash, choices: null };
  }
  return { acc: pool.find((a) => a.kind !== "CASH") ?? pool[0] ?? null, choices: null };
}

function pickCustomer(pack: DemoPack, d: Draft) {
  if (d.customerId) {
    const c = pack.customers.find((x) => x.id === d.customerId);
    if (c) return { id: c.id, name: c.name, phone: c.phone, isNew: false, choices: null as Choice[] | null };
  }
  if (d.phone) {
    const c = pack.customers.find((x) => x.phone === d.phone);
    return c ? { id: c.id, name: c.name, phone: c.phone, isNew: false, choices: null } : { id: null, name: d.customerName ?? null, phone: d.phone, isNew: true, choices: null };
  }
  if (d.customerName && !d.forceNewCustomer) {
    const want = fold(d.customerName).replace(/^(anh|chi|em|co|chu|ban|bac|ong|ba|cau|di|thim) /, "");
    const words = want.split(" ");
    const found = pack.customers.filter((c) => fold(c.name) === fold(d.customerName!) || words.every((w) => fold(c.name).split(/\s+/).includes(w)));
    if (found.length === 1) return { id: found[0].id, name: found[0].name, phone: found[0].phone, isNew: false, choices: null };
    if (found.length > 1)
      return {
        id: null,
        name: d.customerName,
        phone: null,
        isNew: false,
        choices: [...found.map((c) => ({ value: c.id, label: `${c.name}${c.phone ? ` · ${c.phone}` : ""}` })), { value: "NEW", label: `Khách mới "${d.customerName}"` }],
      };
  }
  return d.customerName ? { id: null, name: d.customerName, phone: null, isNew: true, choices: null } : { id: null, name: null, phone: null, isNew: false, choices: null };
}

function dateChecks(date: string, today: string, warnings: string[], blockers: string[]) {
  if (date > today) blockers.push(`Ngày ${dmy(date)} ở tương lai — sửa ngày (vd "sửa ngày hôm nay")`);
  else if (date.slice(0, 7) < today.slice(0, 7)) warnings.push(`Ghi vào tháng ${date.slice(5, 7)}/${date.slice(0, 4)} — kiểm tra kỳ đã kê khai thuế chưa`);
}

export function demoPreview(input: Draft, pack: DemoPack): DemoBuilt {
  const d: Draft = structuredClone(input);
  const today = pack.today;
  const rows: [string, string][] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  const extra: Pick<CardBody, "profit"> = {};
  const TITLE: Record<string, string> = {
    SALE: "Phiếu bán hàng",
    DEPOSIT: "Phiếu đặt cọc",
    PAYMENT: "Thu thêm tiền đơn bán",
    COMPLETE_DEPOSIT: "Hoàn tất đơn cọc",
    PURCHASE_ITEMS: "Nhập máy vào đơn mua",
    LEDGER_ENTRY: "Phiếu thu chi",
    LANDED_COST: "Chi phí vào giá vốn",
    TRANSFER: "Chuyển tiền nội bộ",
    CUSTOMER: "Thêm khách hàng",
    EINVOICE: "Ghi số hoá đơn điện tử",
    TARGET_PRICE: "Đặt giá bán mục tiêu",
  };
  const card = (): CardBody => ({ title: TITLE[d.kind], rows, warnings, blockers, ...extra });
  const date = d.date ?? today;
  const dateRow = () => rows.push(["Ngày", `${dmy(date)}${date === today ? " (hôm nay)" : ""}`]);
  const account = (q: string) => {
    const p = pickAccount(pack, d.accountHints, d.payment);
    if (p.choices && !d.accountId) return choose(d, "accountId", p.choices.map((a) => ({ value: a.id, label: a.name })), q, card());
    const acc = pack.accounts.find((a) => a.id === d.accountId) ?? p.acc;
    if (acc) {
      d.accountId = acc.id;
      return acc;
    }
    blockers.push("Chưa có tài khoản VND");
    return null;
  };

  switch (d.kind) {
    case "SALE":
    case "DEPOSIT": {
      const deposit = d.kind === "DEPOSIT";
      if (!d.lines?.length) d.lines = [{}];
      const items: DemoItem[] = [];
      const taken = new Set<string>();
      for (let k = 0; k < d.lines.length; k++) {
        const l: DraftLine = d.lines[k];
        if (l.codeKind === "IMEI_BAD") return ask(d, `line:${k}`, `IMEI ${l.code} sai số kiểm tra (chữ số cuối) — gõ lại IMEI đúng`, card(), [{ label: "Để sau (bảng kê nháp)", text: "để sau" }]);
        let it: DemoItem | null = null;
        if (l.code && l.codeKind === "PARTIAL") {
          const c = partial(pack, l.code).filter((i) => i.sellable !== "NO");
          if (!c.length) return { draft: d, card: card(), unresolvable: `Không thấy máy nào có Serial / IMEI chứa "${l.code}"` };
          if (c.length > 1) return choose(d, `line:${k}`, c.map((i) => ({ value: codeOf(i), label: `${i.label} · ${codeOf(i)}` })), `Có ${c.length} máy khớp "${l.code}" — chọn máy:`, card());
          it = c[0];
          l.code = codeOf(it);
          l.codeKind = it.serial ? "SERIAL" : "IMEI";
        } else if (l.code) {
          it = findItem(pack, l.code);
          if (!it) return { draft: d, card: card(), unresolvable: `Máy ${l.code} chưa có trong hệ thống` };
        } else {
          const vids = d.variantIds ?? [];
          if (!vids.length) return ask(d, `line:${k}`, "Bán máy nào? Gõ IMEI / Serial / vài số cuối (vd: đuôi 0001), hoặc dòng máy (vd: 16 pro 256).", card());
          if (vids.length > 1) return choose(d, "variantId", vids.map((id) => ({ value: id, label: pack.variants.find((v) => v.id === id)?.label ?? id })), `"${d.productText}" khớp nhiều cấu hình — chọn cấu hình:`, card());
          // tồn lâu nhất trước (về SG sớm nhất); máy chưa về xếp sau — chỉ cọc được
          const cands = pack.items
            .filter((i) => i.variantId === vids[0] && i.sellable !== "NO" && !taken.has(i.id))
            .sort((a, b) => (a.sg ?? "9999").localeCompare(b.sg ?? "9999"));
          const label = pack.variants.find((v) => v.id === vids[0])?.label ?? d.productText ?? "dòng này";
          if (!cands.length) return { draft: d, card: card(), unresolvable: `Hết máy ${label} để bán` };
          it = cands.find((i) => i.sellable === "NOW") ?? cands[0];
          l.code = codeOf(it);
          l.codeKind = it.serial ? "SERIAL" : "IMEI";
          if (cands.length > 1) warnings.push(`Chọn máy tồn lâu nhất của ${it.label} (${l.code}) — còn ${cands.length - 1} máy khác; muốn máy khác thì gõ IMEI / Serial`);
        }
        if (taken.has(it.id)) {
          blockers.push(`Máy ${l.code} bị nhập 2 lần`);
          continue;
        }
        taken.add(it.id);
        l.itemId = it.id;
        items.push(it);
        rows.push([d.lines.length > 1 ? `Máy ${k + 1}` : "Máy", `${it.label} · ${it.serial ?? ""}${it.imei ? ` · IMEI ${it.imei}` : ""}`]);
        if (it.sellable === "NO") blockers.push(it.reason ?? `Máy ${l.code} không bán được`);
        if (it.sellable === "DEPOSIT_ONLY" && !deposit && !d.directShip) blockers.push(`Máy ${l.code} chưa về SG — chuyển thành cọc, hoặc xác nhận bán giao thẳng`);
        if (it.hasEstimate) warnings.push(`Giá vốn máy ${l.code} còn tạm tính`);
      }
      const miss = d.lines.findIndex((l) => !l.price);
      if (miss >= 0) {
        const it = items[miss];
        const chips: Chip[] = [];
        if (it?.targetVnd) chips.push({ label: `${shortVnd(BigInt(it.targetVnd))} (giá mục tiêu)`, text: it.targetVnd });
        if (it) chips.push({ label: `Giá vốn ${shortVnd(BigInt(it.costVnd))} + 1tr`, text: String(BigInt(it.costVnd) + 1_000_000n) });
        return ask(d, "price", `Giá bán ${d.lines.length > 1 ? `máy ${miss + 1} ` : ""}bao nhiêu? (vd 25tr5)`, card(), chips);
      }
      for (const l of d.lines) if (l.priceAlt) warnings.push(`Hiểu giá là ${formatVnd(BigInt(l.price!))} — nếu ý là ${formatVnd(BigInt(l.priceAlt))} thì gõ "sửa giá ${l.priceAlt}"`);
      const total = d.lines.reduce((a, l) => a + BigInt(l.price!), 0n);
      rows.push(["Giá bán", d.lines.length > 1 ? `${d.lines.map((l) => shortVnd(BigInt(l.price!))).join(" + ")} = ${formatVnd(total)}` : formatVnd(total)]);
      if (d.discount) rows.push(["Giảm giá", formatVnd(big(d.discount))]);
      if (d.shippingFee) rows.push(["Ship cho khách (shop trả)", formatVnd(big(d.shippingFee))]);
      const pv = previewSale(
        items.map((it, k) => ({ itemId: it.id, priceVnd: BigInt(d.lines![k].price!), costVnd: BigInt(it.costVnd) })),
        big(d.discount),
        d.shippingFee ? [big(d.shippingFee)] : [],
      );
      rows.push(["Giá vốn", formatVnd(pv.costVnd)]);
      extra.profit = { value: `${pv.profitVnd < 0n ? "−" : ""}${formatVnd(pv.profitVnd < 0n ? -pv.profitVnd : pv.profitVnd)}`, margin: pv.marginBp === null ? null : formatBp(pv.marginBp), negative: pv.profitVnd < 0n, provisional: items.some((i) => i.hasEstimate) };
      if (pv.belowCost.length && !deposit) warnings.push(`Bán DƯỚI giá vốn ${pv.belowCost.length} máy — bấm Xác nhận là đồng ý bán lỗ`);
      const c = pickCustomer(pack, d);
      if (c.choices) return choose(d, "customerId", c.choices, `Có nhiều khách tên "${d.customerName}" — chọn khách:`, card());
      if (c.id) d.customerId = c.id;
      rows.push(["Khách", c.name || c.phone ? `${c.name ?? `Khách ${c.phone!.slice(-4)}`}${c.phone ? ` · ${c.phone}` : ""}${c.isNew ? " (khách mới)" : ""}` : "Khách lẻ"]);
      if (deposit && !c.name && !c.phone) return ask(d, "customer", "Khách cọc tên gì / SĐT bao nhiêu? (vd: chị Lan 0901234567)", card());
      rows.push(["Kênh", CHANNEL_LABEL[(d.channel ?? "OTHER") as Channel] ?? "Khác"]);
      if (deposit && !d.deposit) return ask(d, "deposit", `Khách cọc bao nhiêu? (giá đơn ${shortVnd(total - big(d.discount))})`, card(), [{ label: "Cọc 1tr", text: "cọc 1tr" }, { label: "Cọc 3tr", text: "cọc 3tr" }, { label: "Cọc 5tr", text: "cọc 5tr" }]);
      const payment = deposit ? "DEPOSIT" : (d.payment ?? "TRANSFER");
      const net = total - big(d.discount);
      const received = deposit ? big(d.deposit) : payment === "UNPAID" ? big(d.paid) : d.paid ? big(d.paid) : net;
      if (received > net) blockers.push(`Số tiền nhận ${formatVnd(received)} lớn hơn tổng đơn ${formatVnd(net)}`);
      rows.push([
        "Thanh toán",
        deposit
          ? `Cọc ${formatVnd(received)} · còn lại ${formatVnd(net - received)} khi giao`
          : payment === "UNPAID"
            ? `Ghi nợ${received ? ` · đã nhận ${formatVnd(received)}` : ""} · còn nợ ${formatVnd(net - received)}`
            : `${PAY[payment]} ${formatVnd(received)}${received < net ? ` · còn nợ ${formatVnd(net - received)}` : ""}`,
      ]);
      if (payment !== "UNPAID" || d.paid) {
        const a = account("Nhận tiền vào tài khoản nào?");
        if (a && "draft" in a) return a;
        if (a) rows.push(["Tài khoản nhận", a.name]);
      }
      dateRow();
      dateChecks(date, today, warnings, blockers);
      for (const it of items) {
        if (date < today && !deposit && !d.directShip && it.sg && date < it.sg) blockers.push(`Máy ${codeOf(it)} về SG ngày ${dmy(it.sg)} — không bán trước ngày đó được`);
      }
      if (!deposit) rows.push(["Bảo hành", d.warrantyMonths === 0 ? "Không bảo hành" : `${d.warrantyMonths ?? 6} tháng`]);
      if (d.directShip) rows.push(["Giao", "Bán giao thẳng (máy chưa về SG)"]);
      if (d.einvoiceNo) rows.push(["Số hoá đơn", d.einvoiceNo]);
      return { draft: d, card: card() };
    }

    case "PAYMENT":
    case "COMPLETE_DEPOSIT": {
      const complete = d.kind === "COMPLETE_DEPOSIT";
      let sale = pack.sales.find((s) => s.id === d.saleId || (d.saleCode && s.code === d.saleCode));
      if (d.saleCode && !sale) return { draft: d, card: card(), unresolvable: `Không thấy đơn ${d.saleCode}` };
      if (!sale) {
        const c = pickCustomer(pack, d);
        if (!c.id) return ask(d, "sale", "Đơn nào? Gõ mã đơn (BH-2026-…) hoặc tên / SĐT khách.", card());
        const open = pack.sales.filter((s) => s.customerId === c.id && (complete ? s.status === "DEPOSITED" : s.status !== "CANCELLED" && big(s.balanceVnd) > 0n));
        if (!open.length) return { draft: d, card: card(), unresolvable: complete ? `${c.name} không có đơn cọc nào đang mở` : `${c.name} không còn nợ đơn nào` };
        if (open.length > 1) return choose(d, "saleId", open.map((o) => ({ value: o.id, label: `${o.code} · ${o.items} · còn ${shortVnd(big(o.balanceVnd))}` })), "Khách có nhiều đơn — chọn đơn:", card());
        sale = open[0];
      }
      d.saleId = sale.id;
      d.saleCode = sale.code;
      rows.push(["Đơn", `${sale.code} · ${sale.items}`], ["Khách", sale.customer ?? "Khách lẻ"], ["Tổng đơn", formatVnd(big(sale.revenueVnd))], ["Còn nợ", formatVnd(big(sale.balanceVnd))]);
      if (complete && sale.status !== "DEPOSITED") blockers.push(`Đơn ${sale.code} không phải đơn đang cọc`);
      const amount = complete ? (d.amount ? BigInt(d.amount) : big(sale.balanceVnd)) : d.amount ? BigInt(d.amount) : null;
      if (amount === null) return ask(d, "amount", `Khách trả bao nhiêu? (còn nợ ${formatVnd(big(sale.balanceVnd))})`, card(), [{ label: `Trả đủ ${shortVnd(big(sale.balanceVnd))}`, text: sale.balanceVnd }]);
      if (amount > big(sale.balanceVnd)) blockers.push(`Khách chỉ còn nợ ${formatVnd(big(sale.balanceVnd))}`);
      if (amount > 0n) {
        rows.push([complete ? "Thu khi giao" : "Thu thêm", formatVnd(amount)]);
        const a = account("Nhận tiền vào tài khoản nào?");
        if (a && "draft" in a) return a;
        if (a) rows.push(["Tài khoản nhận", a.name]);
      }
      dateRow();
      dateChecks(date, today, warnings, blockers);
      return { draft: d, card: card() };
    }

    case "PURCHASE_ITEMS": {
      const pos = pack.purchaseOrders.filter((p) => !d.batchCode || p.batchCode === d.batchCode);
      if (d.batchCode && !pack.batches.some((b) => b.code === d.batchCode)) return { draft: d, card: card(), unresolvable: `Không thấy chuyến ${d.batchCode}` };
      let po = pos.find((p) => p.id === d.purchaseOrderId);
      if (!po) {
        if (!pos.length) return { draft: d, card: card(), unresolvable: "Chuyến này chưa có đơn mua đang mở" };
        if (pos.length > 1 || !d.batchCode) return choose(d, "purchaseOrderId", pos.map((p) => ({ value: p.id, label: `${p.batchCode} · ${p.label} · ${p.currency}` })), "Nhập vào đơn mua nào?", card());
        po = pos[0];
      }
      d.purchaseOrderId = po.id;
      rows.push(["Đơn mua", `${po.batchCode} · ${po.label} · ${po.currency}`]);
      if (!d.variantId) {
        const vids = d.variantIds ?? [];
        if (vids.length > 1) return choose(d, "variantId", vids.map((id) => ({ value: id, label: pack.variants.find((v) => v.id === id)?.label ?? id })), "Chọn cấu hình:", card());
        if (!vids.length) return ask(d, "variant", "Máy cấu hình gì? (vd: 16 pro 256 desert)", card());
        d.variantId = vids[0];
      }
      rows.push(["Cấu hình", pack.variants.find((v) => v.id === d.variantId)?.label ?? ""]);
      const price = po.currency === "USD" ? d.usd : d.amount;
      if (!price) return ask(d, "price", `Đơn giá mỗi máy bao nhiêu ${po.currency === "USD" ? "USD (vd $999)" : "VND"}?`, card());
      const codes = d.codes ?? [];
      for (const c of codes) if (findItem(pack, c.value)) blockers.push(`Máy ${c.value} đã có trong hệ thống`);
      rows.push(["Số máy", `${codes.length || d.qty || 1}${codes.length ? `: ${codes.map((c) => c.value).join(", ")}` : " (chưa có IMEI / Serial)"}`]);
      rows.push(["Đơn giá", po.currency === "USD" ? `$${price}` : formatVnd(BigInt(price))]);
      return { draft: d, card: card() };
    }

    case "LEDGER_ENTRY": {
      const cat = pack.categories.find((c) => c.code === d.categoryCode);
      if (!cat) return choose(d, "categoryCode", pack.categories.map((c) => ({ value: c.code, label: `${c.direction === "IN" ? "Thu" : "Chi"} · ${c.name}` })), "Khoản này thuộc danh mục nào?", card());
      rows.push(["Danh mục", `${cat.direction === "IN" ? "Thu" : "Chi"} · ${cat.name}`]);
      if (!d.amount) return ask(d, "amount", "Số tiền bao nhiêu? (vd 2tr)", card());
      rows.push(["Số tiền", formatVnd(BigInt(d.amount))]);
      const a = account(cat.direction === "IN" ? "Nhận vào tài khoản nào?" : "Chi từ tài khoản nào?");
      if (a && "draft" in a) return a;
      if (a) rows.push([cat.direction === "IN" ? "Vào tài khoản" : "Từ tài khoản", a.name]);
      dateRow();
      dateChecks(date, today, warnings, blockers);
      if (d.counterparty) rows.push(["Đối tượng", d.counterparty]);
      if (d.note) rows.push(["Ghi chú", d.note]);
      return { draft: d, card: card() };
    }

    case "LANDED_COST": {
      if (!d.target) {
        if (d.tracking) {
          const sh = pack.shipments.find((s) => s.tracking.toUpperCase() === d.tracking!.toUpperCase());
          if (!sh) return { draft: d, card: card(), unresolvable: `Chưa có kiện ${d.tracking}` };
          d.target = `SHIPMENT:${sh.tracking}`;
          d.targetLabel = `Kiện ${sh.tracking} (${sh.itemCount} máy)`;
          d.costKind ??= LEG_COST[sh.legType] ?? "OTHER_LANDED";
        } else if (d.batchCode) {
          if (!pack.batches.some((b) => b.code === d.batchCode)) return { draft: d, card: card(), unresolvable: `Không thấy chuyến ${d.batchCode}` };
          d.target = `BATCH:${d.batchCode}`;
          d.targetLabel = `Chuyến ${d.batchCode}`;
        } else return ask(d, "target", "Chi phí này của kiện / chuyến nào? Gõ mã vận đơn hoặc mã chuyến (CH-2026-…).", card());
      }
      rows.push(["Gắn vào", d.targetLabel ?? d.target]);
      if (!d.costKind) return choose(d, "costKind", Object.entries(COST_KIND_LABEL).map(([value, label]) => ({ value, label })), "Loại chi phí nào?", card());
      rows.push(["Loại", COST_KIND_LABEL[d.costKind] ?? d.costKind]);
      if (!d.amount && !d.usd) return ask(d, "amount", "Số tiền bao nhiêu? (vd 3tr5)", card());
      rows.push(["Số tiền", d.usd ? `$${d.usd}` : formatVnd(BigInt(d.amount!))]);
      rows.push(["Ngày phát sinh", dmy(date)]);
      warnings.push("Giá vốn các máy liên quan sẽ được tính lại ngay khi ghi");
      return { draft: d, card: card() };
    }

    case "TRANSFER": {
      const match = (hints?: string[]) =>
        (hints ?? []).length ? pack.accounts.filter((a) => hints!.some((h) => (ACCOUNT_ALIASES[h] ?? [h]).some((x) => fold(a.name).includes(x)) || (h === "tien mat" && a.kind === "CASH"))) : [];
      if (!d.fromAccountId) {
        const m = match(d.fromHints);
        if (m.length !== 1) return choose(d, "fromAccountId", pack.accounts.map((a) => ({ value: a.id, label: a.name })), "Chuyển TỪ tài khoản nào?", card());
        d.fromAccountId = m[0].id;
      }
      if (!d.accountId) {
        const m = match(d.accountHints).filter((a) => a.id !== d.fromAccountId);
        if (m.length !== 1) return choose(d, "accountId", pack.accounts.filter((a) => a.id !== d.fromAccountId).map((a) => ({ value: a.id, label: a.name })), "Chuyển SANG tài khoản nào?", card());
        d.accountId = m[0].id;
      }
      rows.push(["Từ", pack.accounts.find((a) => a.id === d.fromAccountId)?.name ?? ""], ["Sang", pack.accounts.find((a) => a.id === d.accountId)?.name ?? ""]);
      if (!d.amount) return ask(d, "amount", "Chuyển bao nhiêu?", card());
      rows.push(["Số tiền", formatVnd(BigInt(d.amount))]);
      dateRow();
      return { draft: d, card: card() };
    }

    case "CUSTOMER": {
      if (!d.customerName) return ask(d, "customer", "Tên khách là gì? (vd: chị Lan 0901234567)", card());
      rows.push(["Tên", d.customerName]);
      if (d.phone) {
        rows.push(["SĐT", d.phone]);
        const dup = pack.customers.find((c) => c.phone === d.phone);
        if (dup) blockers.push(`SĐT ${d.phone} đã là của khách "${dup.name}"`);
      }
      if (d.zalo) rows.push(["Zalo", d.zalo]);
      return { draft: d, card: card() };
    }

    case "EINVOICE": {
      if (!d.saleCode) return ask(d, "sale", "Hoá đơn của đơn nào? Gõ mã đơn BH-…", card());
      const s = pack.sales.find((x) => x.code === d.saleCode);
      if (!s) return { draft: d, card: card(), unresolvable: `Không thấy đơn ${d.saleCode}` };
      rows.push(["Đơn", `${s.code} · ${s.customer ?? "khách lẻ"} · ${formatVnd(big(s.revenueVnd))}`]);
      if (!d.einvoiceNo) return ask(d, "einvoice", "Số hoá đơn là gì?", card());
      rows.push(["Số hoá đơn", d.einvoiceNo]);
      return { draft: d, card: card() };
    }

    case "TARGET_PRICE": {
      const its: DemoItem[] = [];
      for (const l of d.lines ?? []) {
        const c = l.codeKind === "PARTIAL" ? partial(pack, l.code ?? "") : [findItem(pack, l.code ?? "")].filter((x): x is DemoItem => !!x);
        if (c.length !== 1) return { draft: d, card: card(), unresolvable: `Không xác định được máy "${l.code}"` };
        its.push(c[0]);
        rows.push(["Máy", `${c[0].label} · ${codeOf(c[0])}`]);
      }
      if (!its.length && d.variantIds?.length === 1) {
        const ready = pack.items.filter((i) => i.variantId === d.variantIds![0] && i.status === "IN_STOCK");
        if (!ready.length) return { draft: d, card: card(), unresolvable: `Không có máy ${d.productText} trong kho` };
        its.push(...ready);
        rows.push(["Máy", `${ready.length} máy ${ready[0].label} đang tồn`]);
      }
      if (!its.length) return ask(d, "line:0", "Đặt giá cho máy nào? Gõ IMEI / Serial hoặc dòng máy.", card());
      if (!d.amount) return ask(d, "amount", "Giá bán mục tiêu bao nhiêu?", card());
      rows.push(["Giá mục tiêu", formatVnd(BigInt(d.amount))]);
      for (const i of its) if (BigInt(i.costVnd) > BigInt(d.amount)) warnings.push(`Thấp hơn giá vốn ${formatVnd(BigInt(i.costVnd))}`);
      return { draft: d, card: card() };
    }
  }
}
