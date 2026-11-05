/**
 * Báo cáo — hàm thuần (kỳ báo cáo, bảng kết quả kinh doanh, nhóm theo quý). Không phụ thuộc CSDL / zod.
 * Ngày dạng "YYYY-MM-DD" theo giờ Việt Nam; kỳ là [from, toExcl) — `toExcl` là ngày ĐẦU TIÊN không thuộc kỳ.
 */
import { percentBp } from "./costing/money";

export const REPORTS = [
  { key: "lai-lo", label: "Lãi lỗ" },
  { key: "dong-may", label: "Dòng máy" },
  { key: "chuyen", label: "Chuyến" },
  { key: "kenh", label: "Kênh bán" },
  { key: "van-chuyen", label: "Vận chuyển" },
  { key: "ton-kho", label: "Tồn kho" },
  { key: "thue", label: "Doanh thu thuế" },
] as const;
export type ReportKey = (typeof REPORTS)[number]["key"];
export const isReportKey = (s: string): s is ReportKey => REPORTS.some((r) => r.key === s);

export const PRESETS = [
  { key: "thang", label: "Tháng này" },
  { key: "thang-truoc", label: "Tháng trước" },
  { key: "quy", label: "Quý này" },
  { key: "quy-truoc", label: "Quý trước" },
  { key: "nam", label: "Năm nay" },
  { key: "nam-truoc", label: "Năm trước" },
] as const;
export type PresetKey = (typeof PRESETS)[number]["key"];

export interface Range {
  /** preset đang chọn, hoặc "tuy-chon" khi nhập ngày */
  key: PresetKey | "tuy-chon";
  from: string;
  toExcl: string;
  label: string;
  prevFrom: string;
  prevToExcl: string;
  prevLabel: string;
}

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Ngày đầu tháng (tháng có thể tràn: m = 13 → tháng 1 năm sau). */
const ym = (y: number, m: number, d = 1) => iso(Date.UTC(y, m - 1, d));
export const addDays = (d: string, n: number) => iso(utc(d) + n * DAY);
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
/** Ngày thật "YYYY-MM-DD" (30/02 không hợp lệ — Date.UTC tự tràn sang tháng sau nên phải so lại). */
const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(utc(s)) === s;

/** Quý (1–4) của một ngày / tháng. */
export const quarterOf = (d: string) => Math.floor((+d.slice(5, 7) - 1) / 3) + 1;

function preset(key: PresetKey, today: string): Omit<Range, "prevFrom" | "prevToExcl" | "prevLabel"> {
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  const q = quarterOf(today);
  switch (key) {
    case "thang":
    case "thang-truoc": {
      const mm = key === "thang" ? m : m - 1;
      const from = ym(y, mm);
      return { key, from, toExcl: ym(y, mm + 1), label: `Tháng ${from.slice(5, 7)}/${from.slice(0, 4)}` };
    }
    case "quy":
    case "quy-truoc": {
      const start = (q - 1) * 3 + 1 - (key === "quy" ? 0 : 3);
      const from = ym(y, start);
      return { key, from, toExcl: ym(y, start + 3), label: `Quý ${quarterOf(from)}/${from.slice(0, 4)}` };
    }
    case "nam":
    case "nam-truoc": {
      const yy = key === "nam" ? y : y - 1;
      return { key, from: ym(yy, 1), toExcl: ym(yy + 1, 1), label: `Năm ${yy}` };
    }
  }
}

/** Kỳ trước để so sánh: tháng → tháng trước, quý → quý trước, năm → năm trước, tuỳ chọn → cùng độ dài liền trước. */
function previous(r: Omit<Range, "prevFrom" | "prevToExcl" | "prevLabel">): Pick<Range, "prevFrom" | "prevToExcl" | "prevLabel"> {
  const y = +r.from.slice(0, 4);
  const m = +r.from.slice(5, 7);
  if (r.key === "thang" || r.key === "thang-truoc") {
    const f = ym(y, m - 1);
    return { prevFrom: f, prevToExcl: r.from, prevLabel: `tháng ${f.slice(5, 7)}/${f.slice(0, 4)}` };
  }
  if (r.key === "quy" || r.key === "quy-truoc") {
    const f = ym(y, m - 3);
    return { prevFrom: f, prevToExcl: r.from, prevLabel: `quý ${quarterOf(f)}/${f.slice(0, 4)}` };
  }
  if (r.key === "nam" || r.key === "nam-truoc") return { prevFrom: ym(y - 1, 1), prevToExcl: r.from, prevLabel: `năm ${y - 1}` };
  // tuỳ chọn trọn tháng (01/10 – 31/12) → so với cùng số tháng liền trước (01/07 – 30/09)
  if (r.from.endsWith("-01") && r.toExcl.endsWith("-01")) {
    const n = (+r.toExcl.slice(0, 4) - y) * 12 + (+r.toExcl.slice(5, 7) - m);
    const f = ym(y, m - n);
    return { prevFrom: f, prevToExcl: r.from, prevLabel: `${dmy(f)} – ${dmy(addDays(r.from, -1))}` };
  }
  const len = Math.round((utc(r.toExcl) - utc(r.from)) / DAY);
  const f = addDays(r.from, -len);
  return { prevFrom: f, prevToExcl: r.from, prevLabel: `${dmy(f)} – ${dmy(addDays(r.from, -1))}` };
}

/**
 * Đọc kỳ báo cáo từ tham số trang: `ky` (preset) hoặc `tu` + `den` (ngày, tính cả ngày cuối).
 * Sai / thiếu → tháng này. Ngày ngược (từ > đến) được đảo lại; tối đa 3 năm.
 */
export function parseRange(p: { ky?: string | null; tu?: string | null; den?: string | null }, today: string): Range {
  if (isDate(p.tu) && isDate(p.den)) {
    const b = p.tu <= p.den ? p.den : p.tu;
    const first = p.tu <= p.den ? p.tu : p.den;
    const a = utc(b) - utc(first) > 3 * 366 * DAY ? addDays(b, -3 * 366) : first;
    const r = { key: "tuy-chon" as const, from: a, toExcl: addDays(b, 1), label: `${dmy(a)} – ${dmy(b)}` };
    return { ...r, ...previous(r) };
  }
  const key = PRESETS.some((x) => x.key === p.ky) ? (p.ky as PresetKey) : "thang";
  const r = preset(key, today);
  return { ...r, ...previous(r) };
}

/** Tham số URL của một kỳ (để giữ kỳ khi đổi báo cáo / xuất Excel). */
export function rangeQuery(r: Range): Record<string, string> {
  return r.key === "tuy-chon" ? { tu: r.from, den: addDays(r.toExcl, -1) } : { ky: r.key };
}

// ---- Bảng kết quả kinh doanh ----------------------------------------------------------------------------

export interface PnlNumbers {
  units: number;
  revenueVnd: bigint;
  cogsVnd: bigint;
  sellingExpenseVnd: bigint;
  opexVnd: bigint;
}

export interface StatementLine {
  key: string;
  label: string;
  kind: "line" | "subtotal" | "total";
  /** dấu hiển thị: dòng trừ hiện "−" */
  minus: boolean;
  current: bigint;
  previous: bigint;
  /** thay đổi so với kỳ trước (điểm cơ bản; null nếu kỳ trước = 0) */
  changeBp: number | null;
  /** tỷ lệ trên doanh thu (điểm cơ bản) */
  ofRevenueBp: number | null;
}

const change = (c: bigint, p: bigint) => (p === 0n ? null : percentBp(c - p, p < 0n ? -p : p));

/** Doanh thu → Giá vốn → Lãi gộp → Chi phí bán → Chi phí vận hành → Lãi ròng trước thuế. */
export function pnlStatement(cur: PnlNumbers, prev: PnlNumbers): StatementLine[] {
  const rows: [string, string, StatementLine["kind"], boolean, (n: PnlNumbers) => bigint][] = [
    ["revenue", "Doanh thu thuần", "line", false, (n) => n.revenueVnd],
    ["cogs", "Giá vốn hàng bán", "line", true, (n) => n.cogsVnd],
    ["gross", "Lãi gộp", "subtotal", false, (n) => n.revenueVnd - n.cogsVnd],
    ["selling", "Chi phí bán hàng", "line", true, (n) => n.sellingExpenseVnd],
    ["opex", "Chi phí vận hành", "line", true, (n) => n.opexVnd],
    ["net", "Lãi ròng trước thuế", "total", false, (n) => n.revenueVnd - n.cogsVnd - n.sellingExpenseVnd - n.opexVnd],
  ];
  return rows.map(([key, label, kind, minus, f]) => ({
    key,
    label,
    kind,
    minus,
    current: f(cur),
    previous: f(prev),
    changeBp: change(f(cur), f(prev)),
    ofRevenueBp: cur.revenueVnd > 0n ? percentBp(f(cur), cur.revenueVnd) : null,
  }));
}

/** Gom các tháng ("YYYY-MM-01") thành quý, cộng các trường số (bigint / number). */
export function byQuarter<T extends { month: string }>(rows: readonly T[], sum: (a: T, b: T) => T): { quarter: string; row: T }[] {
  const out: { quarter: string; row: T }[] = [];
  for (const r of rows) {
    const q = `Q${quarterOf(r.month)}/${r.month.slice(0, 4)}`;
    const last = out.at(-1);
    if (last?.quarter === q) last.row = sum(last.row, r);
    else out.push({ quarter: q, row: r });
  }
  return out;
}

/** Các tháng (ngày đầu tháng) trong kỳ [from, toExcl). */
export function monthsIn(from: string, toExcl: string): string[] {
  const y = +from.slice(0, 4);
  const m = +from.slice(5, 7);
  const out: string[] = [];
  for (let k = 0; k < 120; k++) {
    const d = ym(y, m + k);
    if (d >= toExcl) break;
    out.push(d);
  }
  return out;
}

/** Ma trận dòng máy: lãi cao / quay nhanh so với trung vị của chính danh sách. */
export function quadrant(marginBp: number | null, days: number | null, medMargin: number, medDays: number): "STAR" | "SLOW_RICH" | "FAST_THIN" | "WEAK" | null {
  if (marginBp === null || days === null) return null;
  const rich = marginBp >= medMargin;
  const fast = days <= medDays;
  return rich && fast ? "STAR" : rich ? "SLOW_RICH" : fast ? "FAST_THIN" : "WEAK";
}
export const QUADRANT_LABEL = {
  STAR: "Lãi cao · quay nhanh",
  SLOW_RICH: "Lãi cao · quay chậm",
  FAST_THIN: "Lãi mỏng · quay nhanh",
  WEAK: "Lãi mỏng · quay chậm",
} as const;

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** Ngưỡng doanh thu năm (thuế hộ kinh doanh): đã dùng bao nhiêu, còn bao nhiêu, mức cảnh báo. */
export function thresholdStatus(revenueVnd: bigint, thresholdVnd: bigint, warnRatio: number) {
  const usedBp = thresholdVnd > 0n ? (percentBp(revenueVnd, thresholdVnd) ?? 0) : 0;
  const level = usedBp >= 10000 ? ("OVER" as const) : usedBp >= Math.round(warnRatio * 10000) ? ("WARN" as const) : ("OK" as const);
  return { usedBp, remainingVnd: thresholdVnd - revenueVnd, level };
}
