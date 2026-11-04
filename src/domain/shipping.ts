/**
 * Kiện & chặng vận chuyển — phần thuần (tài liệu 01 mục 4, tài liệu 04 mục 4).
 *
 * Nguyên tắc vàng: người dùng chỉ thao tác trên KIỆN ("Gửi đi" / "Đã nhận"); hệ thống sinh mốc (item_events)
 * và chuyển trạng thái cho MỌI máy trong kiện. Trạng thái chỉ đi tới, không lùi; máy khách đã cọc giữ nguyên
 * "Khách cọc"; máy đã bán / thất lạc / trả người bán… không bị đổi trạng thái.
 */
import { z } from "zod";
import { parseDecimalInput } from "./catalog";
import type { LegType } from "./catalog";

export type { LegType };

/** Ba chặng chính có mốc & trạng thái; các chặng khác (nội thành SG, khác) chỉ theo dõi kiện. */
export const MAIN_LEGS = ["US_DOMESTIC", "US_TO_VN", "HN_TO_SG"] as const;
export type MainLeg = (typeof MAIN_LEGS)[number];

export interface LegRule {
  /** mốc khi "Gửi đi" / "Đã nhận" */
  departEvent: string;
  arriveEvent: string;
  /** mã mốc trong tài liệu (M2…M7) */
  departMilestone: string;
  arriveMilestone: string;
  /** trạng thái máy sau khi gửi / nhận */
  inTransit: string;
  arrived: string;
  departLabel: string;
  arriveLabel: string;
}

export const LEG_RULES: Record<MainLeg, LegRule> = {
  US_DOMESTIC: {
    departEvent: "SELLER_SHIPPED",
    arriveEvent: "US_WAREHOUSE_RECEIVED",
    departMilestone: "M2",
    arriveMilestone: "M3",
    inTransit: "US_IN_TRANSIT",
    arrived: "AT_US_WAREHOUSE",
    departLabel: "Người bán gửi",
    arriveLabel: "Về kho Mỹ",
  },
  US_TO_VN: {
    departEvent: "INTL_DEPARTED",
    arriveEvent: "HN_ARRIVED",
    departMilestone: "M4",
    arriveMilestone: "M5",
    inTransit: "INTL_IN_TRANSIT",
    arrived: "AT_HN",
    departLabel: "Rời Mỹ",
    arriveLabel: "Về Hà Nội",
  },
  HN_TO_SG: {
    departEvent: "DOMESTIC_DEPARTED",
    arriveEvent: "SG_RECEIVED",
    departMilestone: "M6",
    arriveMilestone: "M7",
    inTransit: "DOMESTIC_IN_TRANSIT",
    arrived: "IN_STOCK",
    departLabel: "Rời Hà Nội",
    arriveLabel: "Nhận tại SG",
  },
};

export const isMainLeg = (l: string): l is MainLeg => (MAIN_LEGS as readonly string[]).includes(l);

/** Thứ tự trạng thái trên đường về (để chỉ cho đi tới, không lùi). */
export const PROGRESS = ["ORDERED", "US_IN_TRANSIT", "AT_US_WAREHOUSE", "INTL_IN_TRANSIT", "AT_HN", "DOMESTIC_IN_TRANSIT", "IN_STOCK"] as const;

/** Máy không còn đi tiếp được (không gán vào kiện mới). */
export const OUT_OF_FLOW = ["SOLD", "RETURNED_TO_SELLER", "LOST", "DAMAGED", "PERSONAL_USE", "WARRANTY"] as const;

/**
 * Trạng thái mới của máy khi kiện đổi trạng thái. Trả null = giữ nguyên.
 * - Đang trên đường: chỉ đi tới (máy đã xa hơn — vd nhập bù kiện cũ — thì giữ).
 * - Khách cọc (RESERVED): giữ nguyên, kể cả khi về SG.
 * - Đã bán, thất lạc, trả người bán…: giữ nguyên.
 */
export function nextItemStatus(current: string, target: string): string | null {
  const from = PROGRESS.indexOf(current as (typeof PROGRESS)[number]);
  const to = PROGRESS.indexOf(target as (typeof PROGRESS)[number]);
  if (from < 0 || to < 0) return null;
  return to > from ? target : null;
}

export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  PLANNED: "Chờ gửi",
  IN_TRANSIT: "Đang đi",
  ARRIVED: "Đã nhận",
  HOLD: "Giữ hải quan",
  LOST: "Thất lạc",
  CANCELLED: "Đã huỷ",
};

/** Cột của bảng tiến độ (Kanban). */
export type BoardColumn = "PLANNED" | "US_DOMESTIC" | "US_TO_VN" | "HN_TO_SG" | "OTHER" | "ARRIVED";
export const BOARD_COLUMNS: { key: BoardColumn; label: string }[] = [
  { key: "PLANNED", label: "Chờ gửi" },
  { key: "US_DOMESTIC", label: "① Nội địa Mỹ" },
  { key: "US_TO_VN", label: "② Mỹ → VN" },
  { key: "HN_TO_SG", label: "③ HN → SG" },
  { key: "OTHER", label: "Chặng khác" },
  { key: "ARRIVED", label: "Đã nhận" },
];
export function boardColumn(s: { status: string; legType: string }): BoardColumn | null {
  if (s.status === "PLANNED") return "PLANNED";
  if (s.status === "ARRIVED") return "ARRIVED";
  if (s.status === "IN_TRANSIT" || s.status === "HOLD") return isMainLeg(s.legType) ? s.legType : "OTHER";
  return null; // thất lạc / huỷ: không hiện trên bảng
}

// ---- Ngày giờ (giờ Việt Nam) ----------------------------------------------------------------------------

/** "2026-11-04T09:30" (ô datetime-local, giờ VN) → ISO có múi giờ +07:00. */
export function vnLocalToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(local.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00+07:00`);
  return Number.isNaN(d.getTime()) ? null : `${m[1]}T${m[2]}:00+07:00`;
}

/** Thời điểm → "YYYY-MM-DDTHH:mm" giờ VN (giá trị mặc định cho ô datetime-local). */
export function isoToVnLocal(d: Date): string {
  const vn = new Date(d.getTime() + 7 * 3600_000);
  return vn.toISOString().slice(0, 16);
}

/** ETA = ngày gửi (giờ VN) + số ngày giao mặc định của đơn vị vận chuyển. */
export function etaFrom(shippedAtIso: string, leadDays: number | null): string | null {
  if (leadDays === null) return null;
  const vnDate = isoToVnLocal(new Date(shippedAtIso)).slice(0, 10);
  const d = new Date(`${vnDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + leadDays);
  return d.toISOString().slice(0, 10);
}

/** Số ngày trễ so với ETA (kiện chưa nhận); 0 = chưa trễ / chưa có ETA. `today` = YYYY-MM-DD giờ VN. */
export function daysLate(eta: string | null, today: string, status: string): number {
  if (!eta || (status !== "IN_TRANSIT" && status !== "HOLD")) return 0;
  const diff = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${eta}T00:00:00Z`)) / 86_400_000;
  return diff > 0 ? Math.round(diff) : 0;
}

/** Link tra cứu vận đơn từ mẫu của đơn vị vận chuyển. */
export function trackingUrl(template: string | null, tracking: string | null): string | null {
  if (!template || !tracking) return null;
  return template.replace("{tracking}", encodeURIComponent(tracking));
}

// ---- Form kiện ------------------------------------------------------------------------------------------

const optText = (max: number) =>
  z
    .string()
    .default("")
    .transform((s: string) => s.trim())
    .pipe(z.string().max(max, `Tối đa ${max} ký tự`))
    .transform((s) => (s === "" ? null : s));
const optId = z
  .string()
  .default("")
  .transform((s: string) => s.trim())
  .transform((s) => (s === "" ? null : s))
  .refine((s) => s === null || z.guid().safeParse(s).success, "Lựa chọn không hợp lệ");

export const shipmentSchema = z.object({
  legType: z.enum(["US_DOMESTIC", "US_TO_VN", "HN_TO_SG", "SG_LOCAL", "OTHER"], { error: "Chọn chặng" }),
  carrierId: optId,
  batchId: optId,
  trackingNumber: optText(80).transform((s) => s?.replace(/\s+/g, "").toUpperCase() ?? null),
  referenceCode: optText(80),
  eta: z
    .string()
    .default("")
    .transform((s: string) => s.trim())
    .refine((s) => s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s), "Ngày dự kiến không hợp lệ")
    .transform((s) => (s === "" ? null : s)),
  chargeableWeightKg: z
    .string()
    .default("")
    .transform((s, ctx) => {
      if (!s.trim()) return null;
      const v = parseDecimalInput(s, 3);
      if (v === null || !(Number(v) > 0)) {
        ctx.addIssue({ code: "custom", message: "Cân nặng tính cước không hợp lệ" });
        return z.NEVER;
      }
      return v;
    }),
  note: optText(1000),
});
export type ShipmentInput = z.output<typeof shipmentSchema>;

/** Danh sách mã quét / dán (Serial, IMEI) → các mã riêng, đã chuẩn hoá, bỏ trùng. */
export function parseScanList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;|]+/)) {
    let c = raw.trim().toUpperCase();
    if (!c) continue;
    // mã vạch Serial trên hộp có tiền tố "S" (Code128 "(S) Serial No.")
    if (/^S[A-Z0-9]{10}$|^S[A-Z0-9]{12}$/.test(c) && !/^\d+$/.test(c.slice(1))) c = c.slice(1);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}
