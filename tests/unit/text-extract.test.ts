import { describe, expect, it } from "vitest";
import { extractFromText, hasIdentity } from "@/domain/text-extract";

// Số liệu minh hoạ (IMEI hợp lệ theo Luhn nhưng không thuộc thiết bị thật nào)
const IMEI1 = "350000000000006";
const IMEI2 = "350000000000014";

describe("extractFromText — ảnh chụp màn hình Cài đặt › Giới thiệu", () => {
  it("giao diện tiếng Anh, IMEI có khoảng trắng như iOS hiển thị", () => {
    const text = [
      "General   About",
      "Name   iPhone",
      "iOS Version   26.1",
      "Model Name   iPhone 16 Pro Max",
      "Model Number   MDEM1LL/A",
      "Serial Number   F2LXQ7Y9KD",
      "Limited Warranty   Expires: 10/2027",
      "Physical SIM",
      "IMEI   35 000000 000000 6",
      "IMEI2   35 000000 000001 4",
      "EID   89049032007008882600123456789012",
    ].join("\n");
    const x = extractFromText(text);
    expect(x.imeis).toEqual([IMEI1, IMEI2]);
    expect(x.serial).toBe("F2LXQ7Y9KD");
    expect(x.serialAnchored).toBe(true);
    expect(x.partNumber).toBe("MDEM1LL/A");
    expect(x.eid).toBe("89049032007008882600123456789012");
    expect(hasIdentity(x)).toBe(true);
  });

  it("giao diện tiếng Việt, OCR làm mất dấu và đọc nhầm vài ký tự", () => {
    const text = [
      "Cai dat chung  Gioi thieu",
      "So kieu may  MDEM1VN/A",
      "So se-ri   F2LXQ7Y9KD",
      "IMEI  3S 0O0000 000O00 6", // OCR nhầm 5→S, 0→O ở vài chỗ — sửa được nhờ Luhn
    ].join("\n");
    const x = extractFromText(text);
    expect(x.imeis).toEqual([IMEI1]);
    expect(x.serial).toBe("F2LXQ7Y9KD");
    expect(x.partNumber).toBe("MDEM1VN/A");
  });

  it("serial nằm ở dòng dưới nhãn", () => {
    const x = extractFromText("Serial Number\nC02XL0GTJGH5\nIMEI\n" + IMEI1);
    expect(x.serial).toBe("C02XL0GTJGH5");
    expect(x.serialAnchored).toBe(true);
  });
});

describe("extractFromText — chữ trên nhãn sau hộp máy", () => {
  it("đọc Part No. ở giữa dòng mô tả, (S) Serial, IMEI/MEID, IMEI2, UPC", () => {
    const text = [
      "MDEM1VN/A iPhone 16 Pro Max, Desert Titanium, 256GB",
      "Assembled in China  Other items as marked thereon  Model A3296",
      "(S) Serial No. F2LXQ7Y9KD",
      `IMEI/MEID ${IMEI1}`,
      `IMEI2 ${IMEI2}`,
      "UPC 0 12345 67890 5",
    ].join("\n");
    const x = extractFromText(text);
    expect(x.partNumber).toBe("MDEM1VN/A");
    expect(x.serial).toBe("F2LXQ7Y9KD");
    expect(x.imeis).toEqual([IMEI1, IMEI2]);
    expect(x.upc).toBe("012345678905");
  });

  it("OCR đọc dấu / thành |", () => {
    expect(extractFromText("MDEM1LL|A iPhone").partNumber).toBe("MDEM1LL/A");
  });
});

describe("extractFromText — an toàn, không nhận bừa", () => {
  it("bỏ qua chuỗi 15 số sai số kiểm tra", () => {
    expect(extractFromText("IMEI 350000000000001").imeis).toEqual([]);
  });
  it("không có nhãn neo và nhiều ứng viên serial → không đoán", () => {
    const x = extractFromText("ABCDE12345 XYZW987654");
    expect(x.serial).toBeUndefined();
  });
  it("không có nhãn neo nhưng chỉ một ứng viên → nhận, đánh dấu không neo", () => {
    const x = extractFromText(`F2LXQ7Y9KD\n${IMEI1}`);
    expect(x.serial).toBe("F2LXQ7Y9KD");
    expect(x.serialAnchored).toBe(false);
  });
  it("không nhầm mã máy (A3296), từ thường hay Part No. thành serial", () => {
    const x = extractFromText("Model A3296\nMDEM1LL/A\nWARRANTY EXPIRES");
    expect(x.serial).toBeUndefined();
    expect(hasIdentity(x)).toBe(false);
  });
});

describe("extractFromText — ảnh chụp màn hình iPhone thật (giao diện Việt, chụp bằng máy khác)", () => {
  it("bỏ qua MEID (14 số), ICCID (20 số), số phiên bản modem; nhận IMEI, IMEI2, EID", async () => {
    const { hasStrongIdentity } = await import("@/domain/text-extract");
    const text = [
      "21:00",
      "Quay lại   Giới thiệu",
      "Vi chương trình modem   5.70.01",
      "SEID",
      "EID",
      "89049032006008882600112027269850",
      "Khóa mạng   Không giới hạn SIM",
      "SIM VẬT LÝ",
      "Mạng   Viettel",
      "Nhà cung cấp   Viettel 64.0",
      "IMEI   35 000000 000000 6",
      "ICCID   89840480000262966254",
      "MEID   35000000000000",
      "SIM KHẢ DỤNG",
      "IMEI2   35 000000 000001 4",
      "THỜI GIAN BAO TEST", // chữ trên tờ giấy phía sau máy
    ].join("\n");
    const x = extractFromText(text, { ocr: true });
    expect(x.imeis).toEqual([IMEI1, IMEI2]);
    expect(x.eid).toBe("89049032006008882600112027269850");
    expect(x.serial).toBeUndefined();
    expect(hasStrongIdentity(x)).toBe(true);
  });

  it("giao diện tiếng Anh kiểu Apple: Serial 12 ký tự, Model Number", () => {
    const x = extractFromText("Model Name   iPhone XS\nModel Number   NTAH2LL/A\nSerial Number   X01X23Y4XYXY", { ocr: true });
    expect(x.serial).toBe("X01X23Y4XYXY");
    expect(x.serialAnchored).toBe(true);
    expect(x.partNumber).toBe("NTAH2LL/A");
  });

  it("OCR nhầm 1→I trong Part No. được sửa lại", () => {
    expect(extractFromText("Model Number MDEMILL/A", { ocr: true }).partNumber).toBe("MDEM1LL/A");
    expect(extractFromText("Model Number MDEMILL/A").partNumber).toBe("MDEMILL/A"); // văn bản gõ/dán: giữ nguyên
  });
});
