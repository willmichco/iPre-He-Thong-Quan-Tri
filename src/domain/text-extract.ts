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
// OCR tiếng Anh đọc "Số sê-ri" thành "S6 sé-ri", "$6 sé-ri", "SB sé", "SO se ri", "S8seri"…
const SERIAL_ANCHOR = /(SERIAL(\s*(NO\.?|NUMBER|#))?|(?<![A-Z0-9])[S$5][ỐÔỔO06B8]\s*[S$5][ÊEÉÈ8](?:[\s-]*R[IÍ1l])?(?=[\s:]|$)|\(S\))/i;
// Chuỗi đứng riêng (không dính vào chữ phía trước như "IMEI2"), cho phép ký tự OCR hay nhầm với chữ số
const IMEI_LIKE = /(?<![A-Z0-9])[0-9OISBDZ](?:[0-9OISBDZ ]{10,40})[0-9OISBDZ](?![A-Z0-9])/g;
const PART_IN_TEXT = /\b([A-Z0-9]{5}[A-Z]{1,2})\s?[/|]\s?A\b/g;
// OCR hay đọc dấu "/" thành J, I, l, 1 (vd "MXVX3ZP/A" → "MXVX3ZPJA") — chỉ dùng cho văn bản từ OCR
const PART_IN_OCR = /\b([A-Z0-9]{5,6}[A-Z]{1,2})\s?[/|JIL1]\s?A\b/g;
// OCR hay đọc một ký tự thành hai ("1" → "I1", "0" → "O0"): gộp lại khi phần gốc dư đúng 1 ký tự
const OCR_DOUBLES = /I1|1I|O0|0O|L1|1L/;
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
    for (const m of line.matchAll(opts.ocr ? PART_IN_OCR : PART_IN_TEXT)) {
      let stem = m[1];
      if (opts.ocr) {
        // tách mã thị trường (1–2 chữ cuối) khỏi phần gốc; phần gốc phải còn đúng 5 ký tự
        const region = /[A-Z]{1,2}$/.exec(stem.slice(5))?.[0] ?? "";
        let base = stem.slice(0, stem.length - region.length);
        if (base.length === 6) {
          const d = OCR_DOUBLES.exec(base);
          if (!d) continue;
          base = base.slice(0, d.index) + (/\d/.test(d[0][0]) ? d[0][0] : d[0][1]) + base.slice(d.index + 2);
        }
        if (base.length !== 5) continue;
        stem = base.replace(/I/g, "1").replace(/O/g, "0") + region;
      } else if (stem.length !== 6 && stem.length !== 7) {
        continue;
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

/**
 * Gộp hai lần đọc chữ độc lập (vd: vùng chữ đã cắt + cả ảnh): lần đầu được ưu tiên,
 * lần sau chỉ bổ sung trường còn thiếu; IMEI lấy hợp (đều đã qua Luhn).
 */
export function mergeExtractions(a: TextExtraction, b: TextExtraction): TextExtraction {
  const serialFromA = a.serial && (a.serialAnchored || !b.serialAnchored || !b.serial);
  return {
    serial: serialFromA ? a.serial : (b.serial ?? a.serial),
    serialAnchored: serialFromA ? a.serialAnchored : b.serial ? b.serialAnchored : a.serialAnchored,
    imeis: [...a.imeis, ...b.imeis.filter((i) => !a.imeis.includes(i))].slice(0, 2),
    partNumber: a.partNumber ?? b.partNumber,
    eid: a.eid ?? b.eid,
    upc: a.upc ?? b.upc,
  };
}

/** Lần đọc đã đủ các trường thường thấy trên màn hình Giới thiệu chưa (để khỏi đọc thêm cả ảnh). */
export function isComplete(x: TextExtraction): boolean {
  return Boolean(x.serial && x.serialAnchored && x.partNumber && x.imeis.length > 0);
}
