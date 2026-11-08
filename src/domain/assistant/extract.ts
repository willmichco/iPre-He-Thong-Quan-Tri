/**
 * Trợ lý — trích các ô thông tin từ một câu nhắn: IMEI / Serial, tiền (kèm vai trò: giá, cọc, giảm, ship…), ngày / kỳ,
 * SĐT, tên khách (giữ dấu), kênh bán, cách thanh toán, gợi ý tài khoản, bảo hành, số lượng, mã đơn bán / chuyến,
 * vận đơn, số hoá đơn, giao thẳng, ghi chú — và phần chữ còn lại để khớp dòng máy.
 * Mọi số tiền là chuỗi (bigint không chuyển qua JSON được).
 */
import { classifyCode, isSerialFormat, isValidImei } from "../identifiers";
import { rankVariants, type VariantRef } from "../purchasing-core";
import type { Channel } from "../sales-core";
import { detectTracking } from "../tracking";
import { dateAt } from "./dates";
import { moneyAt, usdAt } from "./money";
import { fold, titleCase, tokenize, type Token } from "./normalize";

export type PaymentWord = "TRANSFER" | "CASH" | "DEPOSIT" | "UNPAID";
export type MoneyRole = "price" | "deposit" | "paid" | "discount" | "ship" | "fee";

export interface CodeSlot {
  /** IMEI: đủ 15 số đúng Luhn · IMEI_BAD: 15 số sai số kiểm tra (gõ nhầm) · SERIAL · PARTIAL: vài số cuối ("đuôi 4567") */
  kind: "IMEI" | "IMEI_BAD" | "SERIAL" | "PARTIAL";
  value: string;
  /** dòng (khi nhắn nhiều dòng) */
  line: number;
}
export interface MoneySlot {
  vnd: string;
  raw: string;
  alt?: string;
  role: MoneyRole;
  line: number;
}
export interface UsdSlot {
  usd: string;
  raw: string;
  line: number;
}
export interface PeriodSlot {
  ky?: string;
  tu?: string;
  den?: string;
}

export interface Slots {
  codes: CodeSlot[];
  money: MoneySlot[];
  usd: UsdSlot[];
  date?: string;
  period?: PeriodSlot;
  phone?: string;
  customerName?: string;
  channel?: Channel;
  payment?: PaymentWord;
  /** từ gợi ý tài khoản (đã fold): "vcb", "tien mat", "techcombank"… */
  accountHints: string[];
  /** gợi ý tài khoản chuyển đi (chuyển tiền "từ … sang …") */
  fromAccountHints: string[];
  qty?: number;
  warrantyMonths?: number;
  saleCode?: string;
  batchCode?: string;
  tracking?: string;
  einvoiceNo?: string;
  directShip?: boolean;
  /** "mỗi máy" — một giá cho từng máy */
  each?: boolean;
  /** "tổng" — giá là tổng cả đơn */
  total?: boolean;
  /** "trên 45 ngày" */
  days?: number;
  note?: string;
  zalo?: string;
  /** chữ còn lại (giữ dấu) — để khớp dòng máy / danh mục */
  rest: string;
  /** cấu hình khớp với chữ còn lại (cao điểm trước; nhiều = mơ hồ) */
  variantIds: string[];
  /** chữ đã dùng để khớp cấu hình */
  productText?: string;
  /** số dòng có mã máy (nhắn nhiều dòng) */
  lines: number;
}

export interface ExtractCtx {
  today: string;
  variants: readonly VariantRef[];
  /** tên tài khoản (để nhận "tk Ngân hàng chính") */
  accountNames?: readonly string[];
}

// ---- bảng từ ----------------------------------------------------------------------------------------------

const CHANNEL_PHRASES: [string, Channel][] = [
  ["facebook", "FACEBOOK"],
  ["fb", "FACEBOOK"],
  ["face", "FACEBOOK"],
  ["messenger", "FACEBOOK"],
  ["zalo", "ZALO"],
  ["zl", "ZALO"],
  ["tiktok", "TIKTOK"],
  ["tik tok", "TIKTOK"],
  ["shopee", "SHOPEE"],
  ["tai shop", "WALK_IN"],
  ["tai cua hang", "WALK_IN"],
  ["truc tiep", "WALK_IN"],
  ["khach den", "WALK_IN"],
  ["khach ghe", "WALK_IN"],
  ["walk in", "WALK_IN"],
  ["gioi thieu", "REFERRAL"],
  ["nguoi quen", "REFERRAL"],
];
const PAYMENT_PHRASES: [string, PaymentWord][] = [
  ["chuyen khoan", "TRANSFER"],
  ["ck", "TRANSFER"],
  ["bank", "TRANSFER"],
  ["banking", "TRANSFER"],
  ["tien mat", "CASH"],
  ["tm", "CASH"],
  ["cash", "CASH"],
  ["ghi no", "UNPAID"],
  ["chua tra", "UNPAID"],
  ["chua thanh toan", "UNPAID"],
  ["tra sau", "UNPAID"],
  ["cong no", "UNPAID"],
  ["no lai", "UNPAID"],
];
/** viết tắt tên ngân hàng / ví → từ thường có trong tên tài khoản */
export const ACCOUNT_ALIASES: Record<string, string[]> = {
  vcb: ["vietcombank", "vcb"],
  vietcombank: ["vietcombank", "vcb"],
  tcb: ["techcombank", "tcb"],
  techcombank: ["techcombank", "tcb"],
  mb: ["mb", "mbbank", "quan doi"],
  mbbank: ["mb", "mbbank"],
  acb: ["acb"],
  bidv: ["bidv"],
  vtb: ["vietinbank", "vtb"],
  vietinbank: ["vietinbank", "vtb"],
  vpb: ["vpbank", "vpb"],
  vpbank: ["vpbank", "vpb"],
  tpb: ["tpbank", "tpb"],
  tpbank: ["tpbank", "tpb"],
  vib: ["vib"],
  agribank: ["agribank"],
  sacombank: ["sacombank", "stb"],
  stb: ["sacombank", "stb"],
  shb: ["shb"],
  hdbank: ["hdbank"],
  ocb: ["ocb"],
  msb: ["msb"],
  momo: ["momo"],
  zalopay: ["zalopay"],
  visa: ["visa", "the"],
  the: ["the", "card", "visa"],
  "tien mat": ["tien mat", "cash"],
  "ngan hang": ["ngan hang", "bank"],
};

/** từ không bao giờ là tên khách */
const NAME_STOP = new Set(
  (
    "ban mua nhap chot coc dat gia tien mat ck tm chuyen khoan zalo zl fb face facebook tiktok shopee hom nay qua kia ngay thang tuan nam quy thu cn " +
    "imei serial sn sdt so dt dien thoai bh bao hanh ship giam phi no tra truoc sau roi da voi va luc o tai shop may con cai chiec hop " +
    "iphone ipad mac macbook airpods watch pro max plus mini air ultra se gb tb la nhe nha xem hoi biet minh toi tui gui giao lay thu chi " +
    "quang cao don hang kien chuyen van mot hai ba bon nam sau bay tam chin muoi trieu tr nghin k cu ty vnd dong duoi ma cua them moi " +
    "khach kh hoan tat thanh toan tong cong lai doanh von gop rut nop thue hoa hd vao ra sang tu den toi gia ban muc tieu niem yet " +
    "silver black white blue gold pink green purple red natural desert titan den trang xanh hong vang tim do bac gi nao ai bao nhieu nhieu " +
    "duoc khong ko chua co cho kiem tra tra cuu ghi luu xuat excel file nhan hang"
  ).split(" "),
);
const HONOR_FULL: Record<string, string> = {
  anh: "Anh",
  a: "Anh",
  chi: "Chị",
  c: "Chị",
  em: "Em",
  e: "Em",
  co: "Cô",
  chu: "Chú",
  ban: "Bạn",
  bac: "Bác",
  ong: "Ông",
  ba: "Bà",
  cau: "Cậu",
  di: "Dì",
  thim: "Thím",
};
/** danh xưng không dấu trùng với từ thường ("chi" = chi tiền, "ban" = bán, "co" = có, "ba" = 3) — chỉ nhận khi gõ có dấu */
const HONOR_ACCENTED: Record<string, string> = { chi: "chị", ban: "bạn", co: "cô", ba: "bà", chu: "chú", bac: "bác", di: "dì", cau: "cậu" };

// ---- tiện ích ---------------------------------------------------------------------------------------------

/** chiều dài cụm từ (đã fold, cách nhau dấu cách) khớp tại token i, 0 nếu không khớp */
function phraseLen(tokens: readonly Token[], i: number, phrase: string): number {
  const words = phrase.split(" ");
  for (let k = 0; k < words.length; k++) if (tokens[i + k]?.f !== words[k]) return 0;
  return words.length;
}
/** từ chắc chắn không phải tên kể cả khi viết hoa (kênh, thanh toán, thời gian, từ khoá nghiệp vụ) */
const NAME_HARD_STOP = new Set(
  (
    "zalo zl fb face facebook tiktok shopee ck tm imei serial sn sdt bh ship hom ngay quy cn gia coc chuyen khoan tien mat " +
    "giam phi no tra roi da voi va luc tai shop may iphone ipad mac macbook airpods watch pro max plus mini gb tb trieu tr nghin vnd dong hd"
  ).split(" "),
);
const isNameWord = (t: Token | undefined, vocab: ReadonlySet<string>) =>
  !!t &&
  /^\p{L}+$/u.test(t.raw) &&
  !NAME_HARD_STOP.has(t.f) &&
  // từ thường ("minh", "nam", "tam") chỉ là tên khi viết hoa ("Minh", "Nam", "Tâm")
  (/^\p{Lu}/u.test(t.raw) || (!NAME_STOP.has(t.f) && !vocab.has(t.f))) &&
  (t.f.length >= 2 || /^\p{Lu}$/u.test(t.raw));

/**
 * Gộp dãy số bị gõ cách / chấm / gạch thành một mã khi ghép lại ra IMEI (15 số đúng Luhn) hoặc SĐT:
 * "35 6789 0123 45678" → "356789012345678", "0901 234 567" → "0901234567". Số tiền "25.500.000" giữ nguyên.
 */
export function mergeDigitGroups(text: string): string {
  // nhóm số đứng sát chữ ("6tr5", "256gb") không thuộc dãy số cần gộp
  return text.replace(/\+?\d+(?:[ .-]\d+(?![\p{L}\d]))+/gu, (run) => {
    const groups = run.split(/[ .-]/);
    const out: string[] = [];
    let s = 0;
    while (s < groups.length) {
      let best = -1;
      let acc = "";
      for (let e = s; e < groups.length && acc.length < 16; e++) {
        acc += groups[e].replace(/^\+/, "");
        const isImei = acc.length === 15 && isValidImei(acc);
        // di động 10 số (03/05/07/08/09…), cố định 11 số (02…), hoặc +84
        const isPhone = e > s && /^(0[35789]\d{8}|02\d{9}|84[35789]\d{8})$/.test(acc);
        if (isImei || isPhone) best = e;
      }
      if (best > s) {
        out.push(
          groups
            .slice(s, best + 1)
            .join("")
            .replace(/^\+?84/, "0"),
        );
        s = best + 1;
      } else {
        out.push(groups[s]);
        s += 1;
      }
    }
    // giữ dấu phân cách gốc giữa các phần không gộp (25.500.000 vẫn là 25.500.000)
    if (out.length === groups.length) return run;
    return out.join(" ");
  });
}

/** Từ ngữ của danh mục máy (để không lấy nhầm làm tên khách). */
export function vocabOf(variants: readonly VariantRef[]): Set<string> {
  const s = new Set<string>();
  for (const v of variants) for (const w of fold(`${v.label} ${v.sku}`).split(/[\s·,/-]+/)) if (w) s.add(w);
  return s;
}

/** Cấu hình khớp với chữ còn lại: thử mọi đoạn liền nhau, ưu tiên đoạn khớp nhiều từ nhất. */
export function matchProduct(words: readonly string[], variants: readonly VariantRef[]): { ids: string[]; text: string } | null {
  if (!words.length || !variants.length) return null;
  let best: { ids: string[]; text: string; n: number; raw: number } | null = null;
  const n = Math.min(words.length, 8);
  for (let len = n; len >= 1; len--) {
    for (let a = 0; a + len <= words.length; a++) {
      const seg = words.slice(a, a + len);
      // một từ đứng riêng phải đủ nghĩa: không nhận số trần ngắn ("2") hay từ 1–2 chữ ("a")
      if (len === 1 && (seg[0].length < 3 || /^\d{1,2}$/.test(seg[0]))) continue;
      const ranked = rankVariants(seg.join(" "), variants);
      if (!ranked.length) continue;
      const top = ranked[0].raw;
      const ids = ranked.filter((r) => r.raw === top).map((r) => r.v.id);
      if (!best || len > best.n || (len === best.n && top > best.raw)) best = { ids, text: seg.join(" "), n: len, raw: top };
    }
    if (best) break;
  }
  return best ? { ids: best.ids, text: best.text } : null;
}

// ---- trích ------------------------------------------------------------------------------------------------

const ROLE_BEFORE: [string, MoneyRole][] = [
  ["dat coc", "deposit"],
  ["coc", "deposit"],
  ["coc truoc", "deposit"],
  ["giu may", "deposit"],
  ["giam gia", "discount"],
  ["giam", "discount"],
  ["bot", "discount"],
  ["chiet khau", "discount"],
  ["phi ship", "ship"],
  ["ship", "ship"],
  ["phi giao", "ship"],
  ["tien ship", "ship"],
  ["tra truoc", "paid"],
  ["da tra", "paid"],
  ["da thu", "paid"],
  ["tra them", "paid"],
  ["thu them", "paid"],
  ["tra", "paid"],
  ["phi", "fee"],
];

export function extractSlots(text: string, ctx: ExtractCtx): Slots {
  const slots: Slots = { codes: [], money: [], usd: [], accountHints: [], fromAccountHints: [], rest: "", variantIds: [], lines: 0 };
  const vocab = vocabOf(ctx.variants);
  const rawLines = text.split(/\r?\n/);
  const tokens: (Token & { line: number })[] = [];
  rawLines.forEach((l, line) => {
    for (const t of tokenize(mergeDigitGroups(l))) tokens.push({ ...t, line });
  });
  const used = new Array<boolean>(tokens.length).fill(false);
  const take = (i: number, len: number) => {
    for (let k = i; k < i + len && k < tokens.length; k++) used[k] = true;
  };
  const f = (i: number) => tokens[i]?.f ?? "";

  // ghi chú: "ghi chú …" / "note …" → phần còn lại của dòng
  for (let i = 0; i < tokens.length; i++) {
    const len = phraseLen(tokens, i, "ghi chu") || phraseLen(tokens, i, "note") || phraseLen(tokens, i, "gc");
    if (len && !used[i]) {
      const line = tokens[i].line;
      const rest = tokens.filter((t, k) => k >= i + len && t.line === line);
      if (rest.length) {
        slots.note = rawLines[line].slice(rest[0].start).trim();
        take(i, len + rest.length);
      }
      break;
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    const t = tokens[i];
    const u = t.raw.toUpperCase();

    // mã đơn bán / mã chuyến
    if (/^BH-\d{4}-\d+$/.test(u)) {
      slots.saleCode ??= u;
      take(i, 1);
      continue;
    }
    if (/^CH-\d{4}-\d+$/.test(u)) {
      slots.batchCode ??= u;
      take(i, 1);
      continue;
    }
    // link tra cứu / vận đơn UPS 1Z…
    if (/^https?:\/\//i.test(t.raw) || /^1Z[0-9A-Z]{16}$/.test(u)) {
      const d = detectTracking(t.raw)[0];
      if (d) {
        slots.tracking ??= d.number;
        take(i, 1);
        continue;
      }
    }
    // "kiện / vận đơn / awb / tracking <mã>"
    {
      const cue = phraseLen(tokens, i, "van don") || phraseLen(tokens, i, "kien") || phraseLen(tokens, i, "awb") || phraseLen(tokens, i, "tracking") || phraseLen(tokens, i, "bill");
      const nx = tokens[i + cue];
      if (cue && nx && /^[0-9A-Za-z-]{8,34}$/.test(nx.raw) && /\d/.test(nx.raw) && !isValidImei(nx.raw)) {
        slots.tracking ??= nx.raw.replace(/-/g, "").toUpperCase();
        take(i, cue + 1);
        continue;
      }
    }
    // số hoá đơn: "hđ 0001234" · "hoá đơn số 123" · "số hđ 123"
    {
      let cue = phraseLen(tokens, i, "so hoa don") || phraseLen(tokens, i, "so hd") || phraseLen(tokens, i, "hoa don dien tu") || phraseLen(tokens, i, "hoa don") || phraseLen(tokens, i, "hddt") || phraseLen(tokens, i, "hd");
      if (cue && f(i + cue) === "so") cue += 1;
      const nx = tokens[i + cue];
      if (cue && nx && /^[A-Za-z0-9/-]*\d{3,}[A-Za-z0-9/-]*$/.test(nx.raw) && !/^BH-/i.test(nx.raw) && moneyAt(tokens, i + cue) === null) {
        slots.einvoiceNo ??= nx.raw.toUpperCase();
        take(i, cue + 1);
        continue;
      }
    }
    // SĐT
    if (/^(\+?84|0)\d{9,10}$/.test(t.f) && !isValidImei(t.f)) {
      slots.phone ??= t.f.replace(/^\+?84/, "0");
      // "sđt 09…" / "số 09…"
      take(i, 1);
      if (i > 0 && /^(sdt|dt|so|phone|tel)$/.test(f(i - 1))) used[i - 1] = true;
      continue;
    }
    // IMEI / Serial
    {
      const c = classifyCode(t.raw);
      if (c.kind === "IMEI") {
        slots.codes.push({ kind: "IMEI", value: c.value, line: t.line });
        take(i, 1);
        if (i > 0 && /^(imei|imei1|imei2)$/.test(f(i - 1))) used[i - 1] = true;
        continue;
      }
      if (/^\d{15}$/.test(t.f)) {
        slots.codes.push({ kind: "IMEI_BAD", value: t.f, line: t.line });
        take(i, 1);
        continue;
      }
      const s = c.kind === "SERIAL" ? c.value : null;
      if (s && isSerialFormat(s) && /[A-Z]/.test(s) && /\d/.test(s) && !vocab.has(t.f)) {
        slots.codes.push({ kind: "SERIAL", value: s, line: t.line });
        take(i, 1);
        if (i > 0 && /^(serial|sn|seri|so seri)$/.test(f(i - 1))) used[i - 1] = true;
        continue;
      }
    }
    // "đuôi 4567" · "imei 4567" · "serial ABC12" → vài ký tự cuối
    if (/^(duoi|imei|serial|sn|seri)$/.test(t.f)) {
      const nx = tokens[i + 1];
      const full = nx ? classifyCode(nx.raw).kind : "UNKNOWN";
      if (nx && full !== "IMEI" && !(full === "SERIAL" && /[A-Z]/i.test(nx.raw) && /\d/.test(nx.raw)) && /^[0-9A-Za-z]{4,16}$/.test(nx.raw) && /\d/.test(nx.raw) && !/^\d{1,3}$/.test(nx.raw) && moneyAt(tokens, i + 1) === null) {
        slots.codes.push({ kind: "PARTIAL", value: nx.raw.toUpperCase(), line: nx.line });
        take(i, 2);
        continue;
      }
    }
    // bảo hành: "bh 12 tháng" · "bảo hành 1 năm" · "không bảo hành" · "bh12"
    {
      const neg = phraseLen(tokens, i, "khong bao hanh") || phraseLen(tokens, i, "ko bao hanh") || phraseLen(tokens, i, "khong bh") || phraseLen(tokens, i, "ko bh");
      if (neg) {
        slots.warrantyMonths = 0;
        take(i, neg);
        continue;
      }
      const cue = phraseLen(tokens, i, "bao hanh") || phraseLen(tokens, i, "bh");
      const glued = /^bh(\d{1,2})(t|th|thang)?$/.exec(t.f);
      if (glued) {
        slots.warrantyMonths = +glued[1];
        take(i, 1);
        continue;
      }
      if (cue && /^\d{1,2}$/.test(f(i + cue))) {
        const n = +f(i + cue);
        const unit = f(i + cue + 1);
        const years = unit === "nam";
        slots.warrantyMonths = years ? n * 12 : n;
        take(i, cue + 1 + (/^(t|th|thang|nam)$/.test(unit) ? 1 : 0));
        continue;
      }
    }
    // số lượng: "2 máy" · "3 con" · "x2"
    if (/^\d{1,2}$/.test(t.f) && /^(may|con|cai|chiec|hop|em)$/.test(f(i + 1))) {
      slots.qty ??= +t.f;
      take(i, 2);
      continue;
    }
    if (/^x\d{1,2}$/.test(t.f)) {
      slots.qty ??= +t.f.slice(1);
      take(i, 1);
      continue;
    }
    // "trên 45 ngày" · "quá 45 ngày" · "hơn 45 ngày" · ">45 ngày"
    if (/^(tren|qua|hon|>|>=)$/.test(t.f) && /^\d{1,4}$/.test(f(i + 1)) && f(i + 2) === "ngay") {
      slots.days = +f(i + 1);
      take(i, 3);
      continue;
    }
    // ngày / kỳ
    {
      const d = dateAt(tokens, i, ctx.today);
      if (d) {
        if (d.kind === "day") {
          slots.date ??= d.date;
          slots.period ??= { tu: d.date, den: d.date };
        } else slots.period ??= { ky: d.ky, tu: d.tu, den: d.den };
        take(i, d.len);
        continue;
      }
    }
    // USD
    {
      const m = usdAt(tokens, i);
      if (m) {
        slots.usd.push({ usd: m.usd, raw: m.raw, line: t.line });
        take(i, m.len);
        continue;
      }
    }
    // VND
    {
      const m = moneyAt(tokens, i);
      if (m) {
        let role: MoneyRole = "price";
        for (const back of [1, 2]) {
          const phrase = tokens
            .slice(Math.max(0, i - back), i)
            .map((x) => x.f)
            .join(" ");
          const r = ROLE_BEFORE.find(([p]) => p === phrase);
          if (r) {
            role = r[1];
            take(i - back, back);
            break;
          }
        }
        slots.money.push({ vnd: m.vnd.toString(), raw: m.raw, ...(m.alt !== undefined ? { alt: m.alt.toString() } : {}), role, line: t.line });
        take(i, m.len);
        continue;
      }
    }
    // giao thẳng
    {
      const len = phraseLen(tokens, i, "giao thang") || phraseLen(tokens, i, "ship thang") || phraseLen(tokens, i, "gui thang") || phraseLen(tokens, i, "ban thang");
      if (len) {
        slots.directShip = true;
        take(i, len);
        continue;
      }
    }
    // "mỗi máy" / "tổng"
    if (t.f === "moi" && /^(may|con|cai|chiec)$/.test(f(i + 1))) {
      slots.each = true;
      take(i, 2);
      continue;
    }
    if ((t.f === "tong" && f(i + 1) !== "ket") || phraseLen(tokens, i, "tong cong")) {
      slots.total = true;
      take(i, phraseLen(tokens, i, "tong cong") || 1);
      continue;
    }
    // kênh bán
    {
      const hit = CHANNEL_PHRASES.map(([p, c]) => [phraseLen(tokens, i, p), c] as const).find(([n]) => n > 0);
      if (hit) {
        slots.channel ??= hit[1];
        // "zalo lan.nguyen" (khi thêm khách) — tên zalo ngay sau
        const nx = tokens[i + hit[0]];
        if (hit[1] === "ZALO" && nx && /^[a-z0-9._]{3,}$/i.test(nx.raw) && /[._]/.test(nx.raw)) {
          slots.zalo = nx.raw;
          take(i, hit[0] + 1);
        } else take(i, hit[0]);
        continue;
      }
    }
    // tài khoản: "từ tiền mặt sang vcb" (chuyển tiền) · "vào vcb" · "tk techcombank"
    {
      const fromCue = t.f === "tu" ? 1 : 0;
      const toCue = /^(sang|vao|qua|toi)$/.test(t.f) ? 1 : 0;
      const tkCue = phraseLen(tokens, i, "tai khoan") || (t.f === "tk" ? 1 : 0);
      const at = i + Math.max(fromCue, toCue, tkCue);
      const aliasLen = (k: number) => {
        for (const key of Object.keys(ACCOUNT_ALIASES).sort((a, b) => b.length - a.length)) {
          const n = phraseLen(tokens, k, key);
          if (n) return { n, key };
        }
        return null;
      };
      // tên tài khoản gõ đúng ("tk Ngân hàng chính") — thử trước bí danh
      if (tkCue && ctx.accountNames?.length) {
        const restF = tokens
          .slice(at, at + 6)
          .map((x) => x.f)
          .join(" ");
        const name = ctx.accountNames
          .map((n) => fold(n).replace(/[()]/g, "").replace(/\s+/g, " ").trim())
          .sort((a, b) => b.length - a.length)
          .find((n) => restF === n || restF.startsWith(`${n} `));
        if (name) {
          slots.accountHints.push(name);
          take(i, at - i + name.split(" ").length);
          continue;
        }
      }
      const alias = aliasLen(at);
      // chỉ nhận chữ trơn "tiền mặt" là tài khoản khi có từ dẫn ("từ tiền mặt", "vào tiền mặt"); không thì là cách thanh toán
      if (alias && (at > i || (alias.key !== "tien mat" && alias.key !== "the" && alias.key !== "ngan hang"))) {
        (fromCue ? slots.fromAccountHints : slots.accountHints).push(alias.key);
        take(i, at - i + alias.n);
        continue;
      }
    }
    // cách thanh toán
    {
      const hit = PAYMENT_PHRASES.map(([p, c]) => [phraseLen(tokens, i, p), c] as const).find(([n]) => n > 0);
      if (hit) {
        slots.payment ??= hit[1];
        take(i, hit[0]);
        continue;
      }
    }
    // tên khách: "cho chị Lan" · "khách Minh" · "a Nam" · "chị Lan"
    {
      let k = i;
      let honor: string | null = null;
      let cued = false;
      if (/^(cho|khach|kh)$/.test(t.f)) {
        cued = true;
        k = i + 1;
        if (f(k) === "hang") k += 1;
        if (f(k) === "le" || f(k) === "moi") k += 1;
      }
      const h = tokens[k];
      if (h && HONOR_FULL[h.f] !== undefined) {
        const accented = HONOR_ACCENTED[h.f];
        const ok = !accented || h.raw.toLowerCase() === accented || cued || /^\p{Lu}/u.test(tokens[k + 1]?.raw ?? "");
        if (ok && isNameWord(tokens[k + 1], vocab)) {
          honor = HONOR_FULL[h.f];
          k += 1;
        }
      }
      if ((honor || cued) && isNameWord(tokens[k], vocab)) {
        const words: string[] = [];
        let e = k;
        while (e < tokens.length && words.length < 4 && isNameWord(tokens[e], vocab) && tokens[e].line === t.line) {
          words.push(tokens[e].raw);
          e++;
        }
        const name = titleCase([honor, ...words].filter(Boolean).join(" "));
        slots.customerName ??= name;
        take(i, e - i);
        continue;
      }
    }
  }

  // phần còn lại → dòng máy
  const restTokens = tokens.filter((_, k) => !used[k]);
  slots.rest = restTokens.map((t) => t.raw).join(" ");
  const words = restTokens.map((t) => t.f).filter((w) => !/^(may|con|cai|chiec|dien|thoai|hang|cua|la|nhe|nha|voi|va|o|tai|duoc|da|vua|moi|cu|gia|ban|cho|em|anh|minh)$/.test(w));
  const prod = matchProduct(words, ctx.variants);
  if (prod) {
    slots.variantIds = prod.ids;
    slots.productText = prod.text;
  }
  slots.lines = new Set(slots.codes.map((c) => c.line)).size;
  return slots;
}
