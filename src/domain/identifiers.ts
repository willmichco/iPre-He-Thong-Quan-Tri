/**
 * Nhận dạng & kiểm tra mã định danh thiết bị Apple.
 * Hàm thuần — dùng chung cho trình duyệt (quét mã) và máy chủ (kiểm tra lại).
 * Thiết kế: docs/07-quet-ma-va-nhap-lieu.md, mục 4.3.
 */

export type CodeKind = "IMEI" | "SERIAL" | "PART_NUMBER" | "UPC" | "EAN" | "EID" | "UNKNOWN";

export interface ClassifiedCode {
  kind: CodeKind;
  /** Giá trị đã chuẩn hoá (in hoa, bỏ khoảng trắng, bỏ tiền tố định danh dữ liệu). */
  value: string;
  /** Chuỗi gốc đọc được. */
  raw: string;
}

const PART_NUMBER = /^[A-Z0-9]{5}[A-Z]{1,2}\/A$/;
const SERIAL = /^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/;

/** Chuẩn hoá: bỏ khoảng trắng/ký tự điều khiển, in hoa. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s\u0000-\u001f\u007f]+/g, "").toUpperCase();
}

/** IMEI hợp lệ: đúng 15 chữ số và chữ số cuối khớp thuật toán Luhn. */
export function isValidImei(s: string): boolean {
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = s.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Số kiểm tra GS1 (UPC-A, EAN-13): trọng số 3/1 tính từ phải sang. */
function gs1CheckOk(s: string): boolean {
  const digits = s.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

export function isValidUpcA(s: string): boolean {
  return /^\d{12}$/.test(s) && gs1CheckOk(s);
}

export function isValidEan13(s: string): boolean {
  return /^\d{13}$/.test(s) && gs1CheckOk(s);
}

export function isPartNumber(s: string): boolean {
  return PART_NUMBER.test(s);
}

export function isSerialFormat(s: string): boolean {
  return SERIAL.test(s);
}

/** Hậu tố thị trường của Part No.: "MDEM1LL/A" → "LL/A". */
export function partNumberRegion(partNumber: string): string | null {
  const m = /([A-Z]{1,2}\/A)$/.exec(partNumber);
  return m && isPartNumber(partNumber) ? m[1] : null;
}

/**
 * Phân loại một chuỗi đọc được từ mã vạch / máy quét / dán.
 * Thứ tự quan trọng: mã có số kiểm tra được thử trước.
 */
export function classifyCode(raw: string): ClassifiedCode {
  const t = normalizeCode(raw);
  const out = (kind: CodeKind, value: string): ClassifiedCode => ({ kind, value, raw });

  if (isValidImei(t)) return out("IMEI", t);
  if (/^\d{32}$/.test(t)) return out("EID", t);
  if (isValidUpcA(t)) return out("UPC", t);
  // Bộ giải mã trả UPC-A dưới dạng EAN-13 có số 0 đứng đầu → chuẩn hoá về UPC 12 số
  if (isValidEan13(t)) return t.startsWith("0") ? out("UPC", t.slice(1)) : out("EAN", t);
  // "(1P) Part No." — tiền tố định danh dữ liệu ANSI MH10.8.2
  if (t.startsWith("1P") && isPartNumber(t.slice(2))) return out("PART_NUMBER", t.slice(2));
  if (isPartNumber(t)) return out("PART_NUMBER", t);
  // "(S) Serial No."
  if (t.startsWith("S") && isSerialFormat(t.slice(1))) return out("SERIAL", t.slice(1));
  if (isSerialFormat(t)) return out("SERIAL", t);
  return out("UNKNOWN", t);
}

/**
 * Sửa ký tự OCR dễ nhầm trong IMEI (O/D→0, I/L→1, S→5, B→8, Z→2).
 * Chỉ trả về kết quả khi sau khi sửa IMEI qua được kiểm tra Luhn.
 */
export function fixOcrImei(text: string): string | null {
  const map: Record<string, string> = { O: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" };
  const fixed = normalizeCode(text)
    .split("")
    .map((c) => map[c] ?? c)
    .join("");
  return isValidImei(fixed) ? fixed : null;
}

/** Tách văn bản dán (email, Excel, tin nhắn) thành các dòng, mỗi dòng nhiều mã. */
export function splitPastedText(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(/[\s,;|]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .filter((tokens) => tokens.length > 0);
}
