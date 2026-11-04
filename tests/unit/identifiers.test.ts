import { describe, expect, it } from "vitest";
import {
  classifyCode,
  fixOcrImei,
  isValidEan13,
  isValidImei,
  isValidUpcA,
  partNumberRegion,
  splitPastedText,
} from "@/domain/identifiers";

describe("isValidImei (Luhn)", () => {
  it("chấp nhận IMEI đúng số kiểm tra", () => {
    expect(isValidImei("350000000000006")).toBe(true);
    expect(isValidImei("350000000000014")).toBe(true);
    expect(isValidImei("490154203237518")).toBe(true); // ví dụ chuẩn trong tài liệu IMEI
  });
  it("từ chối IMEI sai số kiểm tra, sai độ dài, có chữ", () => {
    expect(isValidImei("350000000000001")).toBe(false);
    expect(isValidImei("35000000000000")).toBe(false);
    expect(isValidImei("3500000000000060")).toBe(false);
    expect(isValidImei("35000000000000A")).toBe(false);
  });
  it("phát hiện mọi lỗi đọc sai một chữ số", () => {
    const imei = "490154203237518";
    for (let i = 0; i < 15; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === imei[i]) continue;
        const wrong = imei.slice(0, i) + d + imei.slice(i + 1);
        expect(isValidImei(wrong), wrong).toBe(false);
      }
    }
  });
});

describe("UPC / EAN", () => {
  it("kiểm tra số kiểm tra GS1", () => {
    expect(isValidUpcA("012345678905")).toBe(true);
    expect(isValidUpcA("012345678904")).toBe(false);
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });
});

describe("classifyCode", () => {
  const cases: [string, string, string][] = [
    ["350000000000006", "IMEI", "350000000000006"],
    [" 3500 0000 0000 006 ", "IMEI", "350000000000006"],
    ["1PMDEM1LL/A", "PART_NUMBER", "MDEM1LL/A"],
    ["MDEM1LL/A", "PART_NUMBER", "MDEM1LL/A"],
    ["mdem1vn/a", "PART_NUMBER", "MDEM1VN/A"],
    ["MDEM3J/A", "PART_NUMBER", "MDEM3J/A"],
    ["SF2LXQ7Y9KD", "SERIAL", "F2LXQ7Y9KD"],
    ["F2LXQ7Y9KD", "SERIAL", "F2LXQ7Y9KD"],
    ["SXYZ1234567", "SERIAL", "XYZ1234567"],
    ["C02XL0GTJGH5", "SERIAL", "C02XL0GTJGH5"],
    ["012345678905", "UPC", "012345678905"],
    ["0012345678905", "UPC", "012345678905"], // UPC-A bộ giải mã trả về dạng EAN-13
    ["4006381333931", "EAN", "4006381333931"],
    ["8".repeat(32), "EID", "8".repeat(32)],
    ["350000000000001", "UNKNOWN", "350000000000001"],
    ["HELLO", "UNKNOWN", "HELLO"],
  ];
  it.each(cases)("%s → %s", (raw, kind, value) => {
    const c = classifyCode(raw);
    expect(c.kind).toBe(kind);
    expect(c.value).toBe(value);
  });
});

describe("partNumberRegion", () => {
  it("tách hậu tố thị trường", () => {
    expect(partNumberRegion("MDEM1LL/A")).toBe("LL/A");
    expect(partNumberRegion("MDEM1VN/A")).toBe("VN/A");
    expect(partNumberRegion("MDEM3J/A")).toBe("J/A");
    expect(partNumberRegion("ABC")).toBeNull();
  });
});

describe("fixOcrImei", () => {
  it("sửa ký tự dễ nhầm khi kết quả qua được Luhn", () => {
    expect(fixOcrImei("3SOOOOOOOOOOOO6")).toBe("350000000000006");
    expect(fixOcrImei("49O154ZO3237SI8")).toBe("490154203237518");
  });
  it("không 'sửa bừa' khi kết quả vẫn sai số kiểm tra", () => {
    expect(fixOcrImei("3SOOOOOOOOOOOO7")).toBeNull();
  });
});

describe("splitPastedText", () => {
  it("tách theo dòng và theo tab/dấu phẩy/khoảng trắng", () => {
    expect(splitPastedText("F2LXQ7Y9KD\t350000000000006\tMDEM1LL/A\n\nC02XL0GTJGH5, 350000000000014")).toEqual([
      ["F2LXQ7Y9KD", "350000000000006", "MDEM1LL/A"],
      ["C02XL0GTJGH5", "350000000000014"],
    ]);
  });
});
