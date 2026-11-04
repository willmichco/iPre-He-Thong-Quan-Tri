import { describe, expect, it } from "vitest";
import {
  mergeStream,
  recordsFromPhoto,
  setField,
  toCsv,
  toTsv,
  validateRecord,
  type StreamState,
} from "@/domain/scan-session";

function ids() {
  let n = 0;
  return () => `r${++n}`;
}

describe("mergeStream — quét liên tục", () => {
  it("gom các mã của một hộp vào một máy, sang hộp mới khi gặp serial thứ hai", () => {
    const makeId = ids();
    let s: StreamState = { records: [], currentId: null };
    s = mergeStream(s, ["SF2LXQ7Y9KD", "350000000000006", "1PMDEM1LL/A"], "BARCODE", "CAMERA", makeId);
    s = mergeStream(s, ["SC02XL0GTJGH5", "350000000000014"], "BARCODE", "CAMERA", makeId);
    expect(s.records).toHaveLength(2);
    expect(s.records[0].fields.serial?.value).toBe("F2LXQ7Y9KD");
    expect(s.records[0].fields.imei1?.value).toBe("350000000000006");
    expect(s.records[0].fields.partNumber?.value).toBe("MDEM1LL/A");
    expect(s.records[1].fields.serial?.value).toBe("C02XL0GTJGH5");
    expect(s.records[1].fields.imei1?.value).toBe("350000000000014");
    expect(s.currentId).toBe(s.records[1].id);
  });

  it("bỏ qua mã đã quét (camera đọc lặp một mã nhiều lần)", () => {
    const makeId = ids();
    let s: StreamState = { records: [], currentId: null };
    for (let i = 0; i < 5; i++) s = mergeStream(s, ["SF2LXQ7Y9KD", "350000000000006"], "BARCODE", "CAMERA", makeId);
    expect(s.records).toHaveLength(1);
    expect(s.records[0].fields.imei2).toBeUndefined();
  });

  it("hai IMEI vào IMEI 1 và IMEI 2; IMEI thứ ba mở máy mới", () => {
    const makeId = ids();
    const s = mergeStream(
      { records: [], currentId: null },
      ["350000000000006", "350000000000014", "490154203237518"],
      "HW_SCANNER",
      "HW_SCANNER",
      makeId,
    );
    expect(s.records).toHaveLength(2);
    expect(s.records[0].fields.imei2?.value).toBe("350000000000014");
    expect(s.records[1].fields.imei1?.value).toBe("490154203237518");
  });
});

describe("recordsFromPhoto", () => {
  it("ảnh một hộp → một máy", () => {
    const r = recordsFromPhoto(
      [
        { text: "SF2LXQ7Y9KD", x: 100, y: 50 },
        { text: "350000000000006", x: 100, y: 120 },
        { text: "1PMDEM1LL/A", x: 100, y: 190 },
        { text: "012345678905", x: 300, y: 190 },
      ],
      "hop-1.jpg",
      ids(),
    );
    expect(r).toHaveLength(1);
    expect(r[0].photoName).toBe("hop-1.jpg");
    expect(r[0].fields.upc?.value).toBe("012345678905");
  });

  it("ảnh hai hộp cạnh nhau → hai máy, mã gán cho serial gần nhất", () => {
    const r = recordsFromPhoto(
      [
        { text: "SF2LXQ7Y9KD", x: 100, y: 50 },
        { text: "350000000000006", x: 110, y: 120 },
        { text: "SC02XL0GTJGH5", x: 900, y: 50 },
        { text: "350000000000014", x: 910, y: 120 },
      ],
      "hai-hop.jpg",
      ids(),
    );
    expect(r).toHaveLength(2);
    const bySerial = Object.fromEntries(r.map((x) => [x.fields.serial?.value, x.fields.imei1?.value]));
    expect(bySerial).toEqual({ F2LXQ7Y9KD: "350000000000006", C02XL0GTJGH5: "350000000000014" });
  });
});

describe("validateRecord", () => {
  const makeId = ids();
  const base = mergeStream({ records: [], currentId: null }, ["SF2LXQ7Y9KD", "350000000000006", "1PMDEM1LL/A"], "BARCODE", "CAMERA", makeId).records[0];

  it("không có lỗi với máy hợp lệ, hàng Mỹ", () => {
    expect(validateRecord(base, [base])).toEqual([]);
  });
  it("báo lỗi IMEI gõ tay sai số kiểm tra", () => {
    const edited = setField(base, "imei1", "350000000000001");
    expect(edited.fields.imei1?.source).toBe("MANUAL");
    expect(validateRecord(edited, [edited]).some((i) => i.field === "imei1" && i.severity === "error")).toBe(true);
  });
  it("cảnh báo mã thị trường không phải LL/A", () => {
    const vn = setField(base, "partNumber", "MDEM1VN/A");
    expect(validateRecord(vn, [vn]).map((i) => i.message).join()).toContain("VN/A");
  });
  it("báo trùng serial giữa hai máy", () => {
    const other = { ...base, id: "khac" };
    expect(validateRecord(base, [base, other]).some((i) => i.message.includes("Trùng"))).toBe(true);
  });
});

describe("xuất dữ liệu", () => {
  const rec = mergeStream({ records: [], currentId: null }, ["SF2LXQ7Y9KD", "350000000000006"], "BARCODE", "CAMERA", ids()).records;
  it("TSV dán vào Excel", () => {
    expect(toTsv(rec).split("\n")[1]).toBe("1\tF2LXQ7Y9KD\t350000000000006\t\t\t\t\tCAMERA\t\t");
  });
  it("CSV giữ IMEI dạng chữ (Excel không đổi thành 3,5E+14)", () => {
    const csv = toCsv(rec);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"=""350000000000006"""');
  });
});

describe("applyExtraction — kết quả OCR", () => {
  it("chỉ điền ô trống, không đè giá trị đọc từ mã vạch; serial OCR có cảnh báo soát lại", async () => {
    const { applyExtraction } = await import("@/domain/scan-session");
    const base = mergeStream({ records: [], currentId: null }, ["350000000000006"], "BARCODE", "CAMERA", ids()).records[0];
    const { record, filled } = applyExtraction(base, {
      serial: "F2LXQ7Y9KD",
      serialAnchored: true,
      imeis: ["350000000000006", "350000000000014"],
      partNumber: "MDEM1LL/A",
    });
    expect(filled).toBe(3);
    expect(record.fields.imei1).toEqual({ value: "350000000000006", source: "BARCODE" });
    expect(record.fields.imei2).toEqual({ value: "350000000000014", source: "OCR" });
    expect(record.fields.partNumber?.source).toBe("OCR");
    expect(validateRecord(record, [record]).some((i) => i.field === "serial" && i.message.includes("OCR"))).toBe(true);
  });
});

describe("findMatch / mergeRecord — chụp lại cùng một hộp", () => {
  it("nhận ra máy đã có theo IMEI và chỉ bổ sung ô còn thiếu", async () => {
    const { findMatch, mergeRecord, recordsFromPhoto: fromPhoto } = await import("@/domain/scan-session");
    const makeId = ids();
    const existing = mergeStream({ records: [], currentId: null }, ["350000000000006"], "BARCODE", "CAMERA", makeId).records;
    const photo = fromPhoto(
      [
        { text: "SF2LXQ7Y9KD", x: 0, y: 0 },
        { text: "350000000000006", x: 0, y: 50 },
      ],
      "lan-2.jpg",
      makeId,
    )[0];
    const match = findMatch(existing, photo);
    expect(match?.id).toBe(existing[0].id);
    const { record, filled } = mergeRecord(match!, photo);
    expect(filled).toBe(1);
    expect(record.fields.serial?.value).toBe("F2LXQ7Y9KD");
    expect(record.fields.imei2).toBeUndefined();
  });
});

describe("mergeLiveFrame — camera thấy hai nhãn xếp chồng (không gán chéo Part No.)", () => {
  // Toạ độ như khung hình 1080p: nhãn iPhone ở trên, nhãn iPad ở dưới
  const iphone = [
    { text: "1PMDEM1LL/A", x: 700, y: 120 },
    { text: "SF2LXQ7Y9KD", x: 700, y: 236 },
    { text: "350000000000006", x: 700, y: 336 },
    { text: "350000000000014", x: 700, y: 436 },
    { text: "012345678905", x: 1100, y: 536 },
  ];
  const ipad = [
    { text: "1PMDEM2VN/A", x: 700, y: 700 },
    { text: "SC02XL0GTJGH5", x: 700, y: 800 },
    { text: "490154203237518", x: 700, y: 900 },
  ];

  it("khung cắt giữa (iPhone thiếu Part No., thấy Part No. của iPad bên dưới) → không gán nhầm", async () => {
    const { mergeLiveFrame } = await import("@/domain/scan-session");
    const makeId = ids();
    let s: StreamState = { records: [], currentId: null };
    // khung 1: vùng giữa — iPhone serial/IMEI/UPC + chỉ dòng Part No. của iPad
    s = mergeLiveFrame(s, [...iphone.slice(1), ipad[0]], makeId);
    expect(s.records).toHaveLength(1);
    expect(s.records[0].fields.partNumber).toBeUndefined();
    // khung 2: toàn khung — thấy cả hai nhãn
    s = mergeLiveFrame(s, [...iphone, ...ipad], makeId);
    const bySerial = Object.fromEntries(s.records.map((r) => [r.fields.serial?.value, r.fields.partNumber?.value]));
    expect(bySerial).toEqual({ F2LXQ7Y9KD: "MDEM1LL/A", C02XL0GTJGH5: "MDEM2VN/A" });
    const iphoneRec = s.records.find((r) => r.fields.serial?.value === "F2LXQ7Y9KD")!;
    expect(iphoneRec.fields.upc?.value).toBe("012345678905");
    expect(iphoneRec.fields.imei2?.value).toBe("350000000000014");
  });

  it("ảnh chụp hai hộp: mỗi IMEI/Part No./UPC về đúng máy", () => {
    const recs = recordsFromPhoto([...iphone, ...ipad], "hai-hop.jpg", ids());
    const by = Object.fromEntries(recs.map((r) => [r.fields.serial?.value, [r.fields.imei1?.value, r.fields.partNumber?.value, r.fields.upc?.value]]));
    expect(by).toEqual({
      F2LXQ7Y9KD: ["350000000000006", "MDEM1LL/A", "012345678905"],
      C02XL0GTJGH5: ["490154203237518", "MDEM2VN/A", undefined],
    });
  });
});
