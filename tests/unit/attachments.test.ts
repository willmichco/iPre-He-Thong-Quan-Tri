import { describe, expect, it } from "vitest";
import { checkUpload, dossierGaps, formatBytes, MAX_BYTES, safeFileName, sniffMime, storageKey } from "@/domain/attachments";

const bytes = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));
const PDF = bytes("%PDF-1.7\n", 0x25, 0xe2);
const JPG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const WEBP = bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 ");
const HEIC = bytes(0, 0, 0, 0x18, "ftypheic", 0, 0);

describe("Chứng từ đính kèm", () => {
  it("nhận diện loại tệp theo nội dung, không theo tên", () => {
    expect([PDF, JPG, PNG, WEBP, HEIC].map(sniffMime)).toEqual(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);
    expect(sniffMime(bytes(0, 0, 0, 0x18, "ftypmif1"))).toBe("image/heif");
    expect(sniffMime(bytes("<html><script>"))).toBeNull();
    expect(sniffMime(bytes("PK", 3, 4))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });
  it("kiểm tra tệp tải lên: rỗng / quá lớn / sai định dạng; đuôi lưu theo loại thật", () => {
    expect(checkUpload("hoa-don.pdf", PDF)).toEqual({ ok: true, mime: "application/pdf", ext: "pdf", name: "hoa-don.pdf" });
    expect(checkUpload("anh.pdf", JPG)).toMatchObject({ ok: true, mime: "image/jpeg", ext: "jpg", name: "anh.pdf" });
    expect(checkUpload("x.html", bytes("<html>"))).toMatchObject({ ok: false, error: expect.stringContaining("chỉ nhận ảnh") });
    expect(checkUpload("rong.pdf", new Uint8Array())).toMatchObject({ ok: false, error: expect.stringContaining("rỗng") });
    const big = new Uint8Array(MAX_BYTES + 1);
    big.set(PDF);
    expect(checkUpload("to.pdf", big)).toMatchObject({ ok: false, error: expect.stringContaining("15 MB") });
  });
  it("tên tệp an toàn: bỏ đường dẫn, ký tự cấm; giới hạn độ dài giữ đuôi", () => {
    expect(safeFileName("C:\\Users\\a\\Hoá đơn  Apple.pdf", "pdf")).toBe("Hoá đơn Apple.pdf");
    expect(safeFileName("../../etc/passwd", "pdf")).toBe("passwd");
    expect(safeFileName('a"<b>|c?.jpg', "jpg")).toBe("abc.jpg");
    expect(safeFileName("", "pdf")).toBe("chung-tu.pdf");
    const long = safeFileName(`${"x".repeat(200)}.pdf`, "pdf");
    expect([long.length, long.endsWith(".pdf")]).toEqual([120, true]);
  });
  it("khoá lưu trữ theo nội dung", () => {
    const sha = "a".repeat(64);
    expect(storageKey(sha, "pdf", new Date("2026-11-05T03:00:00Z"))).toBe(`2026/11/${sha}.pdf`);
    expect(() => storageKey("../x", "pdf", new Date())).toThrow();
    expect([formatBytes(500), formatBytes(2048), formatBytes(1_572_864)]).toEqual(["500 B", "2 KB", "1,5 MB"]);
  });
  it("hồ sơ nguồn gốc: thiếu hoá đơn mua; đã qua chặng Mỹ → VN thì cần thêm chứng từ nhập khẩu", () => {
    expect(dossierGaps({ hasPurchaseDoc: false, crossedBorder: false, hasImportDoc: false })).toEqual(["PURCHASE"]);
    expect(dossierGaps({ hasPurchaseDoc: true, crossedBorder: true, hasImportDoc: false })).toEqual(["IMPORT"]);
    expect(dossierGaps({ hasPurchaseDoc: false, crossedBorder: true, hasImportDoc: false })).toEqual(["PURCHASE", "IMPORT"]);
    expect(dossierGaps({ hasPurchaseDoc: true, crossedBorder: true, hasImportDoc: true })).toEqual([]);
  });
});
