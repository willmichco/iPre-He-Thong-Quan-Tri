/**
 * Bảng kê Excel của trợ lý: một file .xlsx gồm Bảng kê bán · Bảng kê nhập · Thu chi · Tồn kho · Bảng kê nháp.
 * Cột ngày là ngày thật của Excel (lọc / sắp xếp được), cột tiền là số (cộng / lọc được), dòng tổng in đậm.
 * Số liệu lấy từ cùng nguồn với trang Báo cáo / Sổ thu chi / Kho (khớp từng đồng).
 */
import type { Sql, TransactionSql } from "postgres";
import { dmy } from "@/domain/assistant/dates";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing-core";
import type { Range } from "@/domain/reports";
import { CHANNEL_LABEL, SALE_STATUS_LABEL, type Channel } from "@/domain/sales-core";
import { listTransactions } from "@/server/ledger/service";
import { inventory } from "@/server/reports/service";
import type { Sheet } from "@/server/reports/xlsx";
import { BANG_KE_KIND_LABEL, listBangKe } from "./bang-ke";

type Db = Sql | TransactionSql;
const ts = (d: string) => `${d}T00:00:00+07:00`;
const addDay = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const sum = (xs: readonly bigint[]) => xs.reduce((a, x) => a + x, 0n);

export async function saleLines(db: Db, from: string, toExcl: string) {
  return db<
    {
      day: string;
      code: string;
      status: string;
      customer: string | null;
      channel: string;
      model: string;
      serial: string | null;
      imei: string | null;
      price: string;
      discount: string;
      net: string;
      cogs: string | null;
      profit: string | null;
      einvoice: string | null;
      warranty: string | null;
    }[]
  >`
    SELECT to_char(s.sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day, s.code, s.status::text, c.full_name AS customer, s.channel::text,
           m.name || COALESCE(' · ' || v.storage, '') || COALESCE(' · ' || v.color, '') AS model, i.serial_number AS serial, i.imei1 AS imei,
           si.price_vnd::text AS price, si.discount_alloc_vnd::text AS discount, (si.price_vnd - si.discount_alloc_vnd)::text AS net,
           p.cogs_vnd::text AS cogs, p.profit_vnd::text AS profit, s.einvoice_no AS einvoice, si.warranty_until::text AS warranty
      FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN customers c ON c.id = s.customer_id
      JOIN items i ON i.id = si.item_id JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      LEFT JOIN v_sale_item_profit p ON p.sale_item_id = si.id
     WHERE si.voided_at IS NULL AND s.status <> 'CANCELLED' AND s.sold_at >= ${ts(from)} AND s.sold_at < ${ts(toExcl)}
     ORDER BY s.sold_at, s.code, si.id`;
}

export async function purchaseLines(db: Db, from: string, toExcl: string) {
  return db<
    {
      day: string;
      batch: string;
      supplier: string;
      order_no: string | null;
      model: string;
      serial: string | null;
      imei: string | null;
      price: string;
      currency: string;
      fx: string;
      landed: string;
      status: string;
    }[]
  >`
    SELECT to_char(po.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS day, b.code AS batch, sp.name AS supplier, po.order_number AS order_no,
           m.name || COALESCE(' · ' || v.storage, '') || COALESCE(' · ' || v.color, '') AS model, i.serial_number AS serial, i.imei1 AS imei,
           i.unit_price::text AS price, po.currency::text AS currency, po.fx_rate::text AS fx, lc.landed_cost_vnd::text AS landed, i.status::text
      FROM items i JOIN purchase_orders po ON po.id = i.purchase_order_id JOIN batches b ON b.id = i.batch_id JOIN suppliers sp ON sp.id = po.supplier_id
      JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id JOIN v_item_landed_cost lc ON lc.item_id = i.id
     WHERE i.deleted_at IS NULL AND po.deleted_at IS NULL AND po.ordered_at >= ${ts(from)} AND po.ordered_at < ${ts(toExcl)}
     ORDER BY po.ordered_at, b.code, i.created_at`;
}

export async function exportBangKe(db: Db, range: Range, today: string): Promise<{ filename: string; sheets: Sheet[] }> {
  const [sales, buys, ledger, inv, drafts] = await Promise.all([
    saleLines(db, range.from, range.toExcl),
    purchaseLines(db, range.from, range.toExcl),
    listTransactions(db, { from: range.from, to: addDay(range.toExcl, -1), limit: 2000 }),
    inventory(db),
    listBangKe(db, { status: "DRAFT" }),
  ]);
  const head = (name: string) => [`iPre — ${name}`, `Kỳ: ${range.label}${range.key === "tuy-chon" ? "" : ` (${dmy(range.from)} – ${dmy(addDay(range.toExcl, -1))})`}`, `Xuất ngày ${dmy(today)}`];
  const B = (s: string | null) => (s === null ? null : BigInt(s));
  const slug = range.key === "tuy-chon" ? `${range.from}_${addDay(range.toExcl, -1)}` : range.from.slice(0, 7);

  const saleSheet: Sheet = {
    name: "Bảng kê bán",
    title: [...head("Bảng kê bán hàng"), `${new Set(sales.map((s) => s.code)).size} đơn · ${sales.length} máy (đơn cọc: doanh thu ghi nhận khi hoàn tất)`],
    columns: [
      { header: "Ngày", type: "date" },
      { header: "Mã đơn", type: "text" },
      { header: "Trạng thái", type: "text" },
      { header: "Khách", type: "text" },
      { header: "Kênh", type: "text" },
      { header: "Dòng máy", type: "text" },
      { header: "Giá bán", type: "money" },
      { header: "Giảm giá", type: "money" },
      { header: "Doanh thu thuần", type: "money" },
      { header: "Giá vốn", type: "money" },
      { header: "Lãi", type: "money" },
      { header: "Serial", type: "text" },
      { header: "IMEI", type: "text" },
      { header: "Số hoá đơn", type: "text" },
      { header: "Bảo hành đến", type: "date" },
    ],
    rows: sales.map((s) => [
      s.day,
      s.code,
      SALE_STATUS_LABEL[s.status] ?? s.status,
      s.customer,
      CHANNEL_LABEL[s.channel as Channel] ?? s.channel,
      s.model,
      BigInt(s.price),
      BigInt(s.discount),
      BigInt(s.net),
      B(s.cogs),
      B(s.profit),
      s.serial,
      s.imei,
      s.einvoice,
      s.warranty,
    ]),
    total: [
      "Tổng",
      null,
      null,
      null,
      null,
      `${sales.length} máy`,
      sum(sales.map((s) => BigInt(s.price))),
      sum(sales.map((s) => BigInt(s.discount))),
      sum(sales.map((s) => BigInt(s.net))),
      sum(sales.map((s) => B(s.cogs) ?? 0n)),
      sum(sales.map((s) => B(s.profit) ?? 0n)),
    ],
  };

  const buySheet: Sheet = {
    name: "Bảng kê nhập",
    title: [...head("Bảng kê nhập hàng"), `${buys.length} máy theo ngày đặt mua`],
    columns: [
      { header: "Ngày đặt", type: "date" },
      { header: "Chuyến", type: "text" },
      { header: "Nơi mua", type: "text" },
      { header: "Số đơn", type: "text" },
      { header: "Dòng máy", type: "text" },
      { header: "Serial", type: "text" },
      { header: "IMEI", type: "text" },
      { header: "Đơn giá", type: "dec" },
      { header: "Tiền tệ", type: "text" },
      { header: "Tỷ giá", type: "dec" },
      { header: "Giá vốn (VND)", type: "money" },
      { header: "Trạng thái", type: "text" },
    ],
    rows: buys.map((b) => [b.day, b.batch, b.supplier, b.order_no, b.model, b.serial, b.imei, Number(b.price), b.currency, Number(b.fx), BigInt(b.landed), ITEM_STATUS_LABEL[b.status] ?? b.status]),
    total: ["Tổng", null, null, null, `${buys.length} máy`, null, null, null, null, null, sum(buys.map((b) => BigInt(b.landed)))],
  };

  const ledgerSheet: Sheet = {
    name: "Thu chi",
    title: [...head("Sổ thu chi"), ledger.truncated ? `Chỉ hiện ${ledger.rows.length} / ${ledger.total} bút toán — xuất theo kỳ ngắn hơn` : `${ledger.total} bút toán`],
    columns: [
      { header: "Ngày", type: "date" },
      { header: "Tài khoản", type: "text" },
      { header: "Danh mục", type: "text" },
      { header: "Thu", type: "money" },
      { header: "Chi", type: "money" },
      { header: "Đối tượng", type: "text" },
      { header: "Chứng từ", type: "text" },
      { header: "Ghi chú", type: "text" },
    ],
    rows: [...ledger.rows]
      .reverse()
      .map((t) => [t.date, t.account, t.category, t.direction === "IN" ? t.amountVnd : null, t.direction === "OUT" ? t.amountVnd : null, t.counterparty, t.link?.label ?? null, t.note]),
    // tổng của sổ (không tính chuyển tiền nội bộ)
    total: ["Tổng", null, null, ledger.inVnd, ledger.outVnd],
  };

  const stockSheet: Sheet = {
    name: "Tồn kho",
    title: [`iPre — Tồn kho tại SG`, `Tới ngày ${dmy(today)}`, `${inv.items.length} máy (kể cả khách cọc)`],
    columns: [
      { header: "Máy", type: "text" },
      { header: "Serial", type: "text" },
      { header: "Trạng thái", type: "text" },
      { header: "Ngày tồn", type: "int" },
      { header: "Giá vốn", type: "money" },
      { header: "Giá mục tiêu", type: "money" },
    ],
    rows: inv.items.map((i) => [i.label, i.serial, ITEM_STATUS_LABEL[i.status] ?? i.status, i.days, i.costVnd, i.targetPriceVnd]),
    total: ["Tổng", null, null, null, inv.totalVnd],
  };

  const draftSheet: Sheet = {
    name: "Bảng kê nháp",
    title: ["iPre — Bảng kê nháp (chưa ghi vào sổ)", `${drafts.length} dòng chờ bổ sung`, `Xuất ngày ${dmy(today)}`],
    columns: [
      { header: "Ngày", type: "date" },
      { header: "Loại", type: "text" },
      { header: "Dòng máy", type: "text" },
      { header: "IMEI / Serial", type: "text" },
      { header: "Số tiền", type: "text" },
      { header: "Khách", type: "text" },
      { header: "SĐT", type: "text" },
      { header: "Kênh", type: "text" },
      { header: "Thanh toán", type: "text" },
      { header: "Tham chiếu", type: "text" },
      { header: "Vì sao chưa ghi", type: "text" },
      { header: "Ghi chú", type: "text" },
    ],
    rows: drafts.map((d) => [
      d.occurredOn ?? d.createdAt.slice(0, 10),
      BANG_KE_KIND_LABEL[d.kind],
      d.modelText,
      d.code,
      d.priceText,
      d.customerText,
      d.customerPhone,
      d.channel ? (CHANNEL_LABEL[d.channel as Channel] ?? d.channel) : null,
      d.payment,
      d.refText,
      d.reason,
      d.note,
    ]),
  };

  return { filename: `ipre-bang-ke-${slug}.xlsx`, sheets: [saleSheet, buySheet, ledgerSheet, stockSheet, draftSheet] };
}
