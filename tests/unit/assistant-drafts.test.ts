import { describe, expect, it } from "vitest";
import { bangKeFromDraft, draftFromSlots, guessCategory, guessCostKind, mergeSlots } from "@/domain/assistant/drafts";
import { extractSlots } from "@/domain/assistant/extract";
import { parseMessage } from "@/domain/assistant/parse";
import { replyAsText } from "@/domain/assistant/reply";
import type { VariantRef } from "@/domain/purchasing-core";
import { saleSchema } from "@/domain/sales";
import { validate } from "@/domain/catalog";
import { buildXlsx, excelDate } from "@/server/reports/xlsx";
import { inflateRawSync } from "node:zlib";

const IMEI = "356789012345672";
const V = (id: string, label: string, sku: string): VariantRef => ({ id, label, sku, codes: [], defaultWeightKg: null });
const ctx = { today: "2026-11-08", variants: [V("v-ppm256", "iPhone Pro Max · 256GB · Silver", "IPPM-256-SLV"), V("v-app", "AirPods Pro · White", "APP-STD")] };
const draftOf = (t: string) => {
  const p = parseMessage(t, ctx);
  if (p.intent === "UNKNOWN" || !["SALE", "DEPOSIT", "LEDGER_ENTRY", "PURCHASE_ITEMS", "LANDED_COST", "PAYMENT"].includes(p.intent)) throw new Error(p.intent);
  return draftFromSlots(p.intent as never, p.slots, t);
};

describe("bản nháp từ câu nhắn", () => {
  it("bán: máy, giá, khách, kênh, thanh toán, bảo hành, ngày", () => {
    const d = draftOf(`bán ${IMEI} cho chị Lan 0901234567 25tr5 zalo ck bh 12 hôm qua giảm 500k`);
    expect(d).toMatchObject({
      kind: "SALE",
      lines: [{ code: IMEI, codeKind: "IMEI", price: "25500000" }],
      customerName: "Chị Lan",
      phone: "0901234567",
      channel: "ZALO",
      payment: "TRANSFER",
      warrantyMonths: 12,
      date: "2026-11-07",
      discount: "500000",
    });
  });
  it("bán theo dòng máy (chưa có IMEI) + số lượng: mỗi dòng một máy cùng giá", () => {
    const d = draftOf("bán 2 máy pro max 256 mỗi máy 25tr");
    expect(d.variantIds).toEqual(["v-ppm256"]);
    expect(d.lines).toEqual([{ price: "25000000" }, { price: "25000000" }]);
  });
  it("nhiều dòng: giá theo từng dòng", () => {
    const d = draftOf(`bán\n${IMEI} 25tr\n353910112233443 26tr`);
    expect(d.lines?.map((l) => [l.code, l.price])).toEqual([
      [IMEI, "25000000"],
      ["353910112233443", "26000000"],
    ]);
  });
  it("cọc: tiền cọc tách khỏi giá", () => {
    const d = draftOf(`chị Lan cọc 5tr máy ${IMEI} giá 25tr`);
    expect(d).toMatchObject({ kind: "DEPOSIT", deposit: "5000000", payment: "DEPOSIT", lines: [{ price: "25000000" }] });
  });
  it("thu chi: danh mục theo từ khoá", () => {
    expect(draftOf("chi quảng cáo fb 2tr")).toMatchObject({ kind: "LEDGER_ENTRY", categoryCode: "OPEX_ADS", amount: "2000000" });
    expect(guessCategory("góp vốn 100tr")).toBe("CAPITAL_IN");
    expect(guessCategory("nộp thuế quý 3")).toBe("TAX");
    expect(guessCategory("tiền mặt bằng tháng 11")).toBe("OPEX_RENT");
    expect(guessCategory("chi mua văn phòng phẩm")).toBe("OPEX_OTHER");
    expect(guessCostKind("phí thông quan")).toBe("CUSTOMS_TAX");
    expect(guessCostKind("cước chành HN SG")).toBe("DOMESTIC_SHIPPING");
  });
  it("form bán dựng từ bản nháp qua được lược đồ của form tay", () => {
    const r = validate(saleSchema, {
      lines: [{ itemId: "80000000-0000-0000-0000-000000000003", price: "25tr5" }],
      customerName: "Chị Lan",
      customerPhone: "0901234567",
      customerId: "",
      channel: "ZALO",
      payment: "TRANSFER",
      accountId: "50000000-0000-0000-0000-000000000002",
      warrantyMonths: "12",
      confirmBelowCost: "true",
    });
    expect(r.ok).toBe(true);
  });
});

describe("sửa phiếu", () => {
  const base = draftOf(`bán ${IMEI} cho chị Lan 25tr ck`);
  const edit = (t: string) => mergeSlots(base, extractSlots(t, ctx), t);
  it("giá", () => expect(edit("giá 26tr").lines?.[0].price).toBe("26000000"));
  it("khách mới thay khách cũ", () => expect(edit("khách chị Hoa 0912345678")).toMatchObject({ customerName: "Chị Hoa", phone: "0912345678" }));
  it("ngày, thanh toán, bảo hành", () => expect(edit("hôm qua tiền mặt bh 3")).toMatchObject({ date: "2026-11-07", payment: "CASH", warrantyMonths: 3 }));
  it('"cọc 5tr" biến phiếu bán thành phiếu cọc', () => expect(edit("cọc 5tr")).toMatchObject({ kind: "DEPOSIT", deposit: "5000000" }));
  it("không sửa ô không nhắc tới", () => expect(edit("giá 26tr").customerName).toBe("Chị Lan"));
});

describe("bảng kê nháp", () => {
  it("dòng bán", () => {
    expect(bangKeFromDraft(draftOf(`bán ${IMEI} cho anh Nam 20tr hôm qua zalo`))).toMatchObject({
      kind: "SALE",
      code: IMEI,
      priceText: "20000000",
      customerText: "Anh Nam",
      occurredOn: "2026-11-07",
      channel: "ZALO",
    });
  });
  it("thu / chi theo danh mục", () => {
    expect(bangKeFromDraft(draftOf("góp vốn 100tr")).kind).toBe("INCOME");
    expect(bangKeFromDraft(draftOf("chi quảng cáo 2tr")).kind).toBe("EXPENSE");
  });
});

describe("trả lời dạng chữ (kênh không vẽ thẻ)", () => {
  it("phiếu + nút đánh số", () => {
    const t = replyAsText({
      text: "Kiểm tra rồi xác nhận",
      cards: [{ kind: "preview", actionId: "a", title: "Phiếu bán", rows: [["Giá bán", "25.000.000 đ"]], warnings: ["w"], blockers: [], status: "PENDING" }],
      chips: [{ label: "Huỷ" }],
    });
    expect(t).toContain("Giá bán: 25.000.000 đ");
    expect(t).toContain('Gõ "ok" để ghi');
    expect(t).toContain("1. Huỷ");
  });
});

describe("Excel: cột ngày", () => {
  it("ngày → số ngày kiểu Excel", () => {
    expect(excelDate("1900-03-01")).toBe(61);
    expect(excelDate("2026-11-08")).toBe(46334);
    expect(excelDate("2026-02-30")).toBeNull();
    expect(excelDate("abc")).toBeNull();
  });
  it("ô ngày dùng kiểu dd/mm/yyyy; chuỗi không phải ngày ghi thành chữ", () => {
    const zip = buildXlsx([{ name: "T", columns: [{ header: "Ngày", type: "date" }], rows: [["2026-11-08"], ["chưa rõ"]] }]);
    // đọc tệp sheet1.xml trong ZIP
    const files = new Map<string, string>();
    let o = 0;
    while (zip.readUInt32LE(o) === 0x04034b50) {
      const method = zip.readUInt16LE(o + 8);
      const size = zip.readUInt32LE(o + 18);
      const nameLen = zip.readUInt16LE(o + 26);
      const extra = zip.readUInt16LE(o + 28);
      const name = zip.subarray(o + 30, o + 30 + nameLen).toString();
      const data = zip.subarray(o + 30 + nameLen + extra, o + 30 + nameLen + extra + size);
      files.set(name, (method === 8 ? inflateRawSync(data) : data).toString());
      o += 30 + nameLen + extra + size;
    }
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain('<c r="A2" s="8"><v>46334</v></c>');
    expect(sheet).toContain("chưa rõ");
    expect(files.get("xl/styles.xml")).toContain('formatCode="dd/mm/yyyy"');
  });
});
