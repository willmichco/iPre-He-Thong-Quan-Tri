/**
 * Tổng quan — phần thuần (tài liệu 01 mục 1 Q1/Q8, tài liệu 05 mục 4.1, tài liệu 04 mục 7):
 * kỳ báo cáo, vốn theo chặng, chuỗi 12 tháng, số gọn "412,5 tr", bộ quy tắc "Cần xử lý".
 */
import { percentBp } from "./costing";
import type { TrackAlert } from "./tracking";

// ---- Kỳ báo cáo -----------------------------------------------------------------------------------------

export const PERIODS = ["thang-nay", "thang-truoc", "nam-nay"] as const;
export type PeriodKey = (typeof PERIODS)[number];
export const PERIOD_LABEL: Record<PeriodKey, string> = { "thang-nay": "Tháng này", "thang-truoc": "Tháng trước", "nam-nay": "Năm nay" };

export interface Period {
  key: PeriodKey;
  label: string;
  /** ngày đầu kỳ (giờ VN, gồm) — YYYY-MM-DD */
  from: string;
  /** ngày sau cuối kỳ (giờ VN, không gồm) */
  to: string;
  /** kỳ liền trước cùng độ dài để so sánh (năm nay → cùng kỳ năm trước tới cùng ngày) */
  prevFrom: string;
  prevTo: string;
  prevLabel: string;
}

const ymd = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

export function parsePeriod(raw: string | undefined | null): PeriodKey {
  return (PERIODS as readonly string[]).includes(raw ?? "") ? (raw as PeriodKey) : "thang-nay";
}

/** Khoảng ngày của kỳ tính theo "hôm nay" giờ VN (YYYY-MM-DD). */
export function periodRange(key: PeriodKey, today: string): Period {
  const [y, m, d] = today.split("-").map(Number);
  if (key === "nam-nay") {
    const tomorrow = ymd(y, m, d + 1);
    return { key, label: `Năm ${y}`, from: ymd(y, 1), to: tomorrow, prevFrom: ymd(y - 1, 1), prevTo: ymd(y - 1, m, d + 1), prevLabel: `cùng kỳ ${y - 1}` };
  }
  const off = key === "thang-nay" ? 0 : -1;
  const from = ymd(y, m + off);
  const to = ymd(y, m + off + 1);
  const label = `Tháng ${from.slice(5, 7)}/${from.slice(0, 4)}`;
  const prevFrom = ymd(y, m + off - 1);
  return { key, label, from, to, prevFrom, prevTo: from, prevLabel: `tháng ${prevFrom.slice(5, 7)}/${prevFrom.slice(0, 4)}` };
}

/** 12 tháng kết thúc ở tháng của `today`: ["2025-12-01", …, "2026-11-01"]. */
export function last12Months(today: string): string[] {
  const [y, m] = today.split("-").map(Number);
  return Array.from({ length: 12 }, (_, k) => ymd(y, m - 11 + k));
}

export interface MonthPoint {
  month: string;
  revenueVnd: bigint;
  profitVnd: bigint;
  units: number;
}

/** Điền các tháng không bán được bằng 0 để biểu đồ đủ 12 cột. */
export function fillMonths(months: readonly string[], rows: readonly MonthPoint[]): MonthPoint[] {
  const by = new Map(rows.map((r) => [r.month.slice(0, 10), r]));
  return months.map((month) => by.get(month) ?? { month, revenueVnd: 0n, profitVnd: 0n, units: 0 });
}

// ---- Vốn theo chặng -------------------------------------------------------------------------------------

/** Các chặng hiển thị trên thanh "Vốn đang nằm ở đâu", đúng thứ tự đường đi của máy. */
export const STAGES = [
  { key: "ordered", label: "Đã đặt", statuses: ["ORDERED"] },
  { key: "us", label: "Nội địa Mỹ", statuses: ["US_IN_TRANSIT"] },
  { key: "us-wh", label: "Kho Mỹ", statuses: ["AT_US_WAREHOUSE"] },
  { key: "intl", label: "Mỹ → VN", statuses: ["INTL_IN_TRANSIT"] },
  { key: "hn", label: "Tại HN", statuses: ["AT_HN"] },
  { key: "hn-sg", label: "HN → SG", statuses: ["DOMESTIC_IN_TRANSIT"] },
  { key: "sg", label: "Tồn SG", statuses: ["IN_STOCK", "RESERVED"] },
  { key: "warranty", label: "Bảo hành", statuses: ["WARRANTY"] },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];

export interface StageRow {
  key: StageKey;
  label: string;
  statuses: readonly string[];
  itemCount: number;
  capitalVnd: bigint;
  /** tỷ trọng vốn, phần vạn (bp) */
  shareBp: number;
}

export function capitalByStage(rows: readonly { status: string; itemCount: number; capitalVnd: bigint }[]) {
  const total = rows.reduce((a, r) => a + r.capitalVnd, 0n);
  const count = rows.reduce((a, r) => a + r.itemCount, 0);
  const stages: StageRow[] = STAGES.map((s) => {
    const mine = rows.filter((r) => (s.statuses as readonly string[]).includes(r.status));
    const capital = mine.reduce((a, r) => a + r.capitalVnd, 0n);
    return {
      key: s.key,
      label: s.label,
      statuses: s.statuses,
      itemCount: mine.reduce((a, r) => a + r.itemCount, 0),
      capitalVnd: capital,
      shareBp: percentBp(capital, total) ?? 0,
    };
  });
  const inTransit = stages.filter((s) => s.key !== "sg" && s.key !== "warranty");
  return {
    stages,
    totalVnd: total,
    itemCount: count,
    /** vốn chưa về tới SG (còn đang trên đường) */
    onTheWayVnd: inTransit.reduce((a, s) => a + s.capitalVnd, 0n),
  };
}

export function stageForStatus(status: string): StageKey | null {
  return STAGES.find((s) => (s.statuses as readonly string[]).includes(status))?.key ?? null;
}

// ---- Hiển thị số gọn -----------------------------------------------------------------------------------

const oneDecimal = (n: bigint, unit: bigint) => {
  const tenths = (n * 10n + unit / 2n) / unit; // làm tròn nửa lên (n ≥ 0)
  const int = tenths / 10n;
  const frac = tenths % 10n;
  return `${int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}${frac ? `,${frac}` : ""}`;
};

/** 412.500.000 → "412,5 tr" · 1.234.000.000 → "1,2 tỷ" · 30.000 → "30 k" · 0 → "0". Số âm có dấu "−". */
export function shortVnd(v: bigint): string {
  const neg = v < 0n;
  const n = neg ? -v : v;
  const s =
    n >= 1_000_000_000n
      ? `${oneDecimal(n, 1_000_000_000n)} tỷ`
      : n >= 1_000_000n
        ? `${oneDecimal(n, 1_000_000n)} tr`
        : n >= 1_000n
          ? `${oneDecimal(n, 1_000n)} k`
          : n.toString();
  return neg ? `−${s}` : s;
}

/** 553 → "5,53 %" ; null → "—" */
export function formatBp(bp: number | null): string {
  if (bp === null) return "—";
  const neg = bp < 0;
  const a = Math.abs(bp);
  return `${neg ? "−" : ""}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")} %`;
}

/** Thay đổi so với kỳ trước, phần vạn; kỳ trước = 0 → null (không so được). */
export function changeBp(current: bigint, previous: bigint): number | null {
  if (previous === 0n) return null;
  const p = previous < 0n ? -previous : previous;
  return percentBp(current - previous, p) ?? null;
}

// ---- Cảnh báo "Cần xử lý" -------------------------------------------------------------------------------

export interface AlertSettings {
  agingDays: number;
  etaGraceDays: number;
  returnDeadlineDays: number;
  revenueThresholdVnd: bigint;
  thresholdWarningRatio: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  agingDays: 30,
  etaGraceDays: 2,
  returnDeadlineDays: 3,
  revenueThresholdVnd: 1_000_000_000n,
  thresholdWarningRatio: 0.8,
};

/** Đọc app_settings (giá trị jsonb dạng text) → cấu hình cảnh báo; giá trị hỏng thì giữ mặc định. */
export function alertSettingsFrom(rows: readonly { key: string; value: string }[]): AlertSettings {
  const get = (k: string) => {
    const r = rows.find((x) => x.key === k)?.value;
    if (r === undefined) return undefined;
    const v = r.replace(/^"|"$/g, "").trim();
    return /^\d+(\.\d+)?$/.test(v) ? v : undefined;
  };
  const int = (k: string, d: number) => {
    const v = get(k);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : d;
  };
  const ratio = Number(get("tax.threshold_warning_ratio") ?? NaN);
  const threshold = get("tax.revenue_threshold_vnd");
  const d = DEFAULT_ALERT_SETTINGS;
  return {
    agingDays: int("alert.aging_days", d.agingDays),
    etaGraceDays: int("alert.eta_grace_days", d.etaGraceDays),
    returnDeadlineDays: int("alert.return_deadline_days", d.returnDeadlineDays),
    revenueThresholdVnd: threshold && /^\d+$/.test(threshold) ? BigInt(threshold) : d.revenueThresholdVnd,
    thresholdWarningRatio: ratio > 0 && ratio <= 1 ? ratio : d.thresholdWarningRatio,
  };
}

export type AlertLevel = "critical" | "warning" | "info";
export const ALERT_LEVEL_LABEL: Record<AlertLevel, string> = { critical: "Gấp", warning: "Chú ý", info: "Nhắc" };
export const ALERT_LEVEL_ICON: Record<AlertLevel, string> = { critical: "!", warning: "!", info: "i" };

export interface Alert {
  kind: "SHIPMENT_LATE" | "SHIPMENT_HOLD" | "AGED_STOCK" | "RETURN_DEADLINE" | "RECEIVABLE" | "TAX_THRESHOLD" | "DEPOSIT_READY" | TrackAlert["kind"];
  level: AlertLevel;
  title: string;
  detail?: string;
  href: string;
}

export interface AlertInput {
  today: string;
  /** kiện đang đi / bị giữ (ETA có thể trống) */
  shipments: readonly { id: string; label: string; status: string; eta: string | null; heldSince: string | null }[];
  /** máy tồn SG (IN_STOCK/RESERVED) */
  stock: readonly { id: string; label: string; days: number | null; costVnd: bigint }[];
  /** đơn mua có hạn đổi trả, kèm số máy chưa kiểm được (chưa về SG) hoặc hư hỏng */
  returnDeadlines: readonly { poId: string; batchId: string; label: string; deadline: string; pendingItems: number }[];
  /** đơn bán còn nợ (hoàn tất hoặc cọc) */
  receivables: readonly { id: string; code: string; customer: string | null; status: string; balanceVnd: bigint }[];
  /** đơn cọc mà mọi máy đã về SG — giao được */
  depositsReady: readonly { id: string; code: string; customer: string | null }[];
  yearRevenueVnd: bigint;
  year: number;
  /** việc cần làm do bot theo dõi vận đơn phát hiện (domain/tracking) */
  trackAlerts?: readonly TrackAlert[];
}

const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const list = (xs: readonly string[], max = 3) => (xs.length > max ? `${xs.slice(0, max).join(", ")} và ${xs.length - max} khác` : xs.join(", "));

/** Bộ quy tắc cảnh báo (tài liệu 04 mục 7) — thứ tự: gấp → chú ý → nhắc. */
export function buildAlerts(input: AlertInput, cfg: AlertSettings = DEFAULT_ALERT_SETTINGS): Alert[] {
  const out: Alert[] = [...(input.trackAlerts ?? [])];
  const { today } = input;

  for (const s of input.shipments) {
    if (s.status === "HOLD") {
      const held = s.heldSince ? Math.max(0, days(today, s.heldSince.slice(0, 10))) : null;
      out.push({
        kind: "SHIPMENT_HOLD",
        level: "critical",
        title: `Kiện ${s.label} đang bị giữ hải quan${held !== null ? ` ${held} ngày` : ""}`,
        href: `/van-chuyen/${s.id}`,
      });
    } else if (s.status === "IN_TRANSIT" && s.eta) {
      const late = days(today, s.eta);
      if (late > cfg.etaGraceDays)
        out.push({
          kind: "SHIPMENT_LATE",
          level: "warning",
          title: `Kiện ${s.label} trễ ${late} ngày so với dự kiến`,
          detail: `ETA ${s.eta.split("-").reverse().join("/")}`,
          href: `/van-chuyen/${s.id}`,
        });
    }
  }

  for (const r of input.returnDeadlines) {
    if (r.pendingItems <= 0) continue;
    const left = days(r.deadline, today);
    if (left < 0 || left > cfg.returnDeadlineDays) continue;
    out.push({
      kind: "RETURN_DEADLINE",
      level: left <= 1 ? "critical" : "warning",
      title: `Đơn mua ${r.label} ${left === 0 ? "hết hạn đổi trả hôm nay" : `còn ${left} ngày hết hạn đổi trả`}`,
      detail: `${r.pendingItems} máy chưa kiểm được (chưa về SG hoặc hư hỏng)`,
      href: `/chuyen-hang/${r.batchId}`,
    });
  }

  const aged = input.stock.filter((s) => s.days !== null && s.days > cfg.agingDays).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  if (aged.length > 0) {
    const cost = aged.reduce((a, s) => a + s.costVnd, 0n);
    out.push({
      kind: "AGED_STOCK",
      level: aged.some((s) => (s.days ?? 0) > cfg.agingDays * 2) ? "warning" : "info",
      title: `${aged.length} máy tồn quá ${cfg.agingDays} ngày — ${shortVnd(cost)} vốn đứng`,
      detail: list(aged.map((s) => `${s.label} (${s.days} ngày)`)),
      href: aged.length === 1 ? `/kho/${aged[0].id}` : "/kho",
    });
  }

  for (const d of input.depositsReady)
    out.push({
      kind: "DEPOSIT_READY",
      level: "info",
      title: `Đơn cọc ${d.code}${d.customer ? ` (${d.customer})` : ""}: máy đã về SG — giao & hoàn tất`,
      href: `/ban-hang/${d.id}`,
    });

  const owing = input.receivables.filter((r) => r.balanceVnd > 0n && r.status === "COMPLETED");
  if (owing.length > 0) {
    const sum = owing.reduce((a, r) => a + r.balanceVnd, 0n);
    out.push({
      kind: "RECEIVABLE",
      level: "info",
      title: `${owing.length} đơn bán khách còn nợ ${shortVnd(sum)}`,
      detail: list(owing.map((r) => `${r.code}${r.customer ? ` · ${r.customer}` : ""} ${shortVnd(r.balanceVnd)}`)),
      href: owing.length === 1 ? `/ban-hang/${owing[0].id}` : "/ban-hang",
    });
  }

  const t = cfg.revenueThresholdVnd;
  if (t > 0n) {
    const bp = percentBp(input.yearRevenueVnd, t) ?? 0;
    if (bp >= Math.round(cfg.thresholdWarningRatio * 10000))
      out.push({
        kind: "TAX_THRESHOLD",
        level: bp >= 10000 ? "critical" : "warning",
        title: `Doanh thu năm ${input.year} đạt ${formatBp(bp).replace(",00 ", " ")} ngưỡng ${shortVnd(t)}`,
        detail: "Xem lại nghĩa vụ thuế hộ kinh doanh (tài liệu 06)",
        href: "/ban-hang",
      });
  }

  const rank: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2 };
  return out
    .map((a, k) => [a, k] as const)
    .sort((x, y) => rank[x[0].level] - rank[y[0].level] || x[1] - y[1])
    .map(([a]) => a);
}

// ---- Tồn kho -------------------------------------------------------------------------------------------

export const AGING_BUCKETS = ["0-15", "16-30", "31-60", ">60"] as const;
export const AGING_LABEL: Record<(typeof AGING_BUCKETS)[number], string> = {
  "0-15": "≤ 15 ngày",
  "16-30": "16–30 ngày",
  "31-60": "31–60 ngày",
  ">60": "> 60 ngày",
};

export function agingBucket(d: number): (typeof AGING_BUCKETS)[number] {
  return d <= 15 ? "0-15" : d <= 30 ? "16-30" : d <= 60 ? "31-60" : ">60";
}

/** Tóm tắt tồn kho: số máy, vốn, tuổi tồn trung bình (làm tròn), phân nhóm tuổi tồn. */
export function stockSummary(stock: readonly { days: number | null; costVnd: bigint }[]) {
  const known = stock.filter((s) => s.days !== null) as { days: number; costVnd: bigint }[];
  const avg = known.length ? Math.round(known.reduce((a, s) => a + s.days, 0) / known.length) : null;
  const buckets = AGING_BUCKETS.map((b) => {
    const mine = known.filter((s) => agingBucket(s.days) === b);
    return { bucket: b, label: AGING_LABEL[b], count: mine.length, costVnd: mine.reduce((a, s) => a + s.costVnd, 0n) };
  });
  return { count: stock.length, costVnd: stock.reduce((a, s) => a + s.costVnd, 0n), avgDays: avg, buckets };
}
