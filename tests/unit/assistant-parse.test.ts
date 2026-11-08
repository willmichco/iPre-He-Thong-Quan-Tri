import { describe, expect, it } from "vitest";
import { dateAt, parseDayMonth } from "@/domain/assistant/dates";
import { metaOf } from "@/domain/assistant/dialog";
import { extractSlots, mergeDigitGroups } from "@/domain/assistant/extract";
import { moneyAt, shortVnd, usdAt } from "@/domain/assistant/money";
import { fold, isQuestion, tokenize } from "@/domain/assistant/normalize";
import { parseMessage } from "@/domain/assistant/parse";
import type { VariantRef } from "@/domain/purchasing-core";
import { parseVndInput } from "@/domain/sales-core";

const TODAY = "2026-11-08"; // Chủ nhật
const IMEI = "356789012345672";
const IMEI2 = "353910112233443";
const V = (id: string, label: string, sku: string): VariantRef => ({ id, label, sku, codes: [], defaultWeightKg: null });
const VARIANTS = [
  V("v-ppm256", "iPhone Pro Max · 256GB · Silver", "IPPM-256-SLV"),
  V("v-ppm512", "iPhone Pro Max · 512GB · Natural", "IPPM-512-NAT"),
  V("v-p128", "iPhone Pro · 128GB · Black", "IPP-128-BLK"),
  V("v-air", "iPad Air 11 · 128GB · Blue", "IPADAIR11-128-BLU"),
  V("v-app", "AirPods Pro · White", "APP-STD"),
];
const ctx = { today: TODAY, variants: VARIANTS, accountNames: ["Ngân hàng chính", "Thẻ Visa (VND)", "Tiền mặt"] };
const slots = (t: string) => extractSlots(t, ctx);
const money = (t: string) => {
  const toks = tokenize(t);
  const m = moneyAt(toks, 0);
  return m ? [m.vnd, m.len, m.alt] : null;
};

describe("chuẩn hoá", () => {
  it("bỏ dấu, đ → d", () => {
    expect(fold("Chị Lan Đặt Cọc")).toBe("chi lan dat coc");
  });
  it("tách từ giữ số có dấu phân cách, bỏ dấu câu cuối", () => {
    expect(tokenize("bán 25,5tr, hôm qua. BH-2026-0012").map((t) => t.raw)).toEqual(["bán", "25,5tr", "hôm", "qua", "BH-2026-0012"]);
  });
  it.each([
    ["còn bao nhiêu máy?", true],
    ["ai còn nợ", true],
    ["bán 3567 25tr", false],
    ["bán chưa trả tiền", false],
    ["không bảo hành", false],
    ["xem tồn kho", true],
  ])("câu hỏi: %s → %s", (t, q) => expect(isQuestion(t)).toBe(q));
});

describe("ô tiền gõ tắt (form)", () => {
  it.each([
    ["25tr5", 25_500_000n],
    ["25tr55", 25_550_000n],
    ["25tr500", 25_500_000n],
    ["1ty2", 1_200_000_000n],
    ["25k5", 25_500n],
  ])("%s → %s", (raw, v) => expect(parseVndInput(raw)).toBe(v));
  it("phần lẻ dài quá đơn vị → null", () => expect(parseVndInput("25k5555")).toBeNull());
});

describe("tiền trong câu", () => {
  it.each([
    ["25tr", [25_000_000n, 1, undefined]],
    ["25tr5", [25_500_000n, 1, undefined]],
    ["25,5 củ", [25_500_000n, 2, undefined]],
    ["25 triệu", [25_000_000n, 2, undefined]],
    ["25 triệu 500", [25_500_000n, 3, undefined]],
    ["25 triệu 5", [25_500_000n, 3, undefined]],
    ["25 triệu rưỡi", [25_500_000n, 3, undefined]],
    ["25 triệu 500 nghìn", [25_500_000n, 4, undefined]],
    ["25tr 500k", [25_500_000n, 2, undefined]],
    ["1 tỷ 2", [1_200_000_000n, 3, undefined]],
    ["25.500.000đ", [25_500_000n, 1, undefined]],
    ["25500000", [25_500_000n, 1, undefined]],
    ["500k", [500_000n, 1, undefined]],
    ["500000 đồng", [500_000n, 2, undefined]],
  ])("%s", (t, want) => expect(money(t)).toEqual(want));
  it("2 chữ số sau đơn vị → kèm cách hiểu khác", () => expect(money("25 triệu 50")).toEqual([25_500_000n, 3, 25_050_000n]));
  it.each(["256", "15", "0901234567", "abc"])("không phải tiền: %s", (t) => expect(money(t)).toBeNull());
  it.each([
    ["$899", "899.00"],
    ["899$", "899.00"],
    ["899 usd", "899.00"],
    ["899 đô", "899.00"],
    ["$1,199.99", "1199.99"],
  ])("USD %s", (t, v) => expect(usdAt(tokenize(t), 0)?.usd).toBe(v));
  it("rút gọn", () => {
    expect(shortVnd(25_500_000n)).toBe("25,5 tr");
    expect(shortVnd(1_200_000_000n)).toBe("1,2 tỷ");
    expect(shortVnd(500_000n)).toBe("500k");
  });
});

describe("ngày và kỳ (hôm nay 08/11/2026, Chủ nhật)", () => {
  const d = (t: string) => {
    const h = dateAt(tokenize(t), 0, TODAY);
    return h ? (h.kind === "day" ? h.date : `${h.ky ?? ""}|${h.tu ?? ""}|${h.den ?? ""}`) : null;
  };
  it.each([
    ["hôm nay", "2026-11-08"],
    ["hôm qua", "2026-11-07"],
    ["hôm kia", "2026-11-06"],
    ["thứ 2", "2026-11-02"],
    ["thứ hai tuần trước", "2026-10-26"],
    ["t6", "2026-11-06"],
    ["chủ nhật", "2026-11-08"],
    ["5/11", "2026-11-05"],
    ["05-11-2026", "2026-11-05"],
    ["28/12", "2025-12-28"],
    ["ngày 3", "2026-11-03"],
    ["ngày 20", "2026-10-20"],
    ["3 ngày trước", "2026-11-05"],
    ["2026-11-01", "2026-11-01"],
  ])("%s → %s", (t, want) => expect(d(t)).toBe(want));
  it.each([
    ["tháng này", "thang||"],
    ["tháng trước", "thang-truoc||"],
    ["tháng 10", "|2026-10-01|2026-10-31"],
    ["tháng 12", "|2025-12-01|2025-12-31"],
    ["tháng 2/2024", "|2024-02-01|2024-02-29"],
    ["quý 3", "|2026-07-01|2026-09-30"],
    ["quý trước", "quy-truoc||"],
    ["q2", "|2026-04-01|2026-06-30"],
    ["năm nay", "nam||"],
    ["năm ngoái", "nam-truoc||"],
    ["năm 2025", "|2025-01-01|2025-12-31"],
    ["tuần này", "|2026-11-02|2026-11-08"],
    ["tuần trước", "|2026-10-26|2026-11-01"],
    ["7 ngày qua", "|2026-11-02|2026-11-08"],
    ["từ 1/10 đến 15/10", "|2026-10-01|2026-10-15"],
    ["từ 1/10 tới nay", "|2026-10-01|2026-11-08"],
  ])("%s → %s", (t, want) => expect(d(t)).toBe(want));
  it("31/02 không phải ngày", () => expect(parseDayMonth("31/02", TODAY)).toBeNull());
});

describe("gộp dãy số", () => {
  it("IMEI gõ cách", () => expect(mergeDigitGroups("imei 35 6789 0123 45672 nhé")).toBe(`imei ${IMEI} nhé`));
  it("SĐT gõ cách / chấm", () => expect(mergeDigitGroups("sđt 0901.234.567")).toBe("sđt 0901234567"));
  it("số tiền giữ nguyên", () => expect(mergeDigitGroups("giá 25.500.000")).toBe("giá 25.500.000"));
  it("+84", () => expect(mergeDigitGroups("+84 901 234 567")).toBe("0901234567"));
});

describe("trích ô thông tin", () => {
  it("câu bán đầy đủ", () => {
    const s = slots(`bán 15 Pro Max 256 IMEI ${IMEI} cho chị Lan 0901 234 567 25tr5 hôm qua zalo ck bh 12 tháng`);
    expect(s.codes).toEqual([{ kind: "IMEI", value: IMEI, line: 0 }]);
    expect(s.customerName).toBe("Chị Lan");
    expect(s.phone).toBe("0901234567");
    expect(s.money.map((m) => [m.vnd, m.role])).toEqual([["25500000", "price"]]);
    expect(s.date).toBe("2026-11-07");
    expect(s.channel).toBe("ZALO");
    expect(s.payment).toBe("TRANSFER");
    expect(s.warrantyMonths).toBe(12);
    expect(s.variantIds).toEqual(["v-ppm256"]);
  });
  it("danh xưng viết tắt + tên trùng từ thường viết hoa", () => {
    expect(slots("bán cho a Nam 20tr").customerName).toBe("Anh Nam");
    expect(slots("khách Minh lấy máy").customerName).toBe("Minh");
    expect(slots("chị Tuấn Anh cọc 5tr").customerName).toBe("Chị Tuấn Anh");
  });
  it("'chi' không dấu là chi tiền, không phải tên", () => {
    const s = slots("chi quảng cáo fb 2tr hôm qua tiền mặt");
    expect(s.customerName).toBeUndefined();
    expect(s.money[0].vnd).toBe("2000000");
    expect(s.payment).toBe("CASH");
    expect(s.channel).toBe("FACEBOOK");
  });
  it("vai trò của tiền: cọc, giảm, ship", () => {
    const s = slots(`chị Lan cọc 5tr máy ${IMEI} giá 25tr giảm 500k ship 30k`);
    expect(s.money.map((m) => [m.role, m.vnd])).toEqual([
      ["deposit", "5000000"],
      ["price", "25000000"],
      ["discount", "500000"],
      ["ship", "30000"],
    ]);
  });
  it("đuôi IMEI, mã đơn, hoá đơn, giao thẳng, không bảo hành", () => {
    const s = slots("đơn BH-2026-0012 hđ 0001234 máy đuôi 5672 giao thẳng không bảo hành");
    expect(s.saleCode).toBe("BH-2026-0012");
    expect(s.einvoiceNo).toBe("0001234");
    expect(s.codes[0]).toMatchObject({ kind: "PARTIAL", value: "5672" });
    expect(s.directShip).toBe(true);
    expect(s.warrantyMonths).toBe(0);
  });
  it("IMEI sai số kiểm tra", () => expect(slots("tra 356789012345671").codes[0].kind).toBe("IMEI_BAD"));
  it("serial", () => expect(slots("tra F2LXK1ABCD12").codes[0]).toMatchObject({ kind: "SERIAL", value: "F2LXK1ABCD12" }));
  it("chuyển tiền: từ … sang …", () => {
    const s = slots("chuyển 10tr từ tiền mặt sang vcb");
    expect(s.fromAccountHints).toEqual(["tien mat"]);
    expect(s.accountHints).toEqual(["vcb"]);
  });
  it("tên tài khoản gõ đúng", () => expect(slots("thu 5tr tk ngân hàng chính").accountHints).toEqual(["ngan hang chinh"]));
  it("nhiều dòng", () => {
    const s = slots(`bán\n${IMEI} 25tr\n${IMEI2} 26tr`);
    expect(s.lines).toBe(2);
    expect(s.money.map((m) => m.line)).toEqual([1, 2]);
  });
  it("tồn trên 45 ngày + số lượng", () => {
    expect(slots("máy tồn trên 45 ngày").days).toBe(45);
    expect(slots("nhập 3 máy pro 128").qty).toBe(3);
  });
  it("dòng máy viết tắt", () => {
    expect(slots("còn mấy con pm 512").variantIds).toEqual(["v-ppm512"]);
    expect(slots("airpods pro còn không").variantIds).toEqual(["v-app"]);
    // "pro max" khớp 2 cấu hình ngang nhau → trả cả hai
    expect(slots("pro max còn mấy").variantIds.sort()).toEqual(["v-ppm256", "v-ppm512"]);
  });
  it("vận đơn", () => {
    expect(slots("kiện 1Z999AA10123456784 tới đâu").tracking).toBe("1Z999AA10123456784");
  });
});

describe("nhận ý định", () => {
  const intent = (t: string) => parseMessage(t, ctx).intent;
  it.each([
    [`bán ${IMEI} 25tr5 cho chị Lan ck`, "SALE"],
    ["bán 15 pro max 256 cho a Nam 25tr hôm qua", "SALE"],
    ["chốt đơn chị Hoa 0912345678 pro 128 18tr", "SALE"],
    [`chị Lan cọc 5tr máy ${IMEI} giá 25tr`, "DEPOSIT"],
    ["đặt cọc 3tr pro max 512 cho anh Bình", "DEPOSIT"],
    ["chị Lan trả thêm 3tr ck", "PAYMENT"],
    ["thu nợ BH-2026-0012 5tr", "PAYMENT"],
    ["hoàn tất đơn BH-2026-0012", "COMPLETE_DEPOSIT"],
    [`nhập máy pro 128 999$ vào CH-2026-011 imei ${IMEI}`, "PURCHASE_ITEMS"],
    ["chi quảng cáo fb 2tr hôm qua tiền mặt", "LEDGER_ENTRY"],
    ["góp vốn 100tr", "LEDGER_ENTRY"],
    ["nộp thuế 3tr quý 3", "LEDGER_ENTRY"],
    ["tiền mặt bằng tháng 11 5tr", "LEDGER_ENTRY"],
    ["cước kiện 1Z999AA10123456784 3tr5", "LANDED_COST"],
    ["phí thông quan chuyến CH-2026-011 2tr", "LANDED_COST"],
    ["chuyển 10tr từ tiền mặt sang vcb", "TRANSFER"],
    ["thêm khách chị Lan 0901234567", "CUSTOMER"],
    ["hoá đơn BH-2026-0012 số 0001234", "EINVOICE"],
    [`đặt giá máy ${IMEI} 27tr`, "TARGET_PRICE"],
    ["tồn kho", "STOCK"],
    ["còn bao nhiêu máy", "STOCK"],
    ["còn mấy con pro max 256", "STOCK"],
    ["máy tồn lâu", "AGED_STOCK"],
    ["máy tồn trên 45 ngày", "AGED_STOCK"],
    ["máy nào đang về", "STAGE"],
    ["vốn đang nằm ở đâu", "CAPITAL"],
    [IMEI, "ITEM_LOOKUP"],
    [`máy ${IMEI} lãi bao nhiêu`, "ITEM_LOOKUP"],
    [`máy ${IMEI} còn bảo hành không`, "ITEM_LOOKUP"],
    [`máy ${IMEI} nên bán bao nhiêu`, "PRICE_SUGGEST"],
    ["doanh thu tháng này", "REVENUE"],
    ["lãi quý 3", "REVENUE"],
    ["hôm qua lãi bao nhiêu", "REVENUE"],
    ["doanh thu từng tháng năm nay", "MONTHLY"],
    ["chi phí vận hành tháng này", "OPEX"],
    ["chi quảng cáo tháng này bao nhiêu", "OPEX"],
    ["dòng nào lãi nhất", "TOP_MODELS"],
    ["máy nào bán chạy", "TOP_MODELS"],
    ["kênh nào bán nhiều", "BY_CHANNEL"],
    ["chuyến CH-2026-011 lãi bao nhiêu", "BATCH"],
    ["CH-2026-011", "BATCH"],
    ["hôm qua bán gì", "RECENT_SALES"],
    ["đơn bán tuần này", "RECENT_SALES"],
    ["BH-2026-0012", "SALE_LOOKUP"],
    ["ai còn nợ", "DEBT"],
    ["chị Lan còn nợ bao nhiêu", "DEBT"],
    ["mình còn nợ ai", "PAYABLES"],
    ["số dư", "BALANCE"],
    ["tiền mặt còn bao nhiêu", "BALANCE"],
    ["thu chi tuần này", "CASHFLOW"],
    ["kiện đang đi", "SHIPMENTS"],
    ["kiện nào trễ", "SHIPMENTS"],
    ["1Z999AA10123456784", "SHIPMENTS"],
    ["kiện nào thiếu máy", "SHORTAGES"],
    ["có gì cần xử lý", "ALERTS"],
    ["sắp chạm ngưỡng thuế chưa", "TAX"],
    ["đơn nào chưa xuất hoá đơn", "UNINVOICED"],
    ["máy thiếu chứng từ", "DOCS"],
    ["xuất excel tháng này", "EXPORT"],
    ["xuất bảng kê tháng 10", "EXPORT"],
    ["bảng kê nháp", "BANG_KE"],
    ["giúp", "HELP"],
    ["làm được gì", "HELP"],
    ["0901234567", "CUSTOMER_LOOKUP"],
    ["thông tin khách chị Lan", "CUSTOMER_LOOKUP"],
    ["pro max 256", "STOCK"],
    ["trời hôm nay đẹp quá", "UNKNOWN"],
    ["asdfgh", "UNKNOWN"],
  ])("%s → %s", (t, want) => expect(intent(t)).toBe(want));
});

describe("lời đáp ngắn", () => {
  it.each([
    ["ok", { type: "CONFIRM" }],
    ["Xác nhận", { type: "CONFIRM" }],
    ["chốt", { type: "CONFIRM" }],
    ["huỷ", { type: "CANCEL" }],
    ["để sau", { type: "DRAFT" }],
    ["2", { type: "CHOOSE", index: 2 }],
    ["chọn 1", { type: "CHOOSE", index: 1 }],
    ["sửa giá 26tr", { type: "EDIT", text: "giá 26tr" }],
    ["đổi khách thành chị Hoa", { type: "EDIT", text: "khách chị Hoa" }],
  ])("%s", (t, want) => expect(metaOf(t, true)).toEqual(want));
  it("không có phiếu chờ thì 'ok' không phải xác nhận", () => expect(metaOf("ok", false)).toBeNull());
  it("xoá lịch sử luôn nhận", () => expect(metaOf("xoá lịch sử", false)).toEqual({ type: "CLEAR" }));
});
