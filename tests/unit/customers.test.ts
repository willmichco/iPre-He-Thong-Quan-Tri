import { describe, expect, it } from "vitest";
import { anonymousName, checkCustomer, normalizePhone, warrantyState } from "@/domain/customers";

describe("Khách hàng", () => {
  it("chuẩn hoá số điện thoại Việt Nam", () => {
    expect(normalizePhone("0901 234 567")).toBe("0901234567");
    expect(normalizePhone("+84 901-234-567")).toBe("0901234567");
    expect(normalizePhone("84901234567")).toBe("0901234567");
    expect(normalizePhone("(028) 3822.1234")).toBe("02838221234");
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("12345")).toBeUndefined();
    expect(normalizePhone("0901abc567")).toBeUndefined();
  });
  it("kiểm tra form khách", () => {
    expect(checkCustomer({ fullName: " Chị Lan ", phone: "+84901234567", zalo: "", note: " giao giờ hành chính " })).toEqual({
      ok: true,
      data: { fullName: "Chị Lan", phone: "0901234567", zalo: null, facebook: null, address: null, note: "giao giờ hành chính" },
    });
    expect(checkCustomer({ fullName: "A", phone: "999" })).toEqual({
      ok: false,
      errors: { fullName: "Nhập tên khách", phone: "Số điện thoại không hợp lệ (vd 0901 234 567)" },
    });
  });
  it("tên ẩn danh không chứa thông tin khách; trạng thái bảo hành", () => {
    expect(anonymousName("b0000000-0000-0000-0000-000000000001")).toBe("Khách đã ẩn danh #B00000");
    expect(warrantyState(null, "2026-11-05")).toBe("NONE");
    expect(warrantyState("2026-11-05", "2026-11-05")).toBe("ACTIVE");
    expect(warrantyState("2026-11-04", "2026-11-05")).toBe("EXPIRED");
  });
});
