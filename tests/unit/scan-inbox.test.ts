import { describe, expect, it } from "vitest";
import { codesOf, reviewCapture, sanitizeRecords, scanSourceOf } from "@/domain/scan-inbox";

const IMEI_OK = "350000000000006";
const ctx = { variantLabel: "iPhone 17 Pro Max · 256GB · Silver", existing: [], duplicateInInbox: false };

describe("Hộp chờ duyệt", () => {
  it("chuẩn hoá bản ghi gửi từ trình duyệt; bỏ dòng rỗng; chặn dữ liệu lạ", () => {
    const r = sanitizeRecords([
      {
        id: "a",
        origin: "PHOTO",
        fields: { serial: { value: " f2lx q7y9kd ", source: "BARCODE" }, imei1: { value: IMEI_OK, source: "OCR" } },
        extras: ["X"],
        note: " hộp móp ",
      },
      { id: "b", origin: "HACK", fields: { partNumber: { value: "mdem1ll/a", source: "<script>" }, evil: { value: "x", source: "BARCODE" } } },
      { id: "c", origin: "CAMERA", fields: {} },
    ]);
    expect(r).toEqual([
      {
        clientId: "a",
        origin: "PHOTO",
        fields: { serial: { value: "F2LXQ7Y9KD", source: "BARCODE" }, imei1: { value: IMEI_OK, source: "OCR" } },
        extras: ["X"],
        note: "hộp móp",
      },
      { clientId: "b", origin: "MANUAL", fields: { partNumber: { value: "MDEM1LL/A", source: "MANUAL" } }, extras: [], note: null },
    ]);
    expect(() => sanitizeRecords("x")).toThrow(/không hợp lệ/);
    expect(() => sanitizeRecords([null])).toThrow(/không hợp lệ/);
    expect(() => sanitizeRecords(Array.from({ length: 301 }, () => ({})))).toThrow(/Tối đa 300/);
    expect([scanSourceOf("CAMERA"), scanSourceOf("MANUAL")]).toEqual(["CAMERA_LIVE", "PASTE"]);
    expect(codesOf({ serial: { value: "S", source: "BARCODE" }, partNumber: { value: "P", source: "BARCODE" }, imei2: { value: "I", source: "OCR" } })).toEqual(
      ["S", "I"],
    );
  });

  it("soát dòng: hợp lệ / cần soát / lỗi", () => {
    const ok = reviewCapture(
      {
        serial: { value: "F2LXQ7Y9KD", source: "BARCODE" },
        imei1: { value: IMEI_OK, source: "BARCODE" },
        partNumber: { value: "MDEM1LL/A", source: "BARCODE" },
      },
      ctx,
    );
    expect(ok).toEqual({ level: "OK", issues: [] });

    const warn = reviewCapture(
      { serial: { value: "F2LXQ7Y9KD", source: "OCR" }, partNumber: { value: "MXYZ9ZA/A", source: "BARCODE" } },
      { ...ctx, variantLabel: null, duplicateInInbox: true, existing: [{ code: "F2LXQ7Y9KD", label: "chuyến CH-2026-011 (IN_STOCK)" }] },
    );
    expect(warn.level).toBe("WARN");
    expect(warn.issues.map((i) => i.message)).toEqual([
      "Soát Serial (đọc chữ, không phải mã vạch)",
      "Mã MXYZ9ZA/A chưa gán cấu hình — gán ở Danh mục › Mã Part No.",
      "Không phải hàng thị trường LL/A (ZA/A)",
      "Trùng với dòng khác trong hộp chờ",
      "F2LXQ7Y9KD đã có trong hệ thống: chuyến CH-2026-011 (IN_STOCK)",
    ]);

    const err = reviewCapture({ imei1: { value: "350000000000007", source: "BARCODE" } }, ctx);
    expect(err.level).toBe("ERROR");
    expect(err.issues[0].message).toContain("IMEI 1 sai số kiểm tra");
    expect(reviewCapture({ partNumber: { value: "MDEM1LL/A", source: "BARCODE" } }, ctx).issues[0]).toEqual({
      level: "ERROR",
      message: "Chưa có Serial / IMEI — chụp lại hoặc nhập tay",
    });
  });
});
