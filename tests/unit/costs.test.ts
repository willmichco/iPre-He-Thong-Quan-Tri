import { describe, expect, it } from "vitest";
import { validate } from "@/domain/catalog";
import { costSchema, DEFAULT_METHOD, KINDS_BY_LEG, parseManualShares } from "@/domain/costs";

const T = "SHIPMENT:90000000-0000-0000-0000-000000000002";

describe("form chi phí", () => {
  it("VND: tỷ giá 1, cách chia mặc định theo loại, số tiền kiểu Việt Nam", () => {
    expect(validate(costSchema, { kind: "INTL_SHIPPING", target: T, amount: "684.000", incurredAt: "2026-10-08", isEstimate: "on" })).toEqual({
      ok: true,
      data: {
        kind: "INTL_SHIPPING",
        target: { type: "SHIPMENT", id: "90000000-0000-0000-0000-000000000002" },
        description: null,
        currency: "VND",
        amount: "684000.00",
        fxRate: "1.0000",
        method: "BY_WEIGHT",
        isEstimate: true,
        hasValidInvoice: false,
        incurredAt: "2026-10-08",
        accountId: null,
        paidAt: null,
        manualShares: "",
        note: null,
        amountVnd: 684_000n,
      },
    });
  });
  it("USD: bắt buộc tỷ giá riêng của khoản; quy đổi làm tròn như PostgreSQL", () => {
    expect(validate(costSchema, { kind: "US_DOMESTIC_SHIPPING", target: T, currency: "USD", amount: "20", incurredAt: "2026-10-02" })).toEqual({
      ok: false,
      errors: { fxRate: "Nhập tỷ giá của khoản này (vd 26.400)" },
    });
    expect(
      validate(costSchema, {
        kind: "US_DOMESTIC_SHIPPING",
        target: T,
        currency: "USD",
        amount: "$12.34",
        fxRate: "26.400",
        method: "BY_VALUE",
        incurredAt: "2026-10-02",
      }),
    ).toMatchObject({ ok: true, data: { fxRate: "26400.0000", method: "BY_VALUE", amountVnd: 325_776n } });
    // 0,5 đồng làm tròn ra xa số 0 (cả số âm — hoàn phí)
    expect(validate(costSchema, { kind: "FX_FEE", target: T, currency: "USD", amount: "-0.01", fxRate: "50", incurredAt: "2026-10-02" })).toMatchObject({
      ok: true,
      data: { amountVnd: -1n },
    });
  });
  it("lỗi theo ô", () => {
    expect(validate(costSchema, { kind: "XYZ", target: "SHIPMENT:abc", amount: "0", incurredAt: "" })).toEqual({
      ok: false,
      errors: {
        kind: "Chọn loại chi phí",
        target: "Chọn chi phí này gắn vào đâu",
        amount: "Số tiền không hợp lệ (khác 0; âm = hoàn phí)",
        incurredAt: "Nhập ngày phát sinh",
      },
    });
    expect(validate(costSchema, { kind: "HANDLING", target: T, amount: "", incurredAt: "2026-10-02", accountId: "x", paidAt: "hôm qua" })).toEqual({
      ok: false,
      errors: { amount: "Nhập số tiền", accountId: "Lựa chọn không hợp lệ", paidAt: "Ngày trả không hợp lệ" },
    });
  });
  it("mặc định theo tài liệu 01 mục 5.1", () => {
    expect(DEFAULT_METHOD).toMatchObject({
      US_DOMESTIC_SHIPPING: "BY_QUANTITY",
      INTL_SHIPPING: "BY_WEIGHT",
      INSURANCE: "BY_VALUE",
      DOMESTIC_SHIPPING: "BY_QUANTITY",
    });
    expect(KINDS_BY_LEG.US_TO_VN[0]).toBe("INTL_SHIPPING");
  });
});

describe("chia tay từng máy", () => {
  it("đọc nhiều kiểu viết", () => {
    expect(parseManualShares("f2lxq7y9kd: 250.000\n350000000000006 = 434000 đ\n\nSERIALX\t-1.000")).toEqual({
      shares: [
        { code: "F2LXQ7Y9KD", amountVnd: 250_000n },
        { code: "350000000000006", amountVnd: 434_000n },
        { code: "SERIALX", amountVnd: -1_000n },
      ],
      errors: [],
    });
  });
  it("báo lỗi theo dòng, trùng máy", () => {
    expect(parseManualShares("abc\nX1: 10\nx1: 20\nY: 1,5").errors).toEqual([
      'Dòng 1 "abc": cần dạng "Serial hoặc IMEI: số tiền"',
      "Dòng 3: máy X1 bị nhập 2 lần",
      'Dòng 4 "Y: 1,5": cần dạng "Serial hoặc IMEI: số tiền"',
    ]);
  });
});
