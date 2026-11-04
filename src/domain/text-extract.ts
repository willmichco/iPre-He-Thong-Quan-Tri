/**
 * Trích xuất IMEI, Serial, Part No. từ văn bản — kết quả OCR của ảnh chụp màn hình
 * (Cài đặt › Cài đặt chung › Giới thiệu, *#06#), nhãn hộp, hoặc văn bản dán vào.
 * Hàm thuần, kiểm thử trong tests/unit/text-extract.test.ts.
 */
import { fixOcrImei, isPartNumber, isValidEan13, isValidImei, isValidUpcA } from "./identifiers";

export interface TextExtraction {
  serial?: string;
  /** true khi serial nằm cạnh nhãn "Serial"/"Số sê-ri"/"(S)" — đáng tin hơn. */
  serialAnchored: boolean;
  imeis: string[];
  partNumber?: string;
  eid?: string;
  upc?: string;
}

// Nhãn neo của serial (Anh/Việt, kể cả khi OCR làm mất dấu tiếng Việt)
const SERIAL_ANCHOR = /(SERIAL(\s*(NO\.?|NUMBER|#))?|S[ỐÔO6]\s*S[ÊEÉ][\s-]*R[IÍ]|\(S\))/i;
// Chuỗi đứng riêng (không dính vào chữ phía trước như "IMEI2"), cho phép ký tự OCR hay nhầm với chữ số
const IMEI_LIKE = /(?<![A-Z0-9])[0-9OISBDZ](?:[0-9OISBDZ ]{10,40})[0-9OISBDZ](?![A-Z0-9])/g;
const PART_IN_TEXT = /\b([A-Z0-9]{5}[A-Z]{1,2})\s?[/|]\s?A\b/g;
const SERIAL_TOKEN = /^(?:[A-Z0-9]{10}|[A-Z0-9]{12})$/;

function serialCandidate(token: string): string | null {
  const t = token.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!SERIAL_TOKEN.test(t)) return null;
  if (!/[A-Z]/.test(t) || !/\d/.test(t)) return null; // serial Apple luôn có cả chữ và số
  return t;
}

function tokens(line: string): string[] {
  return line.split(/[\s:,;]+/).filter(Boolean);
}

export interface ExtractOptions {
  /**
   * Văn bản đến từ OCR: phần gốc 5 ký tự của Part No. hay bị đọc nhầm số 1→I, 0→O
   * (vd "MDEM1LL/A" thành "MDEMILL/A") — sửa lại. Giá trị vẫn được gắn nhãn "Đọc chữ" để soát.
   */
  ocr?: boolean;
}

export function extractFromText(text: string, opts: ExtractOptions = {}): TextExtraction {
  const result: TextExtraction = { serialAnchored: false, imeis: [] };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const upper = lines.map((l) => l.toUpperCase());

  // 1) Part No. (vd: MYWX3VN/A) — có thể đứng giữa dòng mô tả trên nhãn hộp
  for (const line of upper) {
    for (const m of line.matchAll(PART_IN_TEXT)) {
      let stem = m[1];
      if (opts.ocr) {
        const region = stem.slice(5);
        stem = stem.slice(0, 5).replace(/I/g, "1").replace(/O/g, "0") + region;
      }
      const pn = `${stem}/A`;
      if (isPartNumber(pn)) {
        result.partNumber ??= pn;
      }
    }
  }

  // 2) Chuỗi số dài: IMEI (15 số, Luhn), EID (32 số), UPC/EAN — cho phép khoảng trắng như "35 142108 183630 9"
  for (const line of upper) {
    for (const m of line.matchAll(IMEI_LIKE)) {
      const chunk = m[0];
      if ((chunk.match(/\d/g) ?? []).length < 10) continue;
      // tách theo khoảng trắng lớn để không dính hai số liền kề
      for (const part of chunk.split(/\s{2,}/)) {
        const compact = part.replace(/\s+/g, "");
        if (compact.length === 15) {
          const imei = isValidImei(compact) ? compact : fixOcrImei(compact);
          if (imei && !result.imeis.includes(imei)) result.imeis.push(imei);
        } else if (/^\d{32}$/.test(compact)) {
          result.eid ??= compact;
        } else if (/^\d{12}$/.test(compact) && isValidUpcA(compact)) {
          result.upc ??= compact;
        } else if (/^\d{13}$/.test(compact) && isValidEan13(compact)) {
          result.upc ??= compact.startsWith("0") ? compact.slice(1) : compact;
        }
      }
    }
  }

  // 3) Serial: ưu tiên giá trị ngay sau nhãn neo (cùng dòng, hoặc dòng kế tiếp)
  const partBase = result.partNumber?.replace(/[A-Z]{1,2}\/A$/, "");
  const isOther = (s: string) => result.imeis.includes(s) || (partBase !== undefined && s.startsWith(partBase));
  for (let i = 0; i < upper.length && !result.serial; i++) {
    const m = SERIAL_ANCHOR.exec(upper[i]);
    if (!m) continue;
    const after = upper[i].slice(m.index + m[0].length);
    const pool = [...tokens(after), ...(i + 1 < upper.length ? tokens(upper[i + 1]) : [])];
    for (const tk of pool) {
      const s = serialCandidate(tk);
      if (s && !isOther(s)) {
        result.serial = s;
        result.serialAnchored = true;
        break;
      }
    }
  }
  // Không có nhãn neo: chỉ nhận khi có đúng MỘT ứng viên (tránh nhận nhầm chữ khác)
  if (!result.serial) {
    const candidates = new Set<string>();
    for (const line of upper) for (const tk of tokens(line)) {
      const s = serialCandidate(tk);
      if (s && !isOther(s)) candidates.add(s);
    }
    if (candidates.size === 1) result.serial = [...candidates][0];
  }
  return result;
}

/**
 * Định danh đủ tin cậy để TỰ ĐỘNG tạo máy khi đọc chữ liên tục từ camera:
 * có IMEI qua kiểm tra Luhn, hoặc serial nằm cạnh nhãn "Serial/Số sê-ri".
 */
export function hasStrongIdentity(x: TextExtraction): boolean {
  return x.imeis.length > 0 || Boolean(x.serial && x.serialAnchored);
}

/** Có thông tin định danh máy hay không (dùng để quyết định có tạo bản ghi máy). */
export function hasIdentity(x: TextExtraction): boolean {
  return Boolean(x.serial || x.imeis.length > 0);
}
