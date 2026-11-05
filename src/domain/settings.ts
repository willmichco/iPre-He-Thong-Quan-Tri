/**
 * Cài đặt (bảng app_settings, giá trị jsonb). Chỉ liệt kê những cài đặt ĐANG được hệ thống đọc — không để núm vặn "chết".
 * Pháp luật thuế thay đổi thường xuyên (ngưỡng 500 tr → 1 tỷ ngay trong năm 2026) nên ngưỡng / tỷ lệ là tham số, không viết cứng.
 */
import { parseVndInput } from "./sales-core";

type Base = { key: string; group: "alert" | "tax" | "costing"; label: string; hint?: string };
export type SettingDef =
  | (Base & { type: "int"; min: number; max: number; def: number; unit: string })
  | (Base & { type: "vnd"; def: bigint })
  | (Base & { type: "percent"; min: number; max: number; def: number })
  | (Base & { type: "enum"; options: readonly (readonly [string, string])[]; def: string });

export const SETTING_GROUPS = [
  { key: "alert", label: "Cảnh báo ở Tổng quan" },
  { key: "tax", label: "Thuế hộ kinh doanh" },
  { key: "costing", label: "Tính giá vốn" },
] as const;

export const SETTINGS: readonly SettingDef[] = [
  { key: "alert.aging_days", group: "alert", type: "int", label: "Báo máy tồn lâu sau", unit: "ngày", min: 1, max: 365, def: 30 },
  { key: "alert.eta_grace_days", group: "alert", type: "int", label: "Báo kiện trễ khi quá ETA", unit: "ngày", min: 0, max: 30, def: 2 },
  {
    key: "alert.return_deadline_days",
    group: "alert",
    type: "int",
    label: "Nhắc hạn đổi trả người bán trước",
    unit: "ngày",
    min: 0,
    max: 30,
    def: 3,
  },
  {
    key: "tax.revenue_threshold_vnd",
    group: "tax",
    type: "vnd",
    label: "Ngưỡng doanh thu năm không phải nộp thuế GTGT, TNCN",
    hint: "Nghị định 68/2026/NĐ-CP (sửa đổi bởi Nghị định 141/2026/NĐ-CP): 1 tỷ đồng. Đối chiếu quy định hiện hành khi có thay đổi.",
    def: 1_000_000_000n,
  },
  { key: "tax.threshold_warning_ratio", group: "tax", type: "percent", label: "Cảnh báo khi doanh thu năm đạt", min: 1, max: 100, def: 80 },
  {
    key: "costing.returned_item_policy",
    group: "costing",
    type: "enum",
    label: "Máy trả lại người bán Mỹ",
    hint: "Áp dụng từ lần tính lại giá vốn tiếp theo của chuyến (chuyến đã chốt không đổi).",
    options: [
      ["REALLOCATE", "Chia lại chi phí chung cho máy còn lại"],
      ["WRITE_OFF", "Máy trả vẫn gánh phần chi phí, ghi lỗ"],
    ],
    def: "REALLOCATE",
  },
];

/** Giá trị đang lưu (jsonb đã đọc thành JS) → chuỗi hiển thị trong ô nhập. Hỏng / thiếu → mặc định. */
export function displayValue(d: SettingDef, stored: unknown): string {
  const raw = typeof stored === "string" || typeof stored === "number" ? String(stored) : undefined;
  switch (d.type) {
    case "int":
      return raw !== undefined && /^\d+$/.test(raw) ? raw : String(d.def);
    case "vnd":
      return (raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : d.def).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    case "percent": {
      const n = Number(raw);
      return String(raw !== undefined && n > 0 && n <= 1 ? Math.round(n * 1000) / 10 : d.def).replace(".", ",");
    }
    case "enum":
      return raw !== undefined && d.options.some(([v]) => v === raw) ? raw : d.def;
  }
}

/** Ô nhập → giá trị lưu vào jsonb (số → number, chuỗi → string), hoặc lỗi tiếng Việt. */
export function parseSetting(d: SettingDef, input: string): { ok: true; value: number | string } | { ok: false; error: string } {
  const s = input.trim();
  switch (d.type) {
    case "int": {
      if (!/^\d+$/.test(s)) return { ok: false, error: `${d.label}: nhập số nguyên` };
      const n = Number(s);
      return n < d.min || n > d.max ? { ok: false, error: `${d.label}: từ ${d.min} đến ${d.max} ${d.unit}` } : { ok: true, value: n };
    }
    case "vnd": {
      const v = parseVndInput(s);
      if (v === null || v <= 0n) return { ok: false, error: `${d.label}: số tiền không hợp lệ (vd 1 tỷ · 1.000.000.000)` };
      // ≤ 2^53: lưu dạng số trong jsonb mà không mất chính xác
      return v > 9_007_199_254_740_991n ? { ok: false, error: `${d.label}: quá lớn` } : { ok: true, value: Number(v) };
    }
    case "percent": {
      const n = Number(s.replace(",", ".").replace("%", ""));
      if (!Number.isFinite(n) || n < d.min || n > d.max) return { ok: false, error: `${d.label}: từ ${d.min} đến ${d.max} %` };
      return { ok: true, value: Math.round(n * 10) / 1000 };
    }
    case "enum":
      return d.options.some(([v]) => v === s) ? { ok: true, value: s } : { ok: false, error: `${d.label}: lựa chọn không hợp lệ` };
  }
}

/** Giá trị mặc định ở dạng lưu jsonb (để so sánh: chưa lưu = đang dùng mặc định). */
export function defaultStored(d: SettingDef): number | string {
  switch (d.type) {
    case "int":
      return d.def;
    case "vnd":
      return Number(d.def);
    case "percent":
      return Math.round(d.def * 10) / 1000;
    case "enum":
      return d.def;
  }
}
