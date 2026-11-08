/**
 * Gói dữ liệu cho chat demo của BẢN XEM THỬ TĨNH: câu trả lời dựng sẵn bằng chính `answerQuery` (khớp các trang đã chụp)
 * + danh sách máy / khách / tài khoản / đơn để trình duyệt tự lập phiếu xem trước. Chỉ dùng lúc chụp site (scripts/build-static-site.ts).
 */
import type { Sql, TransactionSql } from "postgres";
import { DEMO_PERIODS, demoKey, type DemoPack, type DemoPeriod } from "@/domain/assistant/demo";
import type { Slots } from "@/domain/assistant/extract";
import type { Intent } from "@/domain/assistant/intents";
import { fold } from "@/domain/assistant/normalize";
import type { Reply } from "@/domain/assistant/reply";
import { variantLabel } from "@/domain/catalog";
import { NOT_SELLABLE } from "@/domain/sales-core";
import { listCustomers } from "@/server/customers/service";
import { loadParseCtx } from "./context";
import { purchaseOrdersFor, stockByVariant } from "./lookups";
import { answerQuery } from "./queries";

type Db = Sql | TransactionSql;

const S = (over: Partial<Slots> = {}): Slots => ({ codes: [], money: [], usd: [], accountHints: [], fromAccountHints: [], rest: "", variantIds: [], lines: 0, ...over });
const P = (p: DemoPeriod) => (p ? { period: { ky: p } } : {});

export async function buildDemoPack(db: Db, today: string): Promise<DemoPack> {
  const answers: Record<string, Reply> = {};
  const put = async (intent: Intent, subject: string, period: DemoPeriod, slots: Slots) => {
    answers[demoKey(intent, subject, period)] = await answerQuery({ db, today }, intent, slots);
  };

  // câu hỏi theo kỳ
  for (const p of DEMO_PERIODS) {
    for (const i of ["REVENUE", "MONTHLY", "BY_CHANNEL", "RECENT_SALES", "CASHFLOW"] as const) await put(i, "", p, S(P(p)));
    for (const [sub, rest] of [["", ""], ["ads", "quang cao"], ["rent", "mat bang"], ["telecom", "internet"]] as const) await put("OPEX", sub, p, S({ ...P(p), rest }));
    for (const [sub, rest] of [["", ""], ["units", "ban chay"]] as const) await put("TOP_MODELS", sub, p, S({ ...P(p), rest }));
  }
  for (const p of ["", "nam", "nam-truoc"] as const) for (const i of ["TAX", "UNINVOICED"] as const) await put(i, "", p, S(P(p)));
  // câu hỏi không theo kỳ
  for (const i of ["STOCK", "AGED_STOCK", "CAPITAL", "PAYABLES", "BALANCE", "ALERTS", "DEBT", "BATCH"] as const) await put(i, "", "", S());
  for (const [sub, rest] of [["", ""], ["hn", "ha noi"], ["uswh", "kho my"]] as const) await put("STAGE", sub, "", S({ rest }));
  for (const [sub, rest] of [["", ""], ["hopcho", "hop cho"]] as const) await put("DOCS", sub, "", S({ rest }));
  for (const [sub, rest] of [["", ""], ["late", "tre"]] as const) await put("SHIPMENTS", sub, "", S({ rest }));

  // máy
  const items = await db<
    {
      id: string;
      serial: string | null;
      imei: string | null;
      model: string;
      storage: string | null;
      color: string | null;
      chip: string | null;
      memory: string | null;
      connectivity: string | null;
      variant_id: string;
      status: string;
      cost: string;
      has_estimate: boolean;
      target: string | null;
      sg: string | null;
      ordered: string | null;
      active: string | null;
      batch_code: string;
    }[]
  >`
    SELECT i.id::text, i.serial_number AS serial, i.imei1 AS imei, m.name AS model, v.storage, v.color, v.chip, v.memory, v.connectivity,
           v.id::text AS variant_id, i.status::text, lc.landed_cost_vnd::text AS cost, lc.has_estimate, i.target_price_vnd::text AS target,
           to_char(ms.sg_received_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS sg,
           to_char(ms.ordered_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ordered,
           (SELECT s.code FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.item_id = i.id AND si.voided_at IS NULL AND s.status <> 'CANCELLED' LIMIT 1) AS active,
           b.code AS batch_code
      FROM items i JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id
      JOIN v_item_landed_cost lc ON lc.item_id = i.id LEFT JOIN v_item_milestones ms ON ms.item_id = i.id JOIN batches b ON b.id = i.batch_id
     WHERE i.deleted_at IS NULL ORDER BY ms.sg_received_at NULLS LAST, i.created_at`;
  const demoItems = items.map((r) => {
    const no = (NOT_SELLABLE as readonly string[]).includes(r.status) || !!r.active;
    return {
      id: r.id,
      serial: r.serial,
      imei: r.imei,
      label: variantLabel(r.model, r),
      variantId: r.variant_id,
      status: r.status,
      costVnd: r.cost,
      hasEstimate: r.has_estimate,
      targetVnd: r.target,
      sg: r.sg,
      ordered: r.ordered,
      sellable: no ? ("NO" as const) : r.sg ? ("NOW" as const) : ("DEPOSIT_ONLY" as const),
      reason: r.active ? `Đã có đơn ${r.active}` : no ? "Máy đã bán / không bán được" : r.sg ? null : "Máy chưa về SG — nhận cọc (đặt trước) hoặc xác nhận bán giao thẳng",
      batchCode: r.batch_code,
    };
  });
  for (const it of demoItems) {
    const code = it.serial ?? it.imei;
    if (!code) continue;
    const c = [{ kind: it.serial ? ("SERIAL" as const) : ("IMEI" as const), value: code, line: 0 }];
    await put("ITEM_LOOKUP", `item:${it.id}`, "", S({ codes: c }));
    await put("PRICE_SUGGEST", `item:${it.id}`, "", S({ codes: c }));
  }

  // đơn bán, chuyến, kiện
  const sales = await db<{ id: string; code: string; status: string; customer_id: string | null; customer: string | null }[]>`
    SELECT s.id::text, s.code, s.status::text, s.customer_id::text, c.full_name AS customer FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ORDER BY s.sold_at`;
  for (const s of sales) await put("SALE_LOOKUP", s.code, "", S({ saleCode: s.code }));
  const saleRows = [];
  for (const s of sales) {
    const bal = await db<{ total: string; paid: string; items: string | null }[]>`
      SELECT (SELECT COALESCE(SUM(price_vnd - discount_alloc_vnd), 0)::text FROM sale_items WHERE sale_id = ${s.id} AND voided_at IS NULL) AS total,
             (SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount_vnd ELSE -amount_vnd END), 0)::text FROM cash_transactions WHERE sale_id = ${s.id} AND deleted_at IS NULL) AS paid,
             (SELECT string_agg(m.name || COALESCE(' ' || v.storage, ''), ', ') FROM sale_items si JOIN items i ON i.id = si.item_id
                JOIN product_variants v ON v.id = i.variant_id JOIN product_models m ON m.id = v.model_id WHERE si.sale_id = ${s.id} AND si.voided_at IS NULL) AS items`;
    const [b] = bal;
    saleRows.push({
      id: s.id,
      code: s.code,
      status: s.status,
      customerId: s.customer_id,
      customer: s.customer,
      items: b.items ?? "",
      revenueVnd: b.total,
      balanceVnd: s.status === "CANCELLED" ? "0" : String(BigInt(b.total) - BigInt(b.paid)),
    });
  }
  const batches = await db<{ id: string; code: string }[]>`SELECT id::text, code FROM batches WHERE deleted_at IS NULL ORDER BY code`;
  for (const b of batches) await put("BATCH", b.code, "", S({ batchCode: b.code }));
  const ships = await db<{ id: string; tracking: string; leg: string; n: number }[]>`
    SELECT sh.id::text, COALESCE(sh.tracking_number, sh.reference_code) AS tracking, sh.leg_type::text AS leg,
           (SELECT COUNT(*)::int FROM shipment_items si WHERE si.shipment_id = sh.id) AS n
      FROM shipments sh WHERE COALESCE(sh.tracking_number, sh.reference_code) IS NOT NULL`;
  for (const s of ships) await put("SHIPMENTS", `track:${s.tracking}`, "", S({ tracking: s.tracking }));

  // khách, tài khoản
  const customers = await listCustomers(db, "", 500);
  for (const c of customers) {
    const slots = S(c.phone ? { phone: c.phone } : { customerName: c.fullName });
    await put("DEBT", `cust:${c.id}`, "", slots);
    await put("CUSTOMER_LOOKUP", `cust:${c.id}`, "", slots);
  }
  const accounts = await db<{ id: string; name: string; kind: string; currency: string }[]>`
    SELECT id::text, name, kind::text, currency::text FROM accounts WHERE is_active ORDER BY (kind <> 'BANK'), name`;
  for (const a of accounts) await put("BALANCE", `acc:${a.id}`, "", S({ accountHints: [fold(a.name)] }));
  const categories = await db<{ code: string; name: string; direction: "IN" | "OUT" }[]>`
    SELECT code, name, direction::text AS direction FROM cash_categories
     WHERE NOT is_system OR code IN ('OPEX_ADS', 'OPEX_TELECOM', 'OPEX_RENT', 'OPEX_OTHER', 'OTHER_IN', 'CAPITAL_IN', 'CAPITAL_OUT', 'TAX') ORDER BY direction DESC, name`;

  const ctx = await loadParseCtx(db, today);
  const pos = await purchaseOrdersFor(db);
  const stock = await stockByVariant(db);
  return {
    today,
    variants: [...ctx.variants],
    accountNames: [...(ctx.accountNames ?? [])],
    items: demoItems,
    stock: stock.map((s) => ({ ...s, costVnd: s.costVnd.toString() })),
    customers: customers.map((c) => ({ id: c.id, name: c.fullName, phone: c.phone })),
    accounts,
    categories,
    sales: saleRows,
    batches: batches.map((b) => ({ code: b.code, href: `/chuyen-hang/${b.id}` })),
    purchaseOrders: pos.map((p) => ({ id: p.id, batchCode: p.batchCode, label: p.label, currency: p.currency })),
    shipments: ships.map((s) => ({ tracking: s.tracking, legType: s.leg, itemCount: s.n, href: `/van-chuyen/${s.id}` })),
    answers,
  };
}
