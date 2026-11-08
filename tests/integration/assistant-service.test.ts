/**
 * Trợ lý nhập liệu ↔ PostgreSQL: hỏi đáp khớp số liệu báo cáo; phiếu chỉ ghi khi xác nhận; sửa phiếu; bấm 2 lần chỉ ghi 1;
 * bảng kê nháp; chặn ghi lùi ngày trước khi máy về; nhập máy; ẩn danh hoá khách làm sạch phần chat.
 * Mỗi ca chạy trong transaction rồi HUỶ.
 */
import postgres, { type TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/domain/reports";
import type { PreviewCard, Reply } from "@/domain/assistant/reply";
import { validate } from "@/domain/catalog";
import { purchaseOrderSchema } from "@/domain/purchasing";
import { addBangKe, listBangKe, saveBangKe } from "@/server/assistant/bang-ke";
import { todayVn } from "@/server/assistant/context";
import { exportBangKe } from "@/server/assistant/export";
import { handleEvent, handleMessage, promoteBangKe, type HandleCtx } from "@/server/assistant/handle";
import { getOrCreateConversation, listMessages, purgeOld } from "@/server/assistant/store";
import { anonymizeCustomer } from "@/server/customers/service";
import { createBatch, savePurchaseOrder } from "@/server/purchasing/service";
import { inventory } from "@/server/reports/service";
import { parseRange } from "@/domain/reports";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử tích hợp cần DATABASE_URL trỏ tới CSDL đã chạy `npm run db:seed`");
const sql = postgres(url, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

class Rollback extends Error {}
async function inTx(fn: (tx: TransactionSql) => Promise<void>) {
  await sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

const TODAY = todayVn();
const AIRPODS = "SERIALAIRPODS1"; // máy duy nhất còn tồn trong dữ liệu ví dụ
const SUPPLIER = "30000000-0000-0000-0000-000000000001";

async function ctxOf(tx: TransactionSql): Promise<HandleCtx> {
  const c = await getOrCreateConversation(tx, "WEB", `test-${Math.random()}`);
  return { db: tx, conversationId: c.id, today: TODAY };
}
const previewOf = (rs: Reply[]) => rs.flatMap((r) => r.cards ?? []).find((c): c is PreviewCard => c.kind === "preview");
const row = (p: PreviewCard | undefined, label: string) => p?.rows.find(([k]) => k === label)?.[1];

describe("Trợ lý ↔ PostgreSQL", () => {
  it("hỏi tồn kho: khớp báo cáo tồn kho", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const [r] = await handleMessage(ctx, "tồn kho");
      const inv = await inventory(tx);
      const ready = inv.items.filter((i) => i.status === "IN_STOCK").length;
      expect(r.text).toContain(`${ready} máy sẵn bán`);
      expect(r.link?.href).toBe("/kho");
    });
  });

  it("bán: phiếu → sửa giá → xác nhận → đúng 1 đơn; nhật ký không chứa tên / SĐT khách", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const before = (await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM sales`)[0].n;

      const r1 = await handleMessage(ctx, `bán serial ${AIRPODS} cho chị Lan 0901 234 567 6tr5 zalo ck bh 12 tháng`);
      const p1 = previewOf(r1);
      expect(p1, JSON.stringify(r1)).toBeDefined();
      expect(p1!.blockers).toEqual([]);
      expect(row(p1, "Giá bán")).toBe("6.500.000 đ");
      expect(row(p1, "Khách")).toContain("Chị Lan · 0901234567 (khách mới)");
      expect(row(p1, "Kênh")).toBe("Zalo");
      expect(row(p1, "Bảo hành")).toBe("12 tháng");
      expect(p1!.profit).toBeDefined();
      // chưa xác nhận → chưa ghi gì
      expect((await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM sales`)[0].n).toBe(before);

      const r2 = await handleMessage(ctx, "sửa giá 7tr");
      const p2 = previewOf(r2);
      expect(p2?.actionId).toBe(p1!.actionId);
      expect(row(p2, "Giá bán")).toBe("7.000.000 đ");

      const r3 = await handleEvent(ctx, { type: "CONFIRM", actionId: p1!.actionId });
      expect(r3[0].text).toMatch(/^✓ Đã ghi đơn bán BH-\d{4}-\d{4}/);
      const [sale] = await tx<{ id: string; channel: string; customer: string; phone: string; price: string; status: string; warranty: string | null }[]>`
        SELECT s.id::text, s.channel::text, c.full_name AS customer, c.phone, si.price_vnd::text AS price, s.status::text, si.warranty_until::text AS warranty
          FROM sales s JOIN customers c ON c.id = s.customer_id JOIN sale_items si ON si.sale_id = s.id ORDER BY s.created_at DESC LIMIT 1`;
      expect(sale).toMatchObject({ channel: "ZALO", customer: "Chị Lan", phone: "0901234567", price: "7000000", status: "COMPLETED" });
      expect(sale.warranty).not.toBeNull();
      expect((await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM sales`)[0].n).toBe(before + 1);

      // bấm lần 2 / gõ "ok" → không ghi thêm
      const r4 = await handleEvent(ctx, { type: "CONFIRM", actionId: p1!.actionId });
      expect(r4[0].text).toContain("đã ghi rồi");
      expect((await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM sales`)[0].n).toBe(before + 1);

      // nhật ký: phiếu trợ lý + đơn bán không chứa tên / SĐT
      const logs = await tx<{ j: string }[]>`
        SELECT COALESCE(after::text, '') AS j FROM audit_logs WHERE (entity_type = 'assistant_action' AND entity_id = ${p1!.actionId}) OR (entity_type = 'sale' AND entity_id = ${sale.id})`;
      expect(logs.length).toBe(2);
      for (const l of logs) {
        expect(l.j).not.toContain("Lan");
        expect(l.j).not.toContain("0901234567");
      }
      // thẻ trong lịch sử hiện trạng thái đã ghi + link
      const msgs = await listMessages(tx, ctx.conversationId);
      const card = msgs.flatMap((m) => m.reply?.cards ?? []).find((c): c is PreviewCard => c.kind === "preview");
      expect(card?.status).toBe("CONFIRMED");
      expect(card?.result?.href).toBe(`/ban-hang/${sale.id}`);
    });
  });

  it('gõ "ok" xác nhận phiếu đang chờ; "huỷ" thì không ghi', async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const before = (await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM cash_transactions WHERE category_code = 'OPEX_ADS'`)[0].n;
      const p = previewOf(await handleMessage(ctx, "chi quảng cáo fb 2tr hôm qua"));
      expect(row(p, "Danh mục")).toBe("Chi · Quảng cáo");
      expect(row(p, "Số tiền")).toBe("2.000.000 đ");
      await handleMessage(ctx, "huỷ");
      expect((await tx<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM cash_transactions WHERE category_code = 'OPEX_ADS'`)[0].n).toBe(before);

      previewOf(await handleMessage(ctx, "chi quảng cáo fb 2tr hôm qua"));
      const [ok] = await handleMessage(ctx, "ok");
      expect(ok.text).toContain("✓ Đã ghi 2.000.000 đ");
      const [t] = await tx<{ amount: string; day: string }[]>`
        SELECT amount_vnd::text AS amount, to_char(occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI') AS day
          FROM cash_transactions WHERE category_code = 'OPEX_ADS' ORDER BY created_at DESC LIMIT 1`;
      expect(t).toEqual({ amount: "2000000", day: `${addDays(TODAY, -1)} 12:00` });
    });
  });

  it("máy chưa có trong hệ thống → vào bảng kê nháp; sửa dòng rồi Ghi thật → phiếu xác nhận", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const [r] = await handleMessage(ctx, "bán 356789012345672 cho anh Nam 20tr");
      expect(r.text).toContain("Bảng kê nháp");
      const rows = await listBangKe(tx);
      const bk = rows.find((x) => x.code === "356789012345672");
      expect(bk).toMatchObject({ kind: "SALE", priceText: "20000000", customerText: "Anh Nam" });
      await saveBangKe(tx, bk!.id, { kind: "SALE", code: AIRPODS, priceText: "6tr", customerText: "Anh Nam", occurredOn: TODAY });
      const out = await promoteBangKe(ctx, bk!.id);
      const p = previewOf(out);
      expect(p, JSON.stringify(out)).toBeDefined();
      expect(row(p, "Giá bán")).toBe("6.000.000 đ");
      await handleEvent(ctx, { type: "CONFIRM", actionId: p!.actionId });
      const after = (await listBangKe(tx, { status: "ALL" })).find((x) => x.id === bk!.id);
      expect(after?.status).toBe("PROMOTED");
      expect(after?.promotedHref).toMatch(/^\/ban-hang\//);
    });
  });

  it("chặn ghi lùi ngày bán trước khi máy về SG; ngày tương lai bị chặn", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const p = previewOf(await handleMessage(ctx, `bán serial ${AIRPODS} 6tr ngày 01/10/2026`));
      expect(p!.blockers.join(" ")).toContain("về SG ngày 20/10/2026");
      const p2 = previewOf(await handleMessage(ctx, "sửa ngày 31/12/2099"));
      expect(p2!.blockers.join(" ")).toContain("tương lai");
      const r = await handleEvent(ctx, { type: "CONFIRM", actionId: p!.actionId });
      expect(r[0].text).toContain("Chưa ghi được");
    });
  });

  it("hỏi lại khi thiếu giá; trả lời số tiền trơn điền vào phiếu", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const [r] = await handleMessage(ctx, `bán serial ${AIRPODS} cho khách lẻ`);
      expect(r.text).toContain("Giá bán");
      const p = previewOf(await handleMessage(ctx, "6tr2"));
      expect(row(p, "Giá bán")).toBe("6.200.000 đ");
      expect(p!.blockers).toEqual([]);
    });
  });

  it("nhập máy vào đơn mua (USD) qua phiếu", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const b = await createBatch(tx, { code: "CH-2026-901", name: null, plannedFxRate: null, note: null });
      const po = validate(purchaseOrderSchema, {
        supplierId: SUPPLIER,
        orderNumber: "W1",
        orderedAt: TODAY,
        currency: "USD",
        subtotal: "199.00",
        fxRate: "26.350",
      });
      if (!po.ok) throw new Error(JSON.stringify(po.errors));
      await savePurchaseOrder(tx, b.id, null, po.data);
      const p = previewOf(await handleMessage(ctx, "nhập máy airpods pro $199 vào CH-2026-901 serial F2LXK1ABCD12"));
      expect(p, "phiếu nhập").toBeDefined();
      expect(p!.blockers).toEqual([]);
      expect(row(p, "Đơn giá")).toBe("$199.00");
      await handleMessage(ctx, "ok");
      const [it] = await tx<{ serial: string; price: string }[]>`SELECT serial_number AS serial, unit_price::text AS price FROM items WHERE serial_number = 'F2LXK1ABCD12'`;
      expect(it).toEqual({ serial: "F2LXK1ABCD12", price: "199.00" });
    });
  });

  it("ẩn danh hoá khách: làm sạch tin nhắn, phiếu, bảng kê có tên khách", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      const p = previewOf(await handleMessage(ctx, `bán serial ${AIRPODS} cho chị Mai 0912345678 6tr`));
      await handleEvent(ctx, { type: "CONFIRM", actionId: p!.actionId });
      const [c] = await tx<{ id: string }[]>`SELECT id::text FROM customers WHERE phone = '0912345678'`;
      await addBangKe(tx, { kind: "SALE", occurredOn: null, modelText: null, code: null, priceText: null, customerText: "Chị Mai", customerPhone: "0912345678", channel: null, payment: null, refText: null, note: null }, { customerId: c.id, rawText: "chị Mai 0912345678" });
      await anonymizeCustomer(tx, c.id, "Khách yêu cầu xoá");
      const msgs = await tx<{ text: string; reply: string | null }[]>`SELECT text, reply::text FROM chat_messages WHERE conversation_id = ${ctx.conversationId}`;
      for (const m of msgs) {
        expect(m.text).not.toContain("0912345678");
        expect(m.reply ?? "").not.toContain("0912345678");
      }
      const acts = await tx<{ j: string }[]>`SELECT payload::text AS j FROM chat_actions WHERE customer_id = ${c.id}`;
      for (const a of acts) expect(a.j).not.toContain("0912345678");
      const bk = await tx<{ t: string | null; p: string | null; r: string | null }[]>`SELECT customer_text AS t, customer_phone AS p, raw_text AS r FROM bang_ke_nhap WHERE customer_id = ${c.id}`;
      expect(bk).toEqual([{ t: null, p: null, r: null }]);
    });
  });

  it("xoá tin nhắn quá hạn lưu", async () => {
    await inTx(async (tx) => {
      const ctx = await ctxOf(tx);
      await handleMessage(ctx, "tồn kho");
      await tx`UPDATE chat_messages SET created_at = now() - interval '100 days' WHERE conversation_id = ${ctx.conversationId}`;
      const r = await purgeOld(tx, 90);
      expect(r.messages).toBeGreaterThanOrEqual(2);
    });
  });

  it("xuất bảng kê: đủ 5 sheet, dòng bán có ngày + tiền là số", async () => {
    await inTx(async (tx) => {
      const r = parseRange({ tu: "2026-10-01", den: "2026-10-31" }, TODAY);
      const out = await exportBangKe(tx, r, TODAY);
      expect(out.filename).toBe("ipre-bang-ke-2026-10-01_2026-10-31.xlsx");
      expect(out.sheets.map((s) => s.name)).toEqual(["Bảng kê bán", "Bảng kê nhập", "Thu chi", "Tồn kho", "Bảng kê nháp"]);
      const sale = out.sheets[0];
      expect(sale.rows.length).toBe(2);
      expect(sale.rows[0][0]).toBe("2026-10-23");
      expect(typeof sale.rows[0][6]).toBe("bigint");
    });
  });
});
