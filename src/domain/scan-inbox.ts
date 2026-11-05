/**
 * Hộp chờ duyệt (tài liệu 07 mục 5.2): kết quả quét / chụp loạt trên điện thoại gửi về máy chủ, duyệt trên máy tính rồi
 * xác nhận vào đơn mua (tạo máy) hoặc vào kiện (nhận hàng). Hàm thuần: chuẩn hoá bản ghi gửi lên, soát từng dòng.
 */
import { isValidImei, normalizeCode, partNumberRegion } from "./identifiers";

export const INBOX_FIELDS = ["serial", "imei1", "imei2", "partNumber", "upc"] as const;
export type InboxField = (typeof INBOX_FIELDS)[number];
export type InboxSource = "BARCODE" | "HW_SCANNER" | "PASTE" | "OCR" | "MANUAL";
const SOURCES: readonly InboxSource[] = ["BARCODE", "HW_SCANNER", "PASTE", "OCR", "MANUAL"];
const ORIGIN_TO_SOURCE = { CAMERA: "CAMERA_LIVE", PHOTO: "PHOTO", HW_SCANNER: "HW_SCANNER", PASTE: "PASTE", MANUAL: "PASTE" } as const;
export type Origin = keyof typeof ORIGIN_TO_SOURCE;

export interface InboxRecord {
  clientId: string;
  origin: Origin;
  fields: Partial<Record<InboxField, { value: string; source: InboxSource }>>;
  extras: string[];
  note: string | null;
}

export const MAX_SUBMIT = 300;

/**
 * Bản ghi gửi từ trình duyệt (không tin được) → bản ghi sạch. Bỏ dòng rỗng; mã chuẩn hoá chữ hoa, bỏ khoảng trắng,
 * tối đa 40 ký tự. Lỗi cấu trúc → ném lỗi (không lưu gì).
 */
export function sanitizeRecords(input: unknown): InboxRecord[] {
  if (!Array.isArray(input)) throw new Error("Dữ liệu gửi lên không hợp lệ");
  if (input.length > MAX_SUBMIT) throw new Error(`Tối đa ${MAX_SUBMIT} máy mỗi lần gửi`);
  const out: InboxRecord[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("Dữ liệu gửi lên không hợp lệ");
    const r = raw as Record<string, unknown>;
    const clientId = typeof r.id === "string" ? r.id.slice(0, 64) : "";
    const origin = (typeof r.origin === "string" && r.origin in ORIGIN_TO_SOURCE ? r.origin : "MANUAL") as Origin;
    const fields: InboxRecord["fields"] = {};
    const src = (r.fields ?? {}) as Record<string, unknown>;
    for (const k of INBOX_FIELDS) {
      const f = src[k] as { value?: unknown; source?: unknown } | undefined;
      const value = typeof f?.value === "string" ? normalizeCode(f.value).slice(0, 40) : "";
      if (!value) continue;
      const source = (SOURCES as readonly string[]).includes(String(f?.source)) ? (f!.source as InboxSource) : "MANUAL";
      fields[k] = { value, source };
    }
    const extras = Array.isArray(r.extras)
      ? r.extras
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.slice(0, 40))
          .slice(0, 10)
      : [];
    const note = typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 300) : null;
    if (!Object.keys(fields).length && !extras.length) continue;
    out.push({ clientId, origin, fields, extras, note });
  }
  return out;
}

export const scanSourceOf = (o: Origin) => ORIGIN_TO_SOURCE[o];

export type Level = "OK" | "WARN" | "ERROR";
export interface ReviewIssue {
  level: Level | "INFO";
  message: string;
}

/**
 * Soát một dòng. Không phụ thuộc đích xác nhận: "đã có trong hệ thống" chỉ là thông tin
 * (nhận kiện thì cần máy đã có; thêm vào đơn mua thì bị chặn lúc xác nhận).
 */
export function reviewCapture(
  f: InboxRecord["fields"],
  ctx: { variantLabel: string | null | undefined; existing: { code: string; label: string }[]; duplicateInInbox: boolean; expectedRegion?: string },
): { level: Level; issues: ReviewIssue[] } {
  const issues: ReviewIssue[] = [];
  const v = (k: InboxField) => f[k]?.value ?? "";
  if (!v("serial") && !v("imei1") && !v("imei2")) issues.push({ level: "ERROR", message: "Chưa có Serial / IMEI — chụp lại hoặc nhập tay" });
  for (const k of ["imei1", "imei2"] as const)
    if (v(k) && !isValidImei(v(k))) issues.push({ level: "ERROR", message: `${k === "imei1" ? "IMEI 1" : "IMEI 2"} sai số kiểm tra (Luhn) — đọc nhầm?` });
  for (const k of INBOX_FIELDS)
    if (f[k]?.source === "OCR")
      issues.push({ level: "WARN", message: `Soát ${k === "partNumber" ? "Part No." : k === "serial" ? "Serial" : k} (đọc chữ, không phải mã vạch)` });
  if (!v("partNumber")) issues.push({ level: "WARN", message: "Chưa có Part No. — chọn cấu hình khi thêm vào đơn mua" });
  else if (ctx.variantLabel === null) issues.push({ level: "WARN", message: `Mã ${v("partNumber")} chưa gán cấu hình — gán ở Danh mục › Mã Part No.` });
  const region = v("partNumber") ? partNumberRegion(v("partNumber")) : null;
  const expected = ctx.expectedRegion ?? "LL/A";
  if (region && region !== expected) issues.push({ level: "WARN", message: `Không phải hàng thị trường ${expected} (${region})` });
  if (ctx.duplicateInInbox) issues.push({ level: "WARN", message: "Trùng với dòng khác trong hộp chờ" });
  for (const e of ctx.existing) issues.push({ level: "INFO", message: `${e.code} đã có trong hệ thống: ${e.label}` });
  const level: Level = issues.some((i) => i.level === "ERROR") ? "ERROR" : issues.some((i) => i.level === "WARN") ? "WARN" : "OK";
  return { level, issues };
}

/** Các mã định danh của một dòng (để tra trùng). */
export const codesOf = (f: InboxRecord["fields"]) => (["serial", "imei1", "imei2"] as const).flatMap((k) => (f[k]?.value ? [f[k]!.value] : []));
