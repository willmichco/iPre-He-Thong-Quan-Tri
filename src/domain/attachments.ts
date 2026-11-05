/**
 * Chứng từ đính kèm — "hồ sơ nguồn gốc" của hàng hoá (tài liệu 06 mục 3.2).
 * Hàng nhập khẩu lưu thông phải có hoá đơn, chứng từ kèm theo; hệ thống lưu giữ và xuất trình nhanh theo từng máy.
 * Hàm thuần, không phụ thuộc CSDL.
 */

export const ENTITY_TYPES = ["BATCH", "PURCHASE_ORDER", "ITEM", "SHIPMENT", "COST", "SALE", "CASH_TRANSACTION"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const ENTITY_LABEL: Record<EntityType, string> = {
  BATCH: "Chuyến",
  PURCHASE_ORDER: "Đơn mua",
  ITEM: "Máy",
  SHIPMENT: "Kiện",
  COST: "Chi phí",
  SALE: "Đơn bán",
  CASH_TRANSACTION: "Bút toán",
};

export const DOC_KINDS = ["INVOICE", "RECEIPT", "AWB", "CUSTOMS", "PHOTO", "OTHER"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_KIND_LABEL: Record<DocKind, string> = {
  INVOICE: "Hoá đơn",
  RECEIPT: "Biên nhận / thanh toán",
  AWB: "Vận đơn / AWB",
  CUSTOMS: "Chứng từ thông quan / nhập khẩu",
  PHOTO: "Ảnh",
  OTHER: "Khác",
};

/** Loại chứng từ gợi ý theo đối tượng (đầu danh sách = mặc định). */
export const KIND_FOR: Record<EntityType, readonly DocKind[]> = {
  PURCHASE_ORDER: ["INVOICE", "RECEIPT", "PHOTO", "OTHER"],
  SHIPMENT: ["AWB", "CUSTOMS", "RECEIPT", "PHOTO", "OTHER"],
  BATCH: ["CUSTOMS", "AWB", "INVOICE", "OTHER"],
  ITEM: ["PHOTO", "INVOICE", "OTHER"],
  COST: ["INVOICE", "RECEIPT", "OTHER"],
  SALE: ["INVOICE", "RECEIPT", "OTHER"],
  CASH_TRANSACTION: ["RECEIPT", "INVOICE", "OTHER"],
};

export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;
/** tổng dung lượng một lần tải (khớp serverActions.bodySizeLimit trong next.config.ts, chừa phần đầu multipart) */
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

/** Định dạng nhận: ảnh chụp chứng từ và PDF. Đuôi tệp khi lưu lấy theo loại, không theo tên người dùng gửi. */
export const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/**
 * Nhận diện loại tệp theo "chữ ký" vài byte đầu (không tin phần mở rộng hay Content-Type trình duyệt gửi).
 * Trả null nếu không phải PDF / JPEG / PNG / WebP / HEIC.
 */
export function sniffMime(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  return null;
}

/** Tên tệp hiển thị an toàn: bỏ đường dẫn, ký tự điều khiển, ký tự cấm; tối đa 120 ký tự, giữ đuôi. */
export function safeFileName(raw: string, fallbackExt: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = base || `chung-tu.${fallbackExt}`;
  if (name.length <= 120) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  return name.slice(0, 120 - ext.length) + ext;
}

export type UploadCheck = { ok: true; mime: string; ext: string; name: string } | { ok: false; error: string };

/** Kiểm tra một tệp tải lên: có dữ liệu, không quá dung lượng, đúng định dạng thật. */
export function checkUpload(name: string, bytes: Uint8Array): UploadCheck {
  if (!bytes.length) return { ok: false, error: `${name || "Tệp"}: tệp rỗng` };
  if (bytes.length > MAX_BYTES) return { ok: false, error: `${name}: quá ${MAX_BYTES / 1024 / 1024} MB` };
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, error: `${name}: chỉ nhận ảnh (JPG, PNG, WebP, HEIC) hoặc PDF` };
  const ext = MIME_EXT[mime];
  return { ok: true, mime, ext, name: safeFileName(name, ext) };
}

/** Khoá lưu trữ theo nội dung: cùng tệp tải hai lần → một bản lưu. "2026/11/<sha256>.pdf" */
export function storageKey(sha256: string, ext: string, at: Date): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 không hợp lệ");
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${y}/${m}/${sha256}.${ext}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} MB`;
}

/**
 * Hồ sơ nguồn gốc của một máy đủ chưa: cần chứng từ mua (hoá đơn / biên nhận của đơn mua) và, khi máy đã đi
 * chặng Mỹ → VN, chứng từ vận chuyển quốc tế (vận đơn hoặc thông quan — gắn vào kiện hoặc chuyến).
 */
export function dossierGaps(d: { hasPurchaseDoc: boolean; crossedBorder: boolean; hasImportDoc: boolean }): ("PURCHASE" | "IMPORT")[] {
  const gaps: ("PURCHASE" | "IMPORT")[] = [];
  if (!d.hasPurchaseDoc) gaps.push("PURCHASE");
  if (d.crossedBorder && !d.hasImportDoc) gaps.push("IMPORT");
  return gaps;
}
export const GAP_LABEL = { PURCHASE: "thiếu hoá đơn mua", IMPORT: "thiếu vận đơn / chứng từ nhập khẩu" } as const;
