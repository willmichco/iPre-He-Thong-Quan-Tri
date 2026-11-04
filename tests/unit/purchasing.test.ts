import { describe, expect, it } from "vitest";
import {
  batchSchema,
  emptyRow,
  isBlankRow,
  matchVariant,
  nextBatchCode,
  parseCondition,
  parseFxRate,
  parsePastedGrid,
  purchaseOrderSchema,
  returnDeadlineFrom,
  sumPrices,
  validate,
  validateGrid,
  type GridRow,
  type VariantRef,
} from "@/domain/purchasing";

const V: VariantRef[] = [
  { id: "pm", label: "iPhone Pro Max · 256GB · Silver", sku: "IPPM-256-SLV", codes: ["MDEM1LL/A"], defaultWeightKg: "0.600" },
  { id: "air", label: "iPad Air 11 · 128GB · Blue", sku: "IPADAIR11-128-BLU", codes: ["MDEM2LL/A"], defaultWeightKg: "0.900" },
  { id: "app", label: "AirPods Pro · White", sku: "APP-STD", codes: ["MDEM3AM/A"], defaultWeightKg: null },
  { id: "pro", label: "iPhone Pro · 256GB · Silver", sku: "IPP-256-SLV", codes: [], defaultWeightKg: null },
];
const IMEI_A = "356938035643809";
const IMEI_B = "490154203237518";
const row = (o: Partial<GridRow>): GridRow => ({ ...emptyRow(), ...o });

describe("mã chuyến, tỷ giá, hạn đổi trả", () => {
  it("mã chuyến tuần tự theo năm", () => {
    expect(nextBatchCode(2026, ["CH-2026-011", "CH-2026-002", "CH-2025-099", "KHAC"])).toBe("CH-2026-012");
    expect(nextBatchCode(2027, [])).toBe("CH-2027-001");
    expect(nextBatchCode(2026, ["CH-2026-999"])).toBe("CH-2026-1000");
  });
  it.each([
    ["26.350", "26350.0000"],
    ["26,350", "26350.0000"],
    ["26350", "26350.0000"],
    ["26.350,5", "26350.5000"],
    ["26350.25", "26350.2500"],
    ["1", "1.0000"],
    ["abc", null],
  ])("tỷ giá %s → %s", (raw, out) => {
    expect(parseFxRate(raw)).toBe(out);
  });
  it("hạn đổi trả = ngày đặt + số ngày của nơi mua (qua tháng/năm)", () => {
    expect(returnDeadlineFrom("2026-11-01", 14)).toBe("2026-11-15");
    expect(returnDeadlineFrom("2026-12-25", 14)).toBe("2027-01-08");
    expect(returnDeadlineFrom("2026-12-25", null)).toBeNull();
  });
});

describe("form chuyến & đơn mua", () => {
  it("chuyến: ô thiếu coi như trống, mã in hoa", () => {
    expect(validate(batchSchema, { code: "ch-2026-012" })).toEqual({ ok: true, data: { code: "CH-2026-012", name: null, plannedFxRate: null, note: null } });
    expect(validate(batchSchema, { code: "CH 1", plannedFxRate: "0" })).toEqual({
      ok: false,
      errors: { code: expect.stringContaining("chỉ gồm chữ, số"), plannedFxRate: "Tỷ giá dự kiến không hợp lệ" },
    });
  });
  it("đơn mua: bắt buộc nơi mua, ngày, subtotal, tỷ giá; số kiểu Việt Nam / Mỹ", () => {
    expect(validate(purchaseOrderSchema, {})).toEqual({
      ok: false,
      errors: { supplierId: "Chọn nơi mua", orderedAt: "Nhập ngày đặt", subtotal: "Nhập Subtotal", fxRate: "Nhập Tỷ giá thực tế" },
    });
    const ok = validate(purchaseOrderSchema, {
      supplierId: "30000000-0000-0000-0000-000000000001",
      orderedAt: "2026-11-01",
      subtotal: "$2,047.00",
      salesTax: "1.234,50",
      fxRate: "26.400",
      fxFeeVnd: "15.000",
      paymentAccountId: "",
      paidAt: "2026-11-02",
    });
    expect(ok).toMatchObject({
      ok: true,
      data: { subtotal: "2047.00", salesTax: "1234.50", fxRate: "26400.0000", fxFeeVnd: "15000", paymentAccountId: null, paidAt: "2026-11-02" },
    });
    expect(
      validate(purchaseOrderSchema, { supplierId: "x", orderedAt: "01/11/2026", subtotal: "-5", fxRate: "0", paymentAccountId: "abc", paidAt: "hôm qua" }),
    ).toEqual({
      ok: false,
      errors: {
        supplierId: "Chọn nơi mua",
        orderedAt: "Nhập ngày đặt",
        subtotal: "Subtotal không hợp lệ",
        fxRate: "Tỷ giá thực tế không hợp lệ",
        paymentAccountId: "Lựa chọn không hợp lệ",
        paidAt: "Ngày thanh toán không hợp lệ",
      },
    });
  });
});

describe("gõ tắt cấu hình", () => {
  it.each([
    ["pm 256 sil", "pm"],
    ["ipm", "pm"],
    ["iphone pro max", "pm"],
    ["iphone pro 256", "pro"], // ít từ thừa hơn → sát ý hơn
    ["air 128", "air"],
    ["airpods", "app"],
    ["mdem1ll/a", "pm"],
    ["IPPM-256-SLV", "pm"],
    ["iPad Air 11 · 128GB · Blue", "air"],
    ["xanh lá", null],
    ["pro", null], // mơ hồ
    ["256", null], // mơ hồ
    ["", null],
  ])("%s → %s", (q, id) => {
    expect(matchVariant(q, V)?.id ?? null).toBe(id);
  });
});

describe("đọc bảng dán từ Excel / văn bản", () => {
  it("có dòng tiêu đề → xếp theo cột (tiếng Việt / Anh, có dấu hay không)", () => {
    const r = parsePastedGrid(
      `STT\tCấu hình\tĐơn giá\tSố serial\tIMEI 1\tIMEI 2\tPart No.\tTình trạng\tCân nặng\tGhi chú\n1\tpm 256 sil\t$1,199.00\tf2lxq7y9kd\t${IMEI_A}\t${IMEI_B}\tMDEM1LL/A\tMở hộp\t0,62\tthiếu sạc\n2\tkhông rõ\t599`,
      V,
    );
    expect(r.usedHeader).toBe(true);
    expect(r.rows[0]).toEqual({
      variantId: "pm",
      unitPrice: "$1,199.00",
      serial: "f2lxq7y9kd",
      imei1: IMEI_A,
      imei2: IMEI_B,
      partNumber: "MDEM1LL/A",
      modelNumber: "",
      condition: "OPEN_BOX",
      weightKg: "0,62",
      note: "thiếu sạc",
    });
    expect(r.rows[1]).toMatchObject({ variantId: "", unitPrice: "599" });
    expect(r.unplaced).toEqual([
      { row: 0, text: "1" },
      { row: 1, text: "2" },
      { row: 1, text: "không rõ" },
    ]);
  });
  it("không tiêu đề → tự nhận từng ô: IMEI, Serial, Part No. (tự điền cấu hình), giá, tình trạng", () => {
    const r = parsePastedGrid(`F2LXQ7Y9KD ${IMEI_A} 1PMDEM2LL/A 599\npm 256 sil 1199,00 new\nairpods 249 used\n\n${IMEI_B}`, V);
    expect(r.usedHeader).toBe(false);
    expect(r.rows.map((x) => [x.variantId, x.unitPrice, x.serial, x.imei1, x.partNumber, x.condition])).toEqual([
      ["air", "599", "F2LXQ7Y9KD", IMEI_A, "MDEM2LL/A", "NEW_SEALED"],
      ["pm", "1199,00", "", "", "", "NEW_SEALED"],
      ["app", "249", "", "", "", "USED"],
      ["", "", "", IMEI_B, "", "NEW_SEALED"],
    ]);
    expect(r.unplaced).toEqual([]);
  });
  it("chỉ có số dung lượng → không lấy nhầm làm giá", () => {
    expect(parsePastedGrid("256 pm silver 1099", V).rows[0]).toMatchObject({ variantId: "pm", unitPrice: "1099" });
    expect(parsePastedGrid("pm 256 sil", V).rows[0]).toMatchObject({ variantId: "pm", unitPrice: "256" });
  });
  it("chuỗi trống / chỉ xuống dòng", () => {
    expect(parsePastedGrid("\n \n", V)).toEqual({ rows: [], usedHeader: false, unplaced: [] });
  });
  it("tình trạng", () => {
    expect(parseCondition("Mới nguyên seal")).toBe("NEW_SEALED");
    expect(parseCondition("LIKE_NEW")).toBe("LIKE_NEW");
    expect(parseCondition("CPO")).toBe("REFURBISHED");
    expect(parseCondition("??")).toBeNull();
  });
});

describe("kiểm tra lưới nhập máy", () => {
  it("dòng hợp lệ → chuẩn hoá; dòng trống bỏ qua", () => {
    const { items, issues } = validateGrid(
      [
        row({ variantId: "pm", unitPrice: "$1,199.00", serial: " f2lxq7y9kd ", imei1: IMEI_A, partNumber: "1PMDEM1LL/A", weightKg: "0,62", note: " x " }),
        emptyRow(),
      ],
      V,
    );
    expect(issues).toEqual([]);
    expect(items).toEqual([
      {
        row: 0,
        id: undefined,
        variantId: "pm",
        unitPrice: "1199.00",
        serial: "F2LXQ7Y9KD",
        imei1: IMEI_A,
        imei2: null,
        partNumber: "MDEM1LL/A",
        modelNumber: null,
        condition: "NEW_SEALED",
        weightKg: "0.620",
        note: "x",
      },
    ]);
  });
  it("lỗi đỏ chặn lưu, cảnh báo vàng vẫn lưu", () => {
    const { items, issues } = validateGrid(
      [
        row({ note: "chỉ có ghi chú" }),
        row({ variantId: "pm", unitPrice: "-1", imei1: "123", imei2: "123" }),
        row({ variantId: "app", unitPrice: "249", serial: "ABC", partNumber: "MDEM3AM/A", condition: "??" }),
        row({ variantId: "pm", unitPrice: "1", partNumber: "MDEM2LL/A", weightKg: "0" }),
        row({ variantId: "pro", unitPrice: "1", imei1: IMEI_A }),
        row({ variantId: "pro", unitPrice: "1", imei2: IMEI_A, partNumber: "XYZ" }),
      ],
      V,
    );
    expect(issues.map((i) => [i.row, i.field, i.severity, i.message])).toEqual([
      [0, "variantId", "error", "Chọn cấu hình máy"],
      [0, "unitPrice", "error", "Nhập đơn giá"],
      [1, "unitPrice", "error", "Đơn giá không hợp lệ"],
      [1, "imei1", "error", "IMEI sai (phải đủ 15 số, đúng số kiểm tra)"],
      [1, "imei2", "error", "IMEI sai (phải đủ 15 số, đúng số kiểm tra)"],
      [1, "imei2", "error", "IMEI 2 trùng IMEI 1"],
      [1, "imei2", "error", "Trùng với dòng 2"],
      [2, "serial", "warn", "Serial Apple thường có 10 hoặc 12 ký tự — soát lại"],
      [2, "partNumber", "warn", "Thị trường AM/A, không phải LL/A"],
      [2, "condition", "error", "Tình trạng không hợp lệ"],
      [2, "weightKg", "warn", "Chưa có cân nặng (cấu hình cũng chưa có) — cần khi chia cước theo kg"],
      [3, "partNumber", "warn", "Part No. này thuộc cấu hình iPad Air 11 · 128GB · Blue"],
      [3, "weightKg", "error", "Cân nặng không hợp lệ"],
      [4, "weightKg", "warn", "Chưa có cân nặng (cấu hình cũng chưa có) — cần khi chia cước theo kg"],
      [5, "partNumber", "warn", "Không giống Part No. của Apple (vd: MDEM1LL/A)"],
      [5, "imei2", "error", "Trùng với dòng 5"],
      [5, "weightKg", "warn", "Chưa có cân nặng (cấu hình cũng chưa có) — cần khi chia cước theo kg"],
    ]);
    expect(items.map((i) => i.row)).toEqual([4]);
    expect(validateGrid([row({ variantId: "app", unitPrice: "1", partNumber: "MDEM3AM/A", weightKg: "0,3" })], V, null).issues).toEqual([]);
  });
  it("dòng trống, tổng đơn giá", () => {
    expect(isBlankRow(emptyRow())).toBe(true);
    expect(isBlankRow({ ...emptyRow(), id: "x" })).toBe(false);
    expect(isBlankRow(row({ condition: "USED" }))).toBe(true);
    expect(sumPrices([row({ unitPrice: "$1,199.00" }), row({ unitPrice: "599" }), row({ unitPrice: "abc" }), row({ unitPrice: "-5" })])).toBe("1798.00");
    expect(sumPrices([])).toBe("0.00");
  });
});
