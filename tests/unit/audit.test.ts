import { describe, expect, it } from "vitest";
import { changes, entityHref, parseAuditFilter, show } from "@/domain/audit";

describe("changes — trước / sau", () => {
  it("sửa: chỉ trường khác nhau; trường mới / bỏ đi", () => {
    expect(changes({ status: "HOLD", note: "x", n: 1 }, { status: "ARRIVED", note: "x", arrivedAt: "2026-01-09" })).toEqual([
      { key: "status", before: "HOLD", after: "ARRIVED" },
      { key: "n", before: "1", after: null },
      { key: "arrivedAt", before: null, after: "2026-01-09" },
    ]);
  });
  it("tạo / xoá: liệt kê toàn bộ (bỏ ô trống)", () => {
    expect(changes(null, { code: "CH-1", name: null, items: [1, 2] })).toEqual([
      { key: "code", before: null, after: "CH-1" },
      { key: "items", before: null, after: "[1,2]" },
    ]);
    expect(changes({ a: 1 }, null)).toEqual([{ key: "a", before: "1", after: null }]);
  });
  it("không phải object; giống nhau → rỗng; giá trị dài bị rút gọn", () => {
    expect(changes(null, null)).toEqual([]);
    expect(changes("a", "b")).toEqual([{ key: "giá trị", before: "a", after: "b" }]);
    expect(show("x".repeat(500))).toHaveLength(160);
  });
});

describe("đường dẫn & bộ lọc", () => {
  it("đối tượng có trang riêng → link; không có → null", () => {
    expect(entityHref("item", "abc")).toBe("/kho/abc");
    expect(entityHref("customer", "c")).toBe("/ban-hang/khach-hang/c");
    expect(entityHref("supplier", "s")).toBeNull();
    expect(entityHref("item", null)).toBeNull();
  });
  it("tham số lạ bị bỏ qua; ngày không có thật bị bỏ", () => {
    expect(
      parseAuditFilter({ loai: "shipment", "thao-tac": "UPDATE", tu: "2026-02-30", den: "2026-11-05", q: "  F2LX ", id: "NOT-UUID", truoc: "120" }),
    ).toEqual({ entityType: "shipment", action: "UPDATE", from: null, to: "2026-11-05", q: "F2LX", entityId: null, beforeId: 120 });
    expect(parseAuditFilter({ loai: "drop table", "thao-tac": "HACK", truoc: "-1" })).toMatchObject({ entityType: null, action: null, beforeId: null });
  });
});
