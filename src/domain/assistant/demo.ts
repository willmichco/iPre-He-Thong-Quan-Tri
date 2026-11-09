/**
 * Trợ lý — BẢN XEM THỬ TĨNH (GitHub Pages, không có máy chủ): gói dữ liệu nhúng vào trang và khoá tra câu trả lời dựng sẵn.
 * Câu trả lời câu hỏi được dựng LÚC CHỤP bằng chính `answerQuery` của máy chủ → số liệu khớp các trang đã chụp.
 * Phiếu ghi được dựng trong trình duyệt từ danh sách máy / khách / tài khoản của gói (không lưu gì).
 */
import { parseRange, PRESETS, type PresetKey } from "../reports";
import type { VariantRef } from "../purchasing-core";
import type { Slots } from "./extract";
import type { Intent } from "./intents";
import { fold } from "./normalize";
import type { Reply } from "./reply";

export const DEMO_PERIODS = ["", ...PRESETS.map((p) => p.key)] as const;
export type DemoPeriod = "" | PresetKey;

/** Kỳ trong câu → preset gần nhất có câu trả lời dựng sẵn; `exact` = trùng khớp. */
export function demoPeriodOf(s: Slots, today: string): { period: DemoPeriod; exact: boolean } {
  const p = s.period;
  if (!p) return { period: "", exact: true };
  if (p.ky && (PRESETS as readonly { key: string }[]).some((x) => x.key === p.ky)) return { period: p.ky as PresetKey, exact: true };
  if (p.tu && p.den) {
    const want = parseRange({ tu: p.tu, den: p.den }, today);
    for (const x of PRESETS) {
      const r = parseRange({ ky: x.key }, today);
      if (r.from === want.from && r.toExcl === want.toExcl) return { period: x.key, exact: true };
    }
    // khoảng tuỳ chọn: lấy tháng / quý / năm chứa ngày bắt đầu
    for (const x of ["thang", "thang-truoc", "quy", "quy-truoc", "nam", "nam-truoc"] as const) {
      const r = parseRange({ ky: x }, today);
      if (want.from >= r.from && want.from < r.toExcl) return { period: x, exact: false };
    }
  }
  return { period: "", exact: false };
}

/** Khoá câu trả lời dựng sẵn: intent · đối tượng (mã máy, mã đơn, khách…) · kỳ. */
export const demoKey = (intent: Intent, subject = "", period: DemoPeriod = "") => `${intent}|${subject}|${period}`;

/** Đối tượng phụ của vài câu hỏi đọc từ chữ còn lại trong câu (giống nhánh trong answerQuery). */
export function demoSubject(intent: Intent, s: Slots): string {
  const f = fold(s.rest);
  switch (intent) {
    case "OPEX":
      return /quang cao|ads/.test(f) ? "ads" : /mat bang|nha|kho/.test(f) ? "rent" : /internet|dien thoai|phan mem/.test(f) ? "telecom" : "";
    case "TOP_MODELS":
      return /ban chay|nhieu nhat/.test(f) ? "units" : "";
    case "STAGE":
      return /\b(hn|ha noi)\b/.test(f) && !/sg|sai gon/.test(f) ? "hn" : /\bkho my\b/.test(f) ? "uswh" : "";
    case "SHIPMENTS":
      return s.tracking ? `track:${s.tracking}` : /\btre\b|qua han/.test(f) ? "late" : "";
    case "DOCS":
      return /hop cho|cho duyet/.test(f) ? "hopcho" : "";
    case "AGED_STOCK":
      return s.days ? String(s.days) : "";
    case "BATCH":
      return s.batchCode ?? "";
    case "SALE_LOOKUP":
      return s.saleCode ?? "";
    default:
      return "";
  }
}

/** Câu hỏi có câu trả lời phụ thuộc kỳ. */
export const PERIOD_INTENTS = new Set<Intent>(["REVENUE", "MONTHLY", "OPEX", "TOP_MODELS", "BY_CHANNEL", "RECENT_SALES", "CASHFLOW", "TAX", "UNINVOICED"]);

export interface DemoItem {
  id: string;
  serial: string | null;
  imei: string | null;
  label: string;
  variantId: string;
  status: string;
  costVnd: string;
  hasEstimate: boolean;
  targetVnd: string | null;
  /** ngày về SG (YYYY-MM-DD) */
  sg: string | null;
  ordered: string | null;
  sellable: "NOW" | "DEPOSIT_ONLY" | "NO";
  reason: string | null;
  batchCode: string;
}
export interface DemoStock {
  variantId: string;
  label: string;
  inStock: number;
  reserved: number;
  incoming: number;
  costVnd: string;
  oldestDays: number | null;
}

export interface DemoPack {
  today: string;
  variants: VariantRef[];
  accountNames: string[];
  items: DemoItem[];
  stock: DemoStock[];
  customers: { id: string; name: string; phone: string | null }[];
  accounts: { id: string; name: string; kind: string; currency: string }[];
  categories: { code: string; name: string; direction: "IN" | "OUT" }[];
  sales: { id: string; code: string; status: string; customerId: string | null; customer: string | null; items: string; revenueVnd: string; balanceVnd: string }[];
  batches: { code: string; href: string }[];
  purchaseOrders: { id: string; batchCode: string; label: string; currency: string }[];
  shipments: { tracking: string; legType: string; itemCount: number; href: string }[];
  /** câu trả lời dựng sẵn theo demoKey */
  answers: Record<string, Reply>;
}
