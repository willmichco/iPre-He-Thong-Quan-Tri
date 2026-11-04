import { describe, expect, it } from "vitest";
import { validate } from "@/domain/catalog";
import { nextSaleCode, parseVndInput, previewSale, saleSchema, statusFromEvents, warrantyUntil } from "@/domain/sales";

const ITEM = "80000000-0000-0000-0000-000000000003";
const BANK = "50000000-0000-0000-0000-000000000002";

describe("ô tiền gõ tắt", () => {
  it.each([
    ["34,5tr", 34_500_000n],
    ["34.5 triệu", 34_500_000n],
    ["30k", 30_000n],
    ["30 nghìn", 30_000n],
    ["1,2ty", 1_200_000_000n],
    ["1.2 tỷ", 1_200_000_000n],
    ["2m", 2_000_000n],
    ["34.500.000", 34_500_000n],
    ["34,500,000", 34_500_000n],
    ["34500000đ", 34_500_000n],
    ["34.500.000 VND", 34_500_000n],
    ["7,25tr", 7_250_000n],
  ])("%s → %s", (raw, v) => {
    expect(parseVndInput(raw)).toBe(v);
  });
  it.each(["", "abc", "34,5", "1,2345k", "-5tr", "3.45.000"])("không hiểu: %s", (raw) => {
    expect(parseVndInput(raw)).toBeNull();
  });
});

describe("xem trước lãi — ví dụ tài liệu 01", () => {
  it("iPhone bán 34,5tr, ship khách 30k → lãi 2.045.864, biên 5,93%", () => {
    const p = previewSale([{ itemId: "ip", priceVnd: 34_500_000n, costVnd: 32_424_136n }], 0n, [30_000n]);
    expect(p).toMatchObject({ revenueVnd: 34_500_000n, costVnd: 32_424_136n, expenseVnd: 30_000n, profitVnd: 2_045_864n, marginBp: 593, belowCost: [] });
  });
  it("đơn combo: giảm giá & phí chia theo giá bán; máy dưới giá vốn bị đánh dấu", () => {
    const p = previewSale(
      [
        { itemId: "a", priceVnd: 10_000_000n, costVnd: 9_000_000n },
        { itemId: "b", priceVnd: 5_000_000n, costVnd: 5_200_000n },
      ],
      300_000n,
      [30_000n, 15_000n],
    );
    expect(p.lines.map((l) => [l.discountAllocVnd, l.expenseAllocVnd, l.profitVnd])).toEqual([
      [200_000n, 30_000n, 770_000n],
      [100_000n, 15_000n, -315_000n],
    ]);
    expect(p.belowCost).toEqual(["b"]);
    expect(p.profitVnd).toBe(455_000n);
  });
});

describe("mã đơn, bảo hành, trạng thái", () => {
  it("mã đơn", () => {
    expect(nextSaleCode(2026, ["BH-2026-0001", "BH-2026-0002", "BH-2025-0999"])).toBe("BH-2026-0003");
    expect(nextSaleCode(2027, [])).toBe("BH-2027-0001");
  });
  it("bảo hành theo tháng, cuối tháng lùi về ngày cuối", () => {
    expect(warrantyUntil("2026-10-23", 6)).toBe("2027-04-23");
    expect(warrantyUntil("2026-08-31", 6)).toBe("2027-02-28");
    expect(warrantyUntil("2026-11-04", 12)).toBe("2027-11-04");
    expect(warrantyUntil("2026-11-04", 0)).toBeNull();
  });
  it("trạng thái theo mốc khi huỷ cọc", () => {
    expect(statusFromEvents(["ORDERED", "SELLER_SHIPPED", "US_WAREHOUSE_RECEIVED", "RESERVED"])).toBe("AT_US_WAREHOUSE");
    expect(statusFromEvents(["ORDERED", "SG_RECEIVED", "SOLD"])).toBe("IN_STOCK");
    expect(statusFromEvents(["ORDERED"])).toBe("ORDERED");
  });
});

describe("form bán nhanh", () => {
  it("hợp lệ", () => {
    expect(
      validate(saleSchema, { lines: [{ itemId: ITEM, price: "7,5tr" }], customerPhone: "0912.345.678", shippingFee: "30k", accountId: BANK }),
    ).toMatchObject({
      ok: true,
      data: {
        lines: [{ itemId: ITEM, price: 7_500_000n }],
        customerPhone: "0912345678",
        shippingFee: 30_000n,
        payment: "TRANSFER",
        warrantyMonths: 6,
        directShip: false,
      },
    });
  });
  it("lỗi: chưa có máy, giá sai, SĐT sai, thiếu tài khoản, cọc thiếu tiền & khách, máy trùng", () => {
    expect(validate(saleSchema, { lines: [] })).toMatchObject({ ok: false, errors: { lines: "Quét hoặc chọn ít nhất một máy" } });
    expect(
      validate(saleSchema, {
        lines: [
          { itemId: ITEM, price: "abc" },
          { itemId: ITEM, price: "" },
        ],
        customerPhone: "123",
        warrantyMonths: "99",
      }),
    ).toMatchObject({
      ok: false,
      errors: { lines: expect.stringContaining("Giá bán"), customerPhone: "Số điện thoại không hợp lệ", warrantyMonths: "Bảo hành 0–36 tháng" },
    });
    expect(
      validate(saleSchema, {
        lines: [
          { itemId: ITEM, price: "1tr" },
          { itemId: ITEM, price: "2tr" },
        ],
        accountId: BANK,
      }),
    ).toMatchObject({
      ok: false,
      errors: { lines: "Một máy bị chọn 2 lần" },
    });
    expect(validate(saleSchema, { lines: [{ itemId: ITEM, price: "1tr" }], payment: "DEPOSIT" })).toMatchObject({
      ok: false,
      errors: { paidAmount: "Nhập số tiền cọc", accountId: "Chọn tài khoản nhận tiền", customerPhone: "Đơn cọc cần SĐT hoặc tên khách" },
    });
    expect(validate(saleSchema, { lines: [{ itemId: ITEM, price: "1tr" }], payment: "UNPAID" })).toMatchObject({ ok: true });
  });
});
