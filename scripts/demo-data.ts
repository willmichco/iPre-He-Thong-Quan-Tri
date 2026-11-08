/**
 * Dữ liệu mẫu phong phú cho BẢN XEM THỬ (GitHub Pages): thêm 3 chuyến, ~20 máy đi đủ 3 chặng, đơn bán / cọc / công nợ,
 * thu chi, chi phí cước — tất cả qua ĐÚNG các dịch vụ của ứng dụng (cùng kiểm tra, cùng giá vốn, cùng nhật ký).
 * Chạy MỘT lần trên CSDL vừa `npm run db:seed` (dữ liệu cố định → lần chụp nào cũng ra giống nhau).
 *
 *   DATABASE_URL=… npm run db:seed && npm run demo:data
 *
 * KHÔNG chạy trên CSDL thật.
 */
import postgres, { type Sql } from "postgres";
import { validate } from "@/domain/catalog";
import { accountSchema, modelSchema, variantSchema } from "@/domain/catalog";
import { costSchema } from "@/domain/costs";
import { checkManualEntry } from "@/domain/ledger";
import { purchaseOrderSchema } from "@/domain/purchasing";
import { emptyRow } from "@/domain/purchasing-core";
import { saleSchema } from "@/domain/sales";
import { shipmentSchema } from "@/domain/shipping";
import { addBangKe } from "@/server/assistant/bang-ke";
import { createModel, createVariant, saveAccount } from "@/server/catalog/service";
import { saveCost } from "@/server/costs/service";
import { saveManualEntry } from "@/server/ledger/service";
import { appendItems, createBatch, savePurchaseOrder } from "@/server/purchasing/service";
import { createSale } from "@/server/sales/service";
import { assignItems, createShipment, markArrived, markShipped } from "@/server/shipping/service";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Cần DATABASE_URL");

const SUPPLIER = "30000000-0000-0000-0000-000000000001"; // Apple Store (seed)
const USPS = "40000000-0000-0000-0000-000000000001";
const FORWARDER = "40000000-0000-0000-0000-000000000002";
const CHANH = "40000000-0000-0000-0000-000000000003";
const BANK = "50000000-0000-0000-0000-000000000002";
const PM256 = "20000000-0000-0000-0000-000000000001"; // iPhone Pro Max · 256GB · Silver (seed)
const IPAD = "20000000-0000-0000-0000-000000000002";
const AIRPODS = "20000000-0000-0000-0000-000000000003";

const must = <T>(r: { ok: true; data: T } | { ok: false; errors: Record<string, string> }, what: string): T => {
  if (!r.ok) throw new Error(`${what}: ${JSON.stringify(r.errors)}`);
  return r.data;
};
const vn = (d: string, h = 12) => `${d}T${String(h).padStart(2, "0")}:00:00+07:00`;
const at = (d: string, h = 12) => new Date(vn(d, h));

/** IMEI hợp lệ (Luhn) từ số thứ tự — cố định. */
function imei(n: number) {
  const body = `35${String(208100 + n).padStart(6, "0")}${String(n * 7919).padStart(6, "0").slice(-6)}`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = +body[i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + ((10 - (sum % 10)) % 10);
}
const serial = (n: number) => `FJ6D${String(n).padStart(8, "0")}`;

interface Unit {
  variant: string;
  price: string;
  n: number;
  phone: boolean;
}

async function batch(sql: Sql, code: string, orderedAt: string, fx: string, units: Unit[]) {
  const b = await createBatch(sql, { code, name: null, plannedFxRate: fx, note: null });
  const subtotal = units.reduce((a, u) => a + Number(u.price), 0).toFixed(2);
  const po = must(
    validate(purchaseOrderSchema, {
      supplierId: SUPPLIER,
      orderNumber: `W${code.slice(-3)}88${code.slice(-2)}1`,
      orderedAt,
      currency: "USD",
      subtotal,
      fxRate: fx,
      paymentAccountId: BANK,
      paidAt: orderedAt,
    }),
    "đơn mua",
  );
  const { id: poId } = await savePurchaseOrder(sql, b.id, null, po);
  await appendItems(
    sql,
    poId,
    units.map((u) => ({ ...emptyRow(), variantId: u.variant, unitPrice: u.price, serial: serial(u.n), imei1: u.phone ? imei(u.n) : "" })),
  );
  return { batchId: b.id, codes: units.map((u) => serial(u.n)) };
}

async function leg(sql: Sql, legType: "US_DOMESTIC" | "US_TO_VN" | "HN_TO_SG", carrierId: string, tracking: string, codes: string[], shipped: string | null, arrived: string | null, eta?: string) {
  const input = must(validate(shipmentSchema, { legType, carrierId, trackingNumber: tracking, eta: eta ?? "", chargeableWeightKg: legType === "US_TO_VN" ? "4.2" : "" }), "kiện");
  const id = await createShipment(sql, input);
  await assignItems(sql, id, codes);
  if (shipped) await markShipped(sql, id, vn(shipped, 9));
  if (arrived) await markArrived(sql, id, vn(arrived, 16));
  return id;
}

async function sale(
  sql: Sql,
  date: string,
  code: string,
  price: string,
  extra: { name?: string; phone?: string; channel?: string; payment?: string; paid?: string; account?: string; invoice?: string; warranty?: string },
) {
  const input = must(
    validate(saleSchema, {
      lines: [{ itemId: (await sql<{ id: string }[]>`SELECT id::text FROM items WHERE serial_number = ${code}`)[0].id, price }],
      customerName: extra.name ?? "",
      customerPhone: extra.phone ?? "",
      channel: extra.channel ?? "OTHER",
      payment: extra.payment ?? "TRANSFER",
      accountId: extra.account ?? (extra.payment === "UNPAID" && !extra.paid ? "" : BANK),
      paidAmount: extra.paid ?? "",
      warrantyMonths: extra.warranty ?? "6",
      einvoiceNo: extra.invoice ?? "",
      confirmBelowCost: "true",
    }),
    `bán ${code}`,
  );
  return createSale(sql, input, at(date, 15));
}

async function ledger(sql: Sql, accountId: string, categoryCode: string, amount: string, occurredAt: string, note: string) {
  const c = checkManualEntry({ accountId, categoryCode, amount, fxRate: "", occurredAt, counterparty: "", note });
  if (!c.ok) throw new Error(JSON.stringify(c.errors));
  await saveManualEntry(sql, null, c.data);
}

async function main() {
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  try {
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM batches WHERE code = 'CH-2026-012'`;
    if (n) {
      console.log("Dữ liệu mẫu đã có (CH-2026-012) — bỏ qua.");
      return;
    }
    // danh mục: thêm iPhone 16 Pro, MacBook Air, quỹ tiền mặt
    const ip16 = await createModel(sql, must(validate(modelSchema, { category: "IPHONE", name: "iPhone 16 Pro", releaseYear: "2024" }), "mẫu"));
    const mba = await createModel(sql, must(validate(modelSchema, { category: "MAC", name: "MacBook Air 13 M4", releaseYear: "2025" }), "mẫu"));
    const v = async (modelId: string, sku: string, storage: string, color: string, memory = "") =>
      (await createVariant(sql, must(validate(variantSchema, { modelId, sku, storage, color, memory, chip: "", connectivity: "", defaultWeightKg: "0.4", isActive: "on" }), "cấu hình"))).id;
    const P256 = await v(ip16, "IP16P-256-DES", "256GB", "Desert");
    const P512 = await v(ip16, "IP16P-512-NAT", "512GB", "Natural");
    const MAC = await v(mba, "MBA13M4-16-512-MID", "512GB", "Midnight", "16GB");
    const CASH = await saveAccount(sql, null, must(validate(accountSchema, { name: "Tiền mặt", kind: "CASH", currency: "VND", openingBalance: "20000000", isActive: "on" }), "tài khoản"));

    // vốn
    await ledger(sql, BANK, "CAPITAL_IN", "300000000", "2026-10-01", "Bổ sung vốn nhập hàng quý 4");

    // CH-2026-012: về SG đủ 3 chặng
    let k = 1;
    const u = (variant: string, price: string, phone = true): Unit => ({ variant, price, n: k++, phone });
    const b12 = await batch(sql, "CH-2026-012", "2026-10-10", "26350", [
      u(P256, "999.00"),
      u(P256, "999.00"),
      u(P256, "999.00"),
      u(P256, "999.00"),
      u(P512, "1199.00"),
      u(P512, "1199.00"),
      u(PM256, "1199.00"),
      u(PM256, "1199.00"),
      u(MAC, "1099.00", false),
      u(AIRPODS, "249.00", false),
      u(AIRPODS, "249.00", false),
    ]);
    await leg(sql, "US_DOMESTIC", USPS, "9400111899223344556677", b12.codes, "2026-10-11", "2026-10-14");
    const intl12 = await leg(sql, "US_TO_VN", FORWARDER, "AWB-0012", b12.codes, "2026-10-16", "2026-10-24");
    const dom12 = await leg(sql, "HN_TO_SG", CHANH, "HNSG-0012", b12.codes, "2026-10-25", "2026-10-27");
    const cost = async (target: string, kind: string, amount: string, incurredAt: string) =>
      saveCost(sql, null, must(validate(costSchema, { kind, target, currency: "VND", amount, incurredAt, accountId: BANK, paidAt: incurredAt }), "chi phí"));
    await cost(`SHIPMENT:${intl12}`, "INTL_SHIPPING", "3360000", "2026-10-24");
    await cost(`SHIPMENT:${dom12}`, "DOMESTIC_SHIPPING", "450000", "2026-10-27");

    // CH-2026-013: đang bay Mỹ → VN (trễ hẹn)
    const b13 = await batch(sql, "CH-2026-013", "2026-10-28", "26420", [u(P256, "999.00"), u(P256, "999.00"), u(P256, "999.00"), u(PM256, "1199.00"), u(PM256, "1199.00"), u(IPAD, "599.00", false)]);
    await leg(sql, "US_DOMESTIC", USPS, "9400111899223344556688", b13.codes, "2026-10-29", "2026-11-01");
    await leg(sql, "US_TO_VN", FORWARDER, "AWB-0013", b13.codes, "2026-11-02", null, "2026-11-06");

    // CH-2026-014: mới đặt, người bán chưa gửi
    const b14 = await batch(sql, "CH-2026-014", "2026-11-05", "26450", [u(P512, "1199.00"), u(P512, "1199.00"), u(P512, "1199.00")]);
    await leg(sql, "US_DOMESTIC", USPS, "9400111899223344556699", b14.codes, null, null);

    // bán hàng (máy CH-2026-012 đã về SG)
    const c = b12.codes;
    await sale(sql, "2026-10-28", c[0], "28900000", { name: "Chị Lan", phone: "0901234567", channel: "FACEBOOK", invoice: "0000123" });
    await sale(sql, "2026-10-30", c[6], "33500000", { name: "Anh Nam", phone: "0912345678", channel: "ZALO", payment: "CASH", account: CASH, warranty: "12" });
    await sale(sql, "2026-11-02", c[9], "6200000", { channel: "WALK_IN", payment: "CASH", account: CASH });
    await sale(sql, "2026-11-03", c[4], "32500000", { name: "Chị Hoa", phone: "0987654321", channel: "ZALO", payment: "UNPAID", paid: "20000000" });
    await sale(sql, "2026-11-05", c[8], "31000000", { name: "Anh Tuấn", phone: "0933222111", channel: "TIKTOK", warranty: "12" });
    await sale(sql, "2026-11-06", c[1], "28500000", { name: "Chị Mai", phone: "0977111222", channel: "FACEBOOK", payment: "DEPOSIT", paid: "5000000" });
    await sale(sql, "2026-11-07", c[2], "28700000", { name: "Anh Bình", phone: "0966555444", channel: "REFERRAL" });
    // khách cọc máy đang về (CH-2026-013)
    await sale(sql, "2026-11-04", b13.codes[3], "33000000", { name: "Anh Khoa", phone: "0905666777", channel: "ZALO", payment: "DEPOSIT", paid: "3000000" });

    // chi phí vận hành
    await ledger(sql, BANK, "OPEX_ADS", "1500000", "2026-10-20", "Quảng cáo Facebook");
    await ledger(sql, BANK, "OPEX_ADS", "2000000", "2026-11-03", "Quảng cáo Facebook + TikTok");
    await ledger(sql, CASH, "OPEX_RENT", "5000000", "2026-11-01", "Tiền mặt bằng tháng 11");
    await ledger(sql, BANK, "OPEX_TELECOM", "350000", "2026-11-02", "Internet + phần mềm");

    // bảng kê nháp
    await addBangKe(
      sql,
      { kind: "SALE", occurredOn: "2026-11-07", modelText: "16 pro max 256", code: "356789012345672", priceText: "34500000", customerText: "Anh Quân", customerPhone: null, channel: "ZALO", payment: null, refText: null, note: null },
      { reason: "Máy 356789012345672 chưa có trong hệ thống" },
    );
    await addBangKe(
      sql,
      { kind: "EXPENSE", occurredOn: "2026-11-08", modelText: null, code: null, priceText: "800000", customerText: null, customerPhone: null, channel: null, payment: null, refText: null, note: "phí kiểm máy" },
      { reason: "Để sau" },
    );
    console.log("✓ Đã nạp dữ liệu mẫu cho bản xem thử (CH-2026-012 · 013 · 014, 8 đơn bán, thu chi, bảng kê nháp).");
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
