import { describe, expect, it } from "vitest";
import { demoKey, demoPeriodOf, demoSubject, type DemoPack } from "@/domain/assistant/demo";
import { extractSlots } from "@/domain/assistant/extract";
import type { PreviewCard, Reply } from "@/domain/assistant/reply";
import { DemoEngine } from "@/features/assistant-demo/engine";

const TODAY = "2026-11-08";
const item = (id: string, serial: string, imei: string | null, variantId: string, over: Partial<DemoPack["items"][number]> = {}): DemoPack["items"][number] => ({
  id,
  serial,
  imei,
  label: variantId === "v16" ? "iPhone 16 Pro · 256GB · Desert" : "AirPods Pro · White",
  variantId,
  status: "IN_STOCK",
  costVnd: "26800000",
  hasEstimate: false,
  targetVnd: null,
  sg: "2026-10-27",
  ordered: "2026-10-10",
  sellable: "NOW",
  reason: null,
  batchCode: "CH-2026-012",
  ...over,
});
const PACK: DemoPack = {
  today: TODAY,
  variants: [
    { id: "v16", label: "iPhone 16 Pro · 256GB · Desert", sku: "IP16P-256-DES", codes: [], defaultWeightKg: null },
    { id: "vapp", label: "AirPods Pro · White", sku: "APP-STD", codes: [], defaultWeightKg: null },
  ],
  accountNames: ["Ngân hàng chính", "Tiền mặt"],
  items: [
    item("i1", "FJ6D00000002", "352081000000000", "v16"),
    item("i2", "FJ6D00000003", null, "v16", { sg: "2026-10-20" }),
    item("i3", "FJ6D00000013", null, "v16", { sg: null, status: "INTL_IN_TRANSIT", sellable: "DEPOSIT_ONLY", reason: "Máy chưa về SG" }),
  ],
  stock: [{ variantId: "v16", label: "iPhone 16 Pro · 256GB · Desert", inStock: 2, reserved: 0, incoming: 1, costVnd: "53600000", oldestDays: 19 }],
  customers: [{ id: "c1", name: "Chị Lan", phone: "0901234567" }],
  accounts: [
    { id: "a1", name: "Ngân hàng chính", kind: "BANK", currency: "VND" },
    { id: "a2", name: "Tiền mặt", kind: "CASH", currency: "VND" },
  ],
  categories: [
    { code: "OPEX_ADS", name: "Quảng cáo", direction: "OUT" },
    { code: "CAPITAL_IN", name: "Góp vốn / bổ sung vốn", direction: "IN" },
  ],
  sales: [{ id: "s1", code: "BH-2026-0004", status: "COMPLETED", customerId: "c1", customer: "Chị Lan", items: "iPhone 16 Pro 512GB", revenueVnd: "32500000", balanceVnd: "12500000" }],
  batches: [{ code: "CH-2026-012", href: "chuyen-hang__b1.html" }],
  purchaseOrders: [],
  shipments: [],
  answers: {
    [demoKey("STOCK")]: { text: "Tồn kho SG: 2 máy sẵn bán" },
    [demoKey("REVENUE", "", "thang")]: { text: "Tháng 11/2026: doanh thu …" },
    [demoKey("REVENUE", "", "")]: { text: "Doanh thu mặc định" },
    [demoKey("ITEM_LOOKUP", "item:i1")]: { text: "iPhone 16 Pro · FJ6D00000002" },
    [demoKey("DEBT", "cust:c1")]: { text: "Chị Lan còn nợ 12,5 tr" },
  },
};
const card = (rs: Reply[]) => rs.flatMap((r) => r.cards ?? []).find((c): c is PreviewCard => c.kind === "preview");
const row = (c: PreviewCard | undefined, k: string) => c?.rows.find(([x]) => x === k)?.[1];

describe("khoá câu trả lời dựng sẵn", () => {
  const ctx = { today: TODAY, variants: PACK.variants };
  it("kỳ: preset, khoảng ngày trùng preset, khoảng tuỳ chọn → gần nhất", () => {
    expect(demoPeriodOf(extractSlots("doanh thu tháng này", ctx), TODAY)).toEqual({ period: "thang", exact: true });
    expect(demoPeriodOf(extractSlots("doanh thu tháng 10", ctx), TODAY)).toEqual({ period: "thang-truoc", exact: true });
    expect(demoPeriodOf(extractSlots("doanh thu hôm qua", ctx), TODAY)).toEqual({ period: "thang", exact: false });
    expect(demoPeriodOf(extractSlots("doanh thu", ctx), TODAY)).toEqual({ period: "", exact: true });
  });
  it("đối tượng phụ", () => {
    expect(demoSubject("OPEX", extractSlots("chi quảng cáo tháng này", ctx))).toBe("ads");
    expect(demoSubject("SHIPMENTS", extractSlots("kiện nào trễ", ctx))).toBe("late");
  });
});

describe("chat demo", () => {
  it("hỏi: trả câu dựng sẵn theo kỳ / máy / khách", () => {
    const e = new DemoEngine(PACK);
    expect(e.send("tồn kho")[0].text).toContain("2 máy sẵn bán");
    expect(e.send("doanh thu tháng này")[0].text).toContain("Tháng 11/2026");
    expect(e.send("tra đuôi 00000002")[0].text).toContain("FJ6D00000002");
    expect(e.send("chị Lan còn nợ bao nhiêu")[0].text).toContain("12,5 tr");
    expect(e.send("16 pro còn mấy con")[0].text).toContain("còn 2 máy");
  });
  it("bán theo dòng máy: máy về SG lâu nhất trước, lãi, sửa giá, xác nhận chỉ báo bản xem thử", () => {
    const e = new DemoEngine(PACK);
    const c1 = card(e.send("bán 16 pro 256 cho chị Lan 28tr9 ck"));
    expect(row(c1, "Máy")).toContain("FJ6D00000003");
    expect(row(c1, "Khách")).toBe("Chị Lan · 0901234567");
    expect(c1?.profit?.value).toBe("2.100.000 đ");
    expect(c1?.blockers).toEqual([]);
    const c2 = card(e.send("sửa giá 29tr5"));
    expect(row(c2, "Giá bán")).toBe("29.500.000 đ");
    expect(e.send("ok")[0].text).toContain("bản xem thử");
    expect(e.status(c1!.actionId)).toBe("PENDING");
  });
  it("máy chưa về SG: chặn bán, đổi thành cọc thì hỏi tiền cọc", () => {
    const e = new DemoEngine(PACK);
    const c = card(e.send("bán serial FJ6D00000013 30tr"));
    expect(c?.blockers.join(" ")).toContain("chưa về SG");
    const r = e.send("sửa cọc");
    expect(r[0].text).toContain("Khách cọc");
  });
  it("máy chưa có → bảng kê nháp; thiếu giá → hỏi; chi quảng cáo → phiếu thu chi", () => {
    const e = new DemoEngine(PACK);
    expect(e.send("bán 356789012345672 20tr")[0].text).toContain("Bảng kê nháp");
    expect(e.send("bán serial FJ6D00000002 cho khách lẻ")[0].text).toContain("Giá bán");
    const c = card(e.send("26tr"));
    expect(row(c, "Giá bán")).toBe("26.000.000 đ");
    e.send("huỷ");
    const l = card(e.send("chi quảng cáo fb 2tr tiền mặt"));
    expect(row(l, "Danh mục")).toBe("Chi · Quảng cáo");
    expect(row(l, "Từ tài khoản")).toBe("Tiền mặt");
  });
  it("thu nợ theo tên khách", () => {
    const e = new DemoEngine(PACK);
    const c = card(e.send("chị Lan trả thêm 5tr ck"));
    expect(row(c, "Đơn")).toContain("BH-2026-0004");
    expect(row(c, "Thu thêm")).toBe("5.000.000 đ");
  });
});
