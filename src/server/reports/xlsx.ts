/**
 * Ghi file Excel (.xlsx, Office Open XML) tối giản — không cần thư viện ngoài.
 * .xlsx là một tệp ZIP chứa vài tệp XML; ở đây tự đóng gói ZIP (nén deflate của zlib, CRC32 của zlib).
 * Hỗ trợ: nhiều trang tính, dòng tiêu đề in đậm + cố định khi cuộn, cột tiền (#,##0), phần trăm, số lẻ,
 * dòng tổng in đậm, độ rộng cột tự tính. Tiền là số nguyên VND (Excel giữ chính xác tới 15 chữ số).
 */
import { zip } from "@/server/zip";

export { zip };

export type ColumnType = "text" | "money" | "int" | "pct" | "dec";

export interface Column {
  header: string;
  type: ColumnType;
  /** độ rộng (ký tự); bỏ trống = tự tính */
  width?: number;
}

/** Giá trị ô: pct truyền điểm cơ bản (553 = 5,53%); money/int truyền bigint hoặc number. */
export type Value = string | number | bigint | null | undefined;

export interface Sheet {
  name: string;
  /** các dòng mô tả phía trên bảng (in đậm dòng đầu) */
  title?: string[];
  columns: Column[];
  rows: Value[][];
  /** dòng tổng (in đậm) */
  total?: Value[];
}

// Kiểu ô (thứ tự trong cellXfs của styles.xml)
const S = { text: 0, bold: 1, money: 2, moneyBold: 3, pct: 4, pctBold: 5, dec: 6, decBold: 7 } as const;

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // ký tự điều khiển không hợp lệ trong XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** Chỉ số cột (0) → tên cột Excel ("A", "Z", "AA"). */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Tên trang tính hợp lệ: ≤ 31 ký tự, không chứa []:*?/\ và không trùng. */
export function sheetName(raw: string, used: Set<string>): string {
  let base =
    raw
      .replace(/[[\]:*?/\\]/g, " ")
      .trim()
      .slice(0, 31) || "Trang";
  let name = base;
  for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
  used.add(name.toLowerCase());
  base = name;
  return base;
}

function cell(ref: string, v: Value, type: ColumnType, bold: boolean): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "string" || type === "text") {
    return `<c r="${ref}" t="inlineStr"${bold ? ` s="${S.bold}"` : ""}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
  }
  if (type === "pct") {
    const n = Number(v) / 10000;
    return `<c r="${ref}" s="${bold ? S.pctBold : S.pct}"><v>${n}</v></c>`;
  }
  const s = type === "dec" ? (bold ? S.decBold : S.dec) : bold ? S.moneyBold : S.money;
  const num = typeof v === "bigint" ? v.toString() : Number.isFinite(v) ? String(v) : "";
  return num === "" ? "" : `<c r="${ref}" s="${s}"><v>${num}</v></c>`;
}

const displayLen = (v: Value, type: ColumnType) =>
  v === null || v === undefined
    ? 0
    : type === "text" || typeof v === "string"
      ? String(v).length
      : type === "pct"
        ? 8
        : String(v).length + Math.floor(String(v).length / 3) + 1;

function sheetXml(sh: Sheet): string {
  const out: string[] = [];
  let r = 0;
  const row = (cells: string, height?: number) => out.push(`<row r="${++r}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells}</row>`);
  (sh.title ?? []).forEach((t, k) => row(cell(`A${r + 1}`, t, "text", k === 0)));
  if (sh.title?.length) row("");
  const headerRow = r + 1;
  row(sh.columns.map((c, i) => cell(`${colName(i)}${r + 1}`, c.header, "text", true)).join(""));
  for (const vals of sh.rows) row(sh.columns.map((c, i) => cell(`${colName(i)}${r + 1}`, vals[i], c.type, false)).join(""));
  if (sh.total) row(sh.columns.map((c, i) => cell(`${colName(i)}${r + 1}`, sh.total![i], c.type, true)).join(""));

  const widths = sh.columns.map((c, i) => {
    if (c.width) return c.width;
    const longest = Math.max(c.header.length, ...sh.rows.map((x) => displayLen(x[i], c.type)), sh.total ? displayLen(sh.total[i], c.type) : 0);
    return Math.min(Math.max(longest + 2, 8), 60);
  });
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  const lastCol = colName(Math.max(sh.columns.length - 1, 0));
  const pane = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  const filter = sh.rows.length ? `<autoFilter ref="A${headerRow}:${lastCol}${headerRow + sh.rows.length}"/>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${pane}${cols}<sheetData>${out.join("")}</sheetData>${filter}</worksheet>`
  );
}

const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="8">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` + // text
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` + // bold
  `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // #,##0
  `<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 0.00%
  `<xf numFmtId="10" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 0.0
  `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Dựng nội dung (các tệp XML) của sổ tính. */
export function workbookFiles(sheets: readonly Sheet[]): { name: string; data: string }[] {
  if (!sheets.length) throw new Error("Sổ tính cần ít nhất một trang");
  const used = new Set<string>();
  const names = sheets.map((s) => sheetName(s.name, used));
  const files = [
    {
      name: "[Content_Types].xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        `</Types>`,
    },
    {
      name: "_rels/.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
        `<definedNames>${sheets
          .map((s, i) => {
            const header = (s.title?.length ? s.title.length + 1 : 0) + 1;
            return s.rows.length
              ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i].replace(/'/g, "''"))}'!$A$${header}:$${colName(s.columns.length - 1)}$${header + s.rows.length}</definedName>`
              : "";
          })
          .join("")}</definedNames></workbook>`.replace("<definedNames></definedNames>", ""),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return files;
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function buildXlsx(sheets: readonly Sheet[]): Buffer {
  return zip(workbookFiles(sheets));
}
