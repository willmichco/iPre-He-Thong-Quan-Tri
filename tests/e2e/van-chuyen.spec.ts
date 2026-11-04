import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { login } from "./helpers";

/**
 * Kiện 3 chặng với CSDL thật. Chuẩn bị máy bằng SQL (chuyến thử riêng cho mỗi lần chạy), thao tác qua giao diện,
 * dọn sạch ở cuối.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử Vận chuyển cần DATABASE_URL (CSDL đã nạp db/seed-vi-du.sql) để chuẩn bị máy thử");

function randomImei() {
  const d = ["35", ...Array.from({ length: 12 }, () => String(Math.floor(Math.random() * 10)))].join("");
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let x = Number(d[i]);
    if (i % 2 === 1) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return d + String((10 - (sum % 10)) % 10);
}

test("tạo kiện → quét máy → Gửi đi → Đã nhận: mốc & trạng thái cho mọi máy; trễ hạn; giữ hải quan", async ({ page }, info) => {
  page.on("dialog", (d) => d.accept());
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const tag = `${Date.now().toString(36).toUpperCase().slice(-5)}${info.project.name === "iphone" ? "I" : "D"}`;
  const imeis = [randomImei(), randomImei()];
  const tracking = `TRK${tag}`;
  const [batch] = await sql<{ id: string }[]>`INSERT INTO batches (code, status) VALUES (${`CH-VC-${tag}`}, 'PURCHASING') RETURNING id::text`;
  try {
    const [po] = await sql<{ id: string }[]>`
      INSERT INTO purchase_orders (batch_id, supplier_id, ordered_at, subtotal, fx_rate)
      VALUES (${batch.id}, '30000000-0000-0000-0000-000000000001', now() - interval '10 days', 2000, 25000) RETURNING id::text`;
    for (const imei of imeis)
      await sql`
        INSERT INTO items (batch_id, purchase_order_id, variant_id, imei1, unit_price)
        VALUES (${batch.id}, ${po.id}, '20000000-0000-0000-0000-000000000001', ${imei}, 1000)`;

    await login(page, "/van-chuyen");
    await expect(page.getByRole("heading", { name: "Vận chuyển", level: 1 })).toBeVisible();
    await page.getByText("+ Tạo kiện").click();
    const form = page.getByRole("form", { name: "Tạo kiện" });
    await form.getByLabel("Chặng *").selectOption("US_TO_VN");
    await form.getByLabel("Đơn vị vận chuyển").selectOption({ label: "Forwarder A" });
    await form.getByLabel("Mã vận đơn (tracking)").fill(tracking.toLowerCase());
    await form.getByLabel("Ngày dự kiến nhận").fill("2026-01-05"); // đã qua → trễ hạn khi đang đi
    await form.getByRole("button", { name: "Tạo kiện" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(tracking);
    await expect(page.getByTestId("shipment-status")).toHaveText("Chờ gửi");

    // chưa có máy → không gửi được
    await page.getByRole("button", { name: "Gửi đi" }).click();
    await expect(page.getByRole("form", { name: "Gửi đi" }).getByRole("alert")).toContainText("chưa có máy");

    // quét: IMEI 1 + Enter (máy quét USB), rồi dán IMEI 2 kèm 1 mã lạ
    const scan = page.getByRole("form", { name: "Quét máy vào kiện" });
    const box = scan.getByLabel(/Serial \/ IMEI/);
    await box.fill(imeis[0]);
    await box.press("Enter");
    await expect(scan.getByRole("status")).toContainText("Đã thêm 1 máy vào kiện");
    await expect(box).toHaveValue("");
    await box.fill(`${imeis[1]}\nKHONGCOMA1`);
    await scan.getByRole("button", { name: "Thêm vào kiện" }).click();
    await expect(scan.getByRole("status")).toContainText("Đã thêm 1 máy vào kiện · ⚠ KHONGCOMA1: Không có máy nào");
    await expect(page.getByRole("table", { name: "Máy trong kiện" }).getByRole("row")).toHaveCount(3);

    await page
      .getByRole("form", { name: "Gửi đi" })
      .getByLabel(/Ngày giờ gửi/)
      .fill("2026-01-01T10:00");
    await page.getByRole("button", { name: "Gửi đi" }).click();
    await expect(page.getByTestId("shipment-status")).toHaveText("Đang đi");
    await expect(page.getByText(/trễ \d+ ngày so với dự kiến/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Máy trong kiện" })).toContainText("Mỹ → VN");

    // bảng tiến độ: thẻ nằm ở cột ② Mỹ → VN, tô đỏ trễ hạn
    await page.goto("/van-chuyen");
    const card = page.getByRole("listitem", { name: "② Mỹ → VN" }).getByRole("link", { name: `Kiện ${tracking}` });
    await expect(card).toContainText("2 máy");
    await expect(card).toContainText(/trễ \d+ ngày/);
    await card.click();

    await page.getByRole("button", { name: "Giữ hải quan" }).click();
    await expect(page.getByTestId("shipment-status")).toHaveText("Giữ hải quan");
    await page
      .getByRole("form", { name: "Đã nhận" })
      .getByLabel(/Ngày giờ nhận/)
      .fill("2026-01-09T09:00");
    await page.getByRole("button", { name: "Đã nhận" }).click();
    await expect(page.getByTestId("shipment-status")).toHaveText("Đã nhận");
    await expect(page.getByRole("table", { name: "Máy trong kiện" }).getByRole("row").nth(1)).toContainText("Tại HN");

    const events = await sql<{ e: string; n: number }[]>`
      SELECT e.event_type::text AS e, COUNT(*)::int AS n FROM item_events e JOIN items i ON i.id = e.item_id
       WHERE i.batch_id = ${batch.id} GROUP BY 1 ORDER BY 1`;
    expect(events).toEqual([
      { e: "HN_ARRIVED", n: 2 },
      { e: "INTL_DEPARTED", n: 2 },
    ]);
  } finally {
    const items = sql`SELECT id FROM items WHERE batch_id = ${batch.id}`;
    await sql`DELETE FROM item_events WHERE item_id IN (${items})`;
    await sql`DELETE FROM item_cost_allocations WHERE item_id IN (${items})`;
    await sql`DELETE FROM shipment_tracking_events WHERE shipment_id IN (SELECT shipment_id FROM shipment_items WHERE item_id IN (${items}))`;
    await sql`DELETE FROM shipments WHERE id IN (SELECT shipment_id FROM shipment_items WHERE item_id IN (${items}))`;
    await sql`DELETE FROM shipments WHERE tracking_number = ${tracking}`;
    await sql`DELETE FROM items WHERE batch_id = ${batch.id}`;
    await sql`DELETE FROM purchase_orders WHERE batch_id = ${batch.id}`;
    await sql`DELETE FROM batches WHERE id = ${batch.id}`;
    await sql.end();
  }
});
