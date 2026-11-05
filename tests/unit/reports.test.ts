import { inflateRawSync } from "node:zlib";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  addDays,
  byQuarter,
  isReportKey,
  median,
  monthsIn,
  parseRange,
  pnlStatement,
  quadrant,
  quarterOf,
  rangeQuery,
  thresholdStatus,
} from "@/domain/reports";
import { buildXlsx, colName, sheetName, workbookFiles, zip } from "@/server/reports/xlsx";

const T = "2026-11-05";

describe("Kỳ báo cáo", () => {
  it("preset tháng / quý / năm và kỳ so sánh", () => {
    expect(parseRange({ ky: "thang" }, T)).toEqual({
      key: "thang",
      from: "2026-11-01",
      toExcl: "2026-12-01",
      label: "Tháng 11/2026",
      prevFrom: "2026-10-01",
      prevToExcl: "2026-11-01",
      prevLabel: "tháng 10/2026",
    });
    expect(parseRange({ ky: "thang-truoc" }, T)).toMatchObject({ from: "2026-10-01", toExcl: "2026-11-01", prevFrom: "2026-09-01" });
    expect(parseRange({ ky: "quy" }, T)).toMatchObject({
      from: "2026-10-01",
      toExcl: "2027-01-01",
      label: "Quý 4/2026",
      prevFrom: "2026-07-01",
      prevLabel: "quý 3/2026",
    });
    expect(parseRange({ ky: "quy-truoc" }, T)).toMatchObject({ from: "2026-07-01", toExcl: "2026-10-01", label: "Quý 3/2026" });
    expect(parseRange({ ky: "nam" }, T)).toMatchObject({
      from: "2026-01-01",
      toExcl: "2027-01-01",
      prevFrom: "2025-01-01",
      prevToExcl: "2026-01-01",
      prevLabel: "năm 2025",
    });
    expect(parseRange({ ky: "nam-truoc" }, T)).toMatchObject({ from: "2025-01-01", toExcl: "2026-01-01", label: "Năm 2025", prevFrom: "2024-01-01" });
  });
  it("đầu năm: tháng trước / quý trước lùi sang năm cũ", () => {
    expect(parseRange({ ky: "thang-truoc" }, "2026-01-15")).toMatchObject({ from: "2025-12-01", toExcl: "2026-01-01", prevFrom: "2025-11-01" });
    expect(parseRange({ ky: "quy-truoc" }, "2026-02-01")).toMatchObject({ from: "2025-10-01", toExcl: "2026-01-01", label: "Quý 4/2025" });
    expect(parseRange({ ky: "thang" }, "2026-03-31")).toMatchObject({ from: "2026-03-01", prevFrom: "2026-02-01", prevToExcl: "2026-03-01" });
  });
  it("tuỳ chọn: tính cả ngày cuối, đảo ngày ngược, so với cùng độ dài liền trước, tối đa 3 năm", () => {
    expect(parseRange({ tu: "2026-10-10", den: "2026-10-19" }, T)).toEqual({
      key: "tuy-chon",
      from: "2026-10-10",
      toExcl: "2026-10-20",
      label: "10/10/2026 – 19/10/2026",
      prevFrom: "2026-09-30",
      prevToExcl: "2026-10-10",
      prevLabel: "30/09/2026 – 09/10/2026",
    });
    expect(parseRange({ tu: "2026-10-19", den: "2026-10-10" }, T)).toMatchObject({ from: "2026-10-10", toExcl: "2026-10-20" });
    // trọn tháng → so với cùng số tháng liền trước
    expect(parseRange({ tu: "2026-10-01", den: "2026-10-31" }, T)).toMatchObject({
      prevFrom: "2026-09-01",
      prevToExcl: "2026-10-01",
      prevLabel: "01/09/2026 – 30/09/2026",
    });
    expect(parseRange({ tu: "2026-01-01", den: "2026-03-31" }, T)).toMatchObject({ prevFrom: "2025-10-01", prevToExcl: "2026-01-01" });
    expect(parseRange({ tu: "2010-01-01", den: "2026-10-10" }, T).from).toBe(addDays("2026-10-10", -3 * 366));
    expect(parseRange({ tu: "2026-02-30", den: "2026-10-10", ky: "rac" }, T).key).toBe("thang"); // ngày sai → mặc định
    expect(parseRange({}, T).key).toBe("thang");
  });
  it("tham số URL của kỳ", () => {
    expect(rangeQuery(parseRange({ ky: "quy" }, T))).toEqual({ ky: "quy" });
    expect(rangeQuery(parseRange({ tu: "2026-10-10", den: "2026-10-19" }, T))).toEqual({ tu: "2026-10-10", den: "2026-10-19" });
    expect(isReportKey("thue")).toBe(true);
    expect(isReportKey("x")).toBe(false);
  });
  it("tháng trong kỳ, quý, gom theo quý", () => {
    expect(monthsIn("2026-11-01", "2027-02-01")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(monthsIn("2026-10-10", "2026-10-20")).toEqual(["2026-10-01"]);
    expect([quarterOf("2026-01-31"), quarterOf("2026-04-01"), quarterOf("2026-12-01")]).toEqual([1, 2, 4]);
    const rows = monthsIn("2026-01-01", "2027-01-01").map((month, k) => ({ month, n: k + 1 }));
    expect(byQuarter(rows, (a, b) => ({ month: a.month, n: a.n + b.n })).map((q) => [q.quarter, q.row.n])).toEqual([
      ["Q1/2026", 6],
      ["Q2/2026", 15],
      ["Q3/2026", 24],
      ["Q4/2026", 33],
    ]);
  });
});

describe("Bảng kết quả kinh doanh", () => {
  it("doanh thu → lãi ròng; tỷ lệ trên doanh thu; thay đổi so với kỳ trước", () => {
    const cur = { units: 2, revenueVnd: 51_700_000n, cogsVnd: 48_963_872n, sellingExpenseVnd: 30_000n, opexVnd: 500_000n };
    const prev = { units: 0, revenueVnd: 0n, cogsVnd: 0n, sellingExpenseVnd: 0n, opexVnd: 1_000_000n };
    const s = pnlStatement(cur, prev);
    expect(s.map((l) => [l.key, l.current, l.previous, l.changeBp, l.ofRevenueBp])).toEqual([
      ["revenue", 51_700_000n, 0n, null, 10000],
      ["cogs", 48_963_872n, 0n, null, 9471],
      ["gross", 2_736_128n, 0n, null, 529],
      ["selling", 30_000n, 0n, null, 6],
      ["opex", 500_000n, 1_000_000n, -5000, 97],
      ["net", 2_206_128n, -1_000_000n, 32061, 427],
    ]);
    expect(s.filter((l) => l.minus).map((l) => l.key)).toEqual(["cogs", "selling", "opex"]);
    expect(pnlStatement({ ...prev, opexVnd: 0n }, prev)[0].ofRevenueBp).toBeNull();
  });
  it("xếp loại dòng máy, trung vị, ngưỡng thuế", () => {
    expect(quadrant(800, 5, 500, 10)).toBe("STAR");
    expect(quadrant(800, 20, 500, 10)).toBe("SLOW_RICH");
    expect(quadrant(100, 5, 500, 10)).toBe("FAST_THIN");
    expect(quadrant(100, 20, 500, 10)).toBe("WEAK");
    expect(quadrant(null, 5, 500, 10)).toBeNull();
    expect([median([]), median([3, 1, 2]), median([4, 1, 2, 3])]).toEqual([null, 2, 2.5]);
    expect(thresholdStatus(51_700_000n, 1_000_000_000n, 0.8)).toEqual({ usedBp: 517, remainingVnd: 948_300_000n, level: "OK" });
    expect(thresholdStatus(800_000_000n, 1_000_000_000n, 0.8).level).toBe("WARN");
    expect(thresholdStatus(1_000_000_000n, 1_000_000_000n, 0.8).level).toBe("OVER");
    expect(thresholdStatus(5n, 0n, 0.8)).toMatchObject({ usedBp: 0, level: "OK" });
  });
});

/** Đọc lại tệp ZIP: thư mục trung tâm → tên + nội dung (giải nén, kiểm CRC). */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let k = 0; k < n; k++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    expect(buf.readUInt32LE(off)).toBe(0x04034b50);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    expect(crc32(data) >>> 0).toBe(crc);
    out.set(name, data.toString("utf8"));
    p += 46 + nameLen;
  }
  return out;
}

describe("Xuất Excel (.xlsx)", () => {
  it("tên cột, tên trang tính hợp lệ và không trùng", () => {
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
    const used = new Set<string>();
    expect(sheetName("Lãi lỗ: T11/2026", used)).toBe("Lãi lỗ  T11 2026");
    expect(sheetName("lãi lỗ: t11/2026", used)).toBe("lãi lỗ  t11 2026 2");
    expect(sheetName("x".repeat(40), used)).toHaveLength(31);
    expect(sheetName("", used)).toBe("Trang");
  });
  it("ZIP đọc lại được, đúng CRC; tên tệp UTF-8", () => {
    const files = unzip(
      zip([
        { name: "a.txt", data: "xin chào" },
        { name: "thư mục/b.xml", data: "<x/>".repeat(1000) },
      ]),
    );
    expect(files.get("a.txt")).toBe("xin chào");
    expect(files.get("thư mục/b.xml")).toHaveLength(4000);
  });
  it("sổ tính: đủ tệp, ô tiền / phần trăm / chữ, thoát ký tự XML, dòng tiêu đề cố định, lọc", () => {
    const buf = buildXlsx([
      {
        name: "Báo cáo",
        title: ["Tiêu đề", "Kỳ"],
        columns: [
          { header: "Tên", type: "text" },
          { header: "Tiền", type: "money" },
          { header: "Tỷ lệ", type: "pct" },
          { header: "Ngày", type: "dec" },
        ],
        rows: [
          ["A & <B>", 51_700_000n, 553, 3.25],
          ["Trống\u0001", null, null, Number.NaN],
        ],
        total: ["Cộng", 51_700_000n, null, null],
      },
    ]);
    const f = unzip(buf);
    expect([...f.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sh = f.get("xl/worksheets/sheet1.xml")!;
    expect(sh).toContain('<c r="A4" t="inlineStr" s="1"><is><t xml:space="preserve">Tên</t></is></c>');
    expect(sh).toContain("A &amp; &lt;B&gt;");
    expect(sh).toContain('<c r="B5" s="2"><v>51700000</v></c>');
    expect(sh).toContain('<c r="C5" s="4"><v>0.0553</v></c>');
    expect(sh).toContain('<c r="D5" s="6"><v>3.25</v></c>');
    expect(sh).not.toContain("\u0001");
    expect(sh).not.toContain("NaN");
    expect(sh).toContain('<c r="B7" s="3"><v>51700000</v></c>'); // dòng tổng in đậm
    expect(sh).toContain('ySplit="4"');
    expect(sh).toContain('<autoFilter ref="A4:D6"/>');
    expect(f.get("xl/workbook.xml")).toContain("'Báo cáo'!$A$4:$D$6");
    expect(() => workbookFiles([])).toThrow();
  });
});
