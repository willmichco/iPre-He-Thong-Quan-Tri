import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { login } from "./helpers";

/**
 * Nhận kiện bằng quét đối chiếu (tài liệu 07 mục 5.1): kiện HN → SG đang đi có 3 máy (chuẩn bị bằng SQL), quét 2 máy + 1 mã lạ
 * → thiếu thì bị chặn cho tới khi xác nhận → nhận phần đã quét, ghi sự cố → nhận bổ sung máy thiếu. Dọn sạch ở cuối.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử Nhận kiện cần DATABASE_URL (CSDL đã nạp db/seed-vi-du.sql)");

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

test("nhận kiện bằng quét: 2/3 máy → chặn → nhận phần đã quét + sự cố thiếu → nhận bổ sung", async ({ page }, info) => {
  test.setTimeout(90_000);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const tag = `${Date.now().toString(36).toUpperCase().slice(-5)}${info.project.name === "iphone" ? "I" : "D"}`;
  const imeis = [randomImei(), randomImei(), randomImei()];
  const tracking = `NK${tag}`;
  const [batch] = await sql<{ id: string }[]>`INSERT INTO batches (code, status) VALUES (${`CH-NK-${tag}`}, 'IN_TRANSIT') RETURNING id::text`;
  try {
    const [po] = await sql<{ id: string }[]>`
      INSERT INTO purchase_orders (batch_id, supplier_id, ordered_at, subtotal, fx_rate)
      VALUES (${batch.id}, '30000000-0000-0000-0000-000000000001', now() - interval '10 days', 3000, 25000) RETURNING id::text`;
    const [sh] = await sql<{ id: string }[]>`
      INSERT INTO shipments (leg_type, tracking_number, status, shipped_at) VALUES ('HN_TO_SG', ${tracking}, 'IN_TRANSIT', now() - interval '2 days')
      RETURNING id::text`;
    for (const imei of imeis) {
      const [it] = await sql<{ id: string }[]>`
        INSERT INTO items (batch_id, purchase_order_id, variant_id, imei1, unit_price, status)
        VALUES (${batch.id}, ${po.id}, '20000000-0000-0000-0000-000000000001', ${imei}, 1000, 'DOMESTIC_IN_TRANSIT') RETURNING id::text`;
      await sql`INSERT INTO shipment_items (shipment_id, leg_type, item_id) VALUES (${sh.id}, 'HN_TO_SG', ${it.id})`;
    }

    await login(page, "/van-chuyen");
    await page.goto(`/van-chuyen/${sh.id}`);
    await page.getByRole("link", { name: "Nhận bằng quét đối chiếu" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Nhận kiện ${tracking}`);
    const progress = page.getByTestId("receive-progress");
    await expect(progress).toContainText("Đã quét 0/3 máy · còn thiếu 3");

    await page.getByRole("tab", { name: /Nhập tay/ }).click();
    const box = page.getByPlaceholder("IMEI, Serial hoặc Part No.");
    await box.fill(imeis[0]); // IMEI hợp lệ đủ 15 số → tự thêm
    await box.fill(imeis[2]);
    await box.fill("KHONGCO7X9");
    await box.press("Enter");
    await expect(progress).toContainText("Đã quét 2/3 máy · còn thiếu 1");
    await expect(progress).toContainText("1 mã ngoài kiện");
    const list = page.getByRole("list", { name: "Danh sách đối chiếu" });
    await expect(list.locator('[data-state="ok"]')).toHaveCount(2);
    await expect(list.locator('[data-state="missing"]')).toContainText(imeis[1]);
    await expect(list.locator('[data-state="outside"]')).toContainText("KHONGCO7X9");

    const form = page.getByRole("form", { name: "Xác nhận nhận kiện" });
    await form.getByRole("button", { name: "Xác nhận nhận 2/3 máy" }).click();
    await expect(form.getByRole("alert")).toContainText("Còn thiếu 1 máy chưa quét");
    await form.getByLabel(/Nhận phần đã quét \(2 máy\)/).check();
    await form.getByRole("button", { name: "Xác nhận nhận 2/3 máy" }).click();

    await expect(page).toHaveURL(new RegExp(`/van-chuyen/${sh.id}\\?nhan=1$`));
    await expect(page.getByTestId("shipment-status")).toHaveText("Đã nhận");
    await expect(page.getByRole("status").filter({ hasText: "Đã nhận kiện theo kết quả quét" })).toContainText("thiếu 1 máy");
    const incident = page.getByRole("region", { name: /Sự cố thiếu hàng/ });
    await expect(incident).toContainText("1 máy chưa về");
    expect(await page.evaluate((k) => localStorage.getItem(k), `ipre.nhan-kien.${sh.id}`)).toBeNull(); // phiên quét tạm đã dọn

    const st = await sql<{ imei1: string; s: string }[]>`SELECT imei1, status::text AS s FROM items WHERE batch_id = ${batch.id}`;
    expect(Object.fromEntries(st.map((r) => [r.imei1, r.s]))).toEqual({ [imeis[0]]: "IN_STOCK", [imeis[1]]: "DOMESTIC_IN_TRANSIT", [imeis[2]]: "IN_STOCK" });

    await page.goto("/van-chuyen");
    await expect(page.getByRole("note")).toContainText(`kiện ${tracking} (1)`);
    await page
      .getByRole("note")
      .getByRole("link", { name: `kiện ${tracking} (1)` })
      .click();

    await incident.getByRole("button", { name: "Đã tìm thấy — nhận bổ sung" }).click();
    await expect(incident).toBeHidden();
    const [late] = await sql<{ s: string }[]>`SELECT status::text AS s FROM items WHERE imei1 = ${imeis[1]}`;
    expect(late.s).toBe("IN_STOCK");
  } finally {
    const items = sql`SELECT id FROM items WHERE batch_id = ${batch.id}`;
    await sql`DELETE FROM item_events WHERE item_id IN (${items})`;
    await sql`DELETE FROM item_cost_allocations WHERE item_id IN (${items})`;
    await sql`DELETE FROM shipment_tracking_events WHERE shipment_id IN (SELECT id FROM shipments WHERE tracking_number = ${tracking})`;
    await sql`DELETE FROM shipments WHERE tracking_number = ${tracking}`;
    await sql`DELETE FROM items WHERE batch_id = ${batch.id}`;
    await sql`DELETE FROM purchase_orders WHERE batch_id = ${batch.id}`;
    await sql`DELETE FROM batches WHERE id = ${batch.id}`;
    await sql.end();
  }
});
