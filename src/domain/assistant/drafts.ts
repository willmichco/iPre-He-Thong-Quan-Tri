/**
 * Trợ lý — bản nháp của một phiếu ghi (chưa tra CSDL): dựng từ ô thông tin của câu nhắn, gộp phần sửa ("sửa giá 26tr"),
 * đoán danh mục thu chi / loại chi phí theo từ khoá. Mọi số tiền là chuỗi số nguyên VND, USD là chuỗi thập phân.
 */
import type { Slots } from "./extract";
import type { WriteIntent } from "./intents";
import { fold } from "./normalize";

export interface DraftLine {
  /** mã gõ / quét (IMEI, Serial, vài số cuối) */
  code?: string;
  codeKind?: string;
  /** máy đã tra được */
  itemId?: string;
  label?: string;
  /** giá bán (VND) */
  price?: string;
  priceAlt?: string;
  line?: number;
}

export interface Choice {
  value: string;
  label: string;
}

export interface Draft {
  kind: WriteIntent;
  date?: string;
  // tiền chung: thu chi, chi phí, thu thêm, chuyển tiền, giá mục tiêu
  amount?: string;
  amountAlt?: string;
  usd?: string;
  accountId?: string;
  accountHints?: string[];
  fromAccountId?: string;
  fromHints?: string[];
  payment?: string;
  note?: string;
  // bán / cọc
  lines?: DraftLine[];
  variantIds?: string[];
  productText?: string;
  qty?: number;
  customerId?: string;
  /** người dùng chọn "khách mới" dù trùng tên khách cũ */
  forceNewCustomer?: boolean;
  customerName?: string;
  phone?: string;
  zalo?: string;
  channel?: string;
  deposit?: string;
  paid?: string;
  warrantyMonths?: number;
  directShip?: boolean;
  discount?: string;
  shippingFee?: string;
  einvoiceNo?: string;
  saleId?: string;
  saleCode?: string;
  // nhập máy
  purchaseOrderId?: string;
  batchCode?: string;
  variantId?: string;
  codes?: { kind: string; value: string; line: number; usd?: string; vnd?: string }[];
  // thu chi / chi phí
  categoryCode?: string;
  counterparty?: string;
  costKind?: string;
  target?: string;
  targetLabel?: string;
  tracking?: string;
  fxRate?: string;
  // giá mục tiêu
  itemIds?: string[];
  /** tin nhắn của phiếu (để gắn mã khách → làm sạch khi ẩn danh hoá) */
  msgIds?: number[];
  /** câu hỏi bot đang chờ trả lời + các lựa chọn đánh số */
  asked?: string;
  choices?: { field: string; options: Choice[] };
}

const lastMoney = (s: Slots, role?: string) => [...s.money].reverse().find((m) => !role || m.role === role);

/** Từ khoá → danh mục thu chi nhập tay (mã trong cash_categories). */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(gop von|bo von|them von|nap von|bo them von)\b/, "CAPITAL_IN"],
  [/\b(rut von|rut lai|rut tien ve|chia lai)\b/, "CAPITAL_OUT"],
  [/\b(nop thue|dong thue|thue gtgt|thue tncn|thue mon bai|le phi mon bai)\b/, "TAX"],
  [/\b(quang cao|ads|chay ads|boost|facebook ads|tiktok ads|marketing)\b/, "OPEX_ADS"],
  [/\b(internet|wifi|4g|5g|sim|cuoc dien thoai|dien thoai|phan mem|app|icloud|ten mien|hosting|google one|canva)\b/, "OPEX_TELECOM"],
  [/\b(mat bang|tien nha|thue nha|thue kho|tien kho|tien phong|thue mat bang|thue cua hang)\b/, "OPEX_RENT"],
  [/\b(thu khac|tien thuong|hoa hong|thu nhap khac)\b/, "OTHER_IN"],
];
export function guessCategory(text: string): string | null {
  const f = ` ${fold(text).replace(/[^a-z0-9]+/g, " ")} `;
  for (const [re, code] of CATEGORY_WORDS) if (re.test(f)) return code;
  if (/\b(chi|chi tien|tra tien|mua do|mua)\b/.test(f)) return "OPEX_OTHER";
  if (/\b(thu)\b/.test(f)) return "OTHER_IN";
  return null;
}

/** Từ khoá → loại chi phí cấu thành giá vốn. */
const COST_WORDS: [RegExp, string][] = [
  [/\b(ship noi dia my|noi dia my|ship my|ship toi kho|ship ve kho)\b/, "US_DOMESTIC_SHIPPING"],
  [/\b(bao hiem|phu thu)\b/, "INSURANCE"],
  [/\b(thong quan|thue nhap khau|hai quan|thue nk)\b/, "CUSTOMS_TAX"],
  [/\b(chanh|chanh xe|hn sg|ha noi sai gon|ra sg|vao sg|cuoc hn)\b/, "DOMESTIC_SHIPPING"],
  [/\b(phi chuyen tien|phi ngoai te|phi doi tien|phi chuyen doi)\b/, "FX_FEE"],
  [/\b(kiem may|dong goi|luu kho|phi xu ly)\b/, "HANDLING"],
  [/\b(cuoc bay|cuoc kien|cuoc quoc te|forwarder|cuoc my ve|cuoc van chuyen|phi van chuyen|cuoc)\b/, "INTL_SHIPPING"],
];
export function guessCostKind(text: string): string | null {
  const f = ` ${fold(text).replace(/[^a-z0-9]+/g, " ")} `;
  for (const [re, kind] of COST_WORDS) if (re.test(f)) return kind;
  return null;
}
/** loại chi phí mặc định theo chặng của kiện */
export const COST_KIND_BY_LEG: Record<string, string> = {
  US_DOMESTIC: "US_DOMESTIC_SHIPPING",
  US_TO_VN: "INTL_SHIPPING",
  HN_TO_SG: "DOMESTIC_SHIPPING",
};

/** Dựng bản nháp từ ô thông tin của câu nhắn. */
export function draftFromSlots(kind: WriteIntent, s: Slots, text: string): Draft {
  const d: Draft = { kind };
  if (s.date) d.date = s.date;
  if (s.accountHints.length) d.accountHints = [...s.accountHints];
  if (s.fromAccountHints.length) d.fromHints = [...s.fromAccountHints];
  if (s.payment) d.payment = s.payment;
  if (s.note) d.note = s.note;
  if (s.customerName) d.customerName = s.customerName;
  if (s.phone) d.phone = s.phone;
  if (s.zalo) d.zalo = s.zalo;
  if (s.channel) d.channel = s.channel;
  if (s.saleCode) d.saleCode = s.saleCode;
  if (s.batchCode) d.batchCode = s.batchCode;
  if (s.tracking) d.tracking = s.tracking;
  if (s.einvoiceNo) d.einvoiceNo = s.einvoiceNo;
  if (s.warrantyMonths !== undefined) d.warrantyMonths = s.warrantyMonths;
  if (s.directShip) d.directShip = true;
  if (s.variantIds.length) {
    d.variantIds = [...s.variantIds];
    d.productText = s.productText;
  }
  if (s.qty) d.qty = s.qty;
  const discount = lastMoney(s, "discount");
  if (discount) d.discount = discount.vnd;
  const ship = lastMoney(s, "ship");
  if (ship) d.shippingFee = ship.vnd;

  switch (kind) {
    case "SALE":
    case "DEPOSIT": {
      const prices = s.money.filter((m) => m.role === "price");
      const codes = s.codes;
      const lines: DraftLine[] = codes.map((c) => ({ code: c.value, codeKind: c.kind, line: c.line }));
      if (!lines.length && (d.variantIds?.length || prices.length)) {
        const n = Math.max(1, Math.min(d.qty ?? 1, 20));
        for (let k = 0; k < n; k++) lines.push({});
      }
      // giá: cùng dòng với mã (nhắn nhiều dòng) → theo thứ tự → một giá cho mọi máy ("mỗi máy" / chỉ có một giá)
      lines.forEach((l, k) => {
        const sameLine = s.lines > 1 ? prices.find((p) => p.line === l.line) : undefined;
        const p = sameLine ?? (prices.length === lines.length ? prices[k] : prices.length === 1 && !s.total ? prices[0] : undefined);
        if (p) {
          l.price = p.vnd;
          if (p.alt) l.priceAlt = p.alt;
        }
      });
      // "tổng 50tr" cho nhiều máy: chưa chia — hỏi lại giá từng máy
      if (prices.length === 1 && s.total && lines.length === 1) lines[0].price = prices[0].vnd;
      d.lines = lines;
      const dep = lastMoney(s, "deposit");
      if (dep) d.deposit = dep.vnd;
      const paid = lastMoney(s, "paid");
      if (paid) d.paid = paid.vnd;
      if (kind === "DEPOSIT") d.payment = "DEPOSIT";
      break;
    }
    case "PAYMENT":
    case "COMPLETE_DEPOSIT": {
      const m = lastMoney(s, "paid") ?? lastMoney(s, "price");
      if (m) {
        d.amount = m.vnd;
        if (m.alt) d.amountAlt = m.alt;
      }
      break;
    }
    case "PURCHASE_ITEMS": {
      d.codes = s.codes
        .filter((c) => c.kind === "IMEI" || c.kind === "SERIAL" || c.kind === "IMEI_BAD")
        .map((c) => {
          const usd = s.lines > 1 ? s.usd.find((u) => u.line === c.line) : undefined;
          const vnd = s.lines > 1 ? s.money.find((m) => m.line === c.line) : undefined;
          return { kind: c.kind, value: c.value, line: c.line, ...(usd ? { usd: usd.usd } : {}), ...(vnd ? { vnd: vnd.vnd } : {}) };
        });
      if (s.usd.length && !(s.lines > 1 && d.codes.every((c) => c.usd))) d.usd = s.usd[0].usd;
      const m = lastMoney(s, "price");
      if (m && !d.usd) d.amount = m.vnd;
      if (d.variantIds?.length === 1) d.variantId = d.variantIds[0];
      break;
    }
    case "LEDGER_ENTRY":
    case "LANDED_COST":
    case "TRANSFER":
    case "TARGET_PRICE": {
      const m = lastMoney(s, "price") ?? lastMoney(s, "fee") ?? lastMoney(s, "paid") ?? lastMoney(s, "ship");
      if (m) {
        d.amount = m.vnd;
        if (m.alt) d.amountAlt = m.alt;
      }
      if (s.usd.length) d.usd = s.usd[0].usd;
      if (kind === "LEDGER_ENTRY") {
        const c = guessCategory(text);
        if (c) d.categoryCode = c;
        if (s.customerName) d.counterparty = s.customerName;
        // tiền "ship" ở câu thu chi là chính số tiền, không phải phí ship khách
        delete d.shippingFee;
        delete d.customerName;
      }
      if (kind === "LANDED_COST") {
        const k = guessCostKind(text);
        if (k) d.costKind = k;
        delete d.shippingFee;
      }
      if (kind === "TARGET_PRICE") d.lines = s.codes.map((c) => ({ code: c.value, codeKind: c.kind }));
      break;
    }
    case "CUSTOMER":
    case "EINVOICE":
      break;
  }
  return d;
}

/**
 * Gộp phần sửa vào bản nháp: chỉ ô có trong câu sửa mới thay. "giá 26tr" → giá; số tiền trơn → ô tiền chính của phiếu;
 * ngày, khách, SĐT, kênh, thanh toán, tài khoản, bảo hành, số hoá đơn, mã máy (thêm / thay khi phiếu chưa có máy).
 */
export function mergeSlots(d: Draft, s: Slots, text: string): Draft {
  const out: Draft = structuredClone(d);
  delete out.asked;
  delete out.choices;
  if (s.date) out.date = s.date;
  if (s.phone) {
    out.phone = s.phone;
    delete out.customerId;
  }
  if (s.customerName) {
    if (out.kind === "LEDGER_ENTRY") out.counterparty = s.customerName;
    else {
      out.customerName = s.customerName;
      delete out.customerId;
    }
  }
  if (s.channel) out.channel = s.channel;
  if (s.payment) {
    out.payment = s.payment === "DEPOSIT" && out.kind !== "DEPOSIT" && out.kind !== "SALE" ? out.payment : s.payment;
    if (s.payment === "DEPOSIT" && out.kind === "SALE") out.kind = "DEPOSIT";
    delete out.accountId;
  }
  if (s.accountHints.length) {
    out.accountHints = [...s.accountHints];
    delete out.accountId;
  }
  if (s.fromAccountHints.length) {
    out.fromHints = [...s.fromAccountHints];
    delete out.fromAccountId;
  }
  if (s.warrantyMonths !== undefined) out.warrantyMonths = s.warrantyMonths;
  if (s.einvoiceNo) out.einvoiceNo = s.einvoiceNo;
  if (s.saleCode) {
    out.saleCode = s.saleCode;
    delete out.saleId;
  }
  if (s.batchCode) {
    out.batchCode = s.batchCode;
    delete out.purchaseOrderId;
    delete out.target;
  }
  if (s.tracking) {
    out.tracking = s.tracking;
    delete out.target;
  }
  if (s.directShip) out.directShip = true;
  if (s.note) out.note = s.note;
  const f = fold(text);
  if (/\b(khong giao thang|bo giao thang)\b/.test(f)) out.directShip = false;
  // "đổi thành cọc" / "cọc" (không kèm số tiền) → phiếu cọc, hỏi tiền cọc
  if (out.kind === "SALE" && /\b(coc|dat coc)\b/.test(f) && !s.money.some((m) => m.role === "deposit")) {
    out.kind = "DEPOSIT";
    out.payment = "DEPOSIT";
  }

  const sale = out.kind === "SALE" || out.kind === "DEPOSIT";
  for (const m of s.money) {
    if (m.role === "discount") out.discount = m.vnd;
    else if (m.role === "ship" && sale) out.shippingFee = m.vnd;
    else if (m.role === "deposit" && sale) {
      out.deposit = m.vnd;
      out.kind = "DEPOSIT";
      out.payment = "DEPOSIT";
    } else if (m.role === "paid" && sale) out.paid = m.vnd;
    else if (sale) {
      const lines = out.lines?.length ? out.lines : [{}];
      // "giá 26tr" sửa mọi dòng chưa / đã có giá khi chỉ có một máy; nhiều máy thì sửa dòng đầu chưa có giá, không thì cả đơn
      const target = lines.length === 1 ? lines : lines.filter((l) => !l.price).slice(0, 1);
      for (const l of target.length ? target : lines) {
        l.price = m.vnd;
        if (m.alt) l.priceAlt = m.alt;
        else delete l.priceAlt;
      }
      out.lines = lines;
    } else {
      out.amount = m.vnd;
      if (m.alt) out.amountAlt = m.alt;
      else delete out.amountAlt;
      delete out.usd;
    }
  }
  if (s.usd.length) {
    out.usd = s.usd[0].usd;
    if (out.kind === "PURCHASE_ITEMS") delete out.amount;
  }
  if (s.codes.length) {
    if (sale || out.kind === "TARGET_PRICE") {
      const fresh = s.codes.map((c) => ({ code: c.value, codeKind: c.kind, line: c.line }) as DraftLine);
      const lines = out.lines ?? [];
      // thay các dòng chưa có máy trước, còn lại thêm vào
      for (const nl of fresh) {
        const empty = lines.find((l) => !l.code && !l.itemId);
        if (empty) Object.assign(empty, nl, { itemId: undefined });
        else if (!lines.some((l) => l.code === nl.code)) lines.push({ ...nl, price: lines[0]?.price });
      }
      out.lines = lines;
    } else if (out.kind === "PURCHASE_ITEMS") {
      const have = new Set((out.codes ?? []).map((c) => c.value));
      out.codes = [...(out.codes ?? []), ...s.codes.filter((c) => !have.has(c.value)).map((c) => ({ kind: c.kind, value: c.value, line: c.line }))];
    }
  }
  if (s.variantIds.length) {
    out.variantIds = [...s.variantIds];
    out.productText = s.productText;
    if (out.kind === "PURCHASE_ITEMS" && s.variantIds.length === 1) out.variantId = s.variantIds[0];
    if (sale) for (const l of out.lines ?? []) if (!l.code) delete l.itemId;
  }
  if (out.kind === "LEDGER_ENTRY") {
    const c = guessCategory(text);
    if (c && c !== "OPEX_OTHER" && c !== "OTHER_IN") out.categoryCode = c;
  }
  if (out.kind === "LANDED_COST") {
    const k = guessCostKind(text);
    if (k) out.costKind = k;
  }
  return out;
}

/** Dòng bảng kê nháp tương ứng với một bản nháp (khi chưa ghi thật được). */
export interface BangKeDraft {
  kind: "SALE" | "DEPOSIT" | "PURCHASE" | "EXPENSE" | "INCOME" | "PAYMENT" | "OTHER";
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
}

const INCOME_CATEGORIES = new Set(["CAPITAL_IN", "OTHER_IN"]);
export function bangKeFromDraft(d: Draft): BangKeDraft {
  const kind: BangKeDraft["kind"] =
    d.kind === "SALE"
      ? "SALE"
      : d.kind === "DEPOSIT"
        ? "DEPOSIT"
        : d.kind === "PURCHASE_ITEMS"
          ? "PURCHASE"
          : d.kind === "LEDGER_ENTRY"
            ? INCOME_CATEGORIES.has(d.categoryCode ?? "")
              ? "INCOME"
              : "EXPENSE"
            : d.kind === "LANDED_COST"
              ? "EXPENSE"
              : d.kind === "PAYMENT" || d.kind === "COMPLETE_DEPOSIT"
                ? "PAYMENT"
                : "OTHER";
  const codes = [...(d.lines ?? []).map((l) => l.code), ...(d.codes ?? []).map((c) => c.value)].filter(Boolean);
  const price = d.lines?.find((l) => l.price)?.price ?? d.amount ?? (d.usd ? `$${d.usd}` : null);
  return {
    kind,
    occurredOn: d.date ?? null,
    modelText: d.productText ?? null,
    code: codes.length ? codes.join(" ") : null,
    priceText: price ?? null,
    customerText: d.customerName ?? d.counterparty ?? null,
    customerPhone: d.phone ?? null,
    channel: d.channel ?? null,
    payment: d.kind === "DEPOSIT" && d.deposit ? `cọc ${d.deposit}` : (d.payment ?? null),
    refText: d.saleCode ?? d.batchCode ?? d.tracking ?? null,
    note: d.note ?? null,
  };
}
