import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { login } from "./helpers";

/**
 * Bán hàng trên dữ liệu ví dụ: AirPods (SERIALAIRPODS1) đang tồn ở SG. Mỗi ca tự dọn: xoá đơn bán / khách tạo
 * trong ca, trả AirPods về "Tồn kho SG".
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử Bán hàng cần DATABASE_URL (CSDL đã nạp db/seed-vi-du.sql)");
const AIRPODS = "80000000-0000-0000-0000-000000000003";
let startedAt = new Date();

test.beforeEach(() => {
  startedAt = new Date();
});
test.afterEach(async () => {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const sales = sql`SELECT id FROM sales WHERE created_at >= ${startedAt}`;
    await sql`DELETE FROM cash_transactions WHERE sale_id IN (${sales})`;
    await sql`DELETE FROM item_events WHERE sale_id IN (${sales})`;
    await sql`DELETE FROM sale_expenses WHERE sale_id IN (${sales})`;
    await sql`DELETE FROM sale_items WHERE sale_id IN (${sales})`;
    await sql`DELETE FROM sales WHERE created_at >= ${startedAt}`;
    await sql`DELETE FROM customers WHERE created_at >= ${startedAt}`;
    await sql`DELETE FROM item_events WHERE item_id = ${AIRPODS} AND event_type = 'RETURNED_BY_CUSTOMER' AND created_at >= ${startedAt}`;
    await sql`UPDATE items SET status = 'IN_STOCK' WHERE id = ${AIRPODS}`;
  } finally {
    await sql.end();
  }
});

test("kho → hồ sơ máy → Bán máy này → gõ giá 7,5tr → thấy lãi ngay → xác nhận bán → khách trả lại", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await login(page, "/kho");
  // trống ô tìm: danh sách máy đang tồn ở SG
  await page.getByRole("table", { name: "Danh sách máy" }).getByRole("link", { name: "AirPods Pro · White" }).click();
  await expect(page.getByTestId("item-status")).toHaveText("Tồn kho SG");
  await expect(page.getByRole("heading", { name: /Giá vốn về tay: 6\.979\.336/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Mốc thời gian" })).toContainText("M7 · Nhận tại SG");
  await page.getByRole("link", { name: "Bán máy này" }).click();

  // màn hình bán: máy đã được thêm sẵn
  const card = page.getByRole("article", { name: "Máy SERIALAIRPODS1" });
  await expect(card).toContainText("6.979.336 ₫");
  await card.getByLabel("Giá bán *").fill("7,5tr");
  await expect(card.getByText("= 7.500.000 ₫")).toBeVisible();
  await page.getByLabel("Ship khách").fill("30k");
  // 7.500.000 − 6.979.336 − 30.000 = 490.664
  await expect(page.getByTestId("sale-profit")).toHaveText("+490.664 ₫");
  await page.getByLabel("SĐT khách").fill("0909 111 222");
  await page.getByLabel("Tên khách").fill("Khách kiểm thử");
  await page.getByRole("radio", { name: "Zalo" }).click();
  await page.getByRole("button", { name: "Xác nhận bán" }).click();

  await expect(page).toHaveURL(/\/ban-hang\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("sale-status")).toHaveText("Hoàn tất");
  await expect(page.getByTestId("sale-detail-profit")).toHaveText("490.664 ₫");
  await expect(page.getByTestId("balance")).toHaveText("0 ₫");
  await expect(page.getByText("Khách: Khách kiểm thử · 0909111222")).toBeVisible();

  // bán rồi thì không bán lại được
  await page.goto("/ban-hang/moi");
  await page.getByLabel("Quét / gõ IMEI hoặc Serial").fill("serialairpods1");
  await page.getByLabel("Quét / gõ IMEI hoặc Serial").press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: /Đã bán ở đơn BH-/ })).toBeVisible();

  // khách trả lại → máy về tồn kho
  await page.goBack();
  await page.getByText("Khách trả lại máy này").click();
  const ret = page.getByRole("form", { name: "Khách trả lại SERIALAIRPODS1" });
  await ret.getByLabel("Lý do *").fill("Không vừa tai");
  await ret.getByLabel("Hoàn tiền").fill("7,5tr");
  await ret.getByLabel("Hoàn từ tài khoản").selectOption({ label: "Ngân hàng chính" });
  await ret.getByRole("button", { name: "Ghi nhận trả lại" }).click();
  await expect(page.getByTestId("sale-status")).toHaveText("Đã huỷ");
  await page.goto(`/kho/${AIRPODS}`);
  await expect(page.getByTestId("item-status")).toHaveText("Tồn kho SG");
  await expect(page.getByRole("list", { name: "Mốc thời gian" })).toContainText("Khách trả lại");
});

test("bán dưới giá vốn phải xác nhận; mã lạ báo rõ; nhận cọc", async ({ page }) => {
  await login(page, "/ban-hang/moi");
  const scan = page.getByLabel("Quét / gõ IMEI hoặc Serial");
  await scan.fill("KHONGCOMA");
  await scan.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: 'Không tìm thấy máy có Serial / IMEI "KHONGCOMA"' })).toBeVisible();
  await scan.fill("SERIALAIRPODS1");
  await scan.press("Enter");
  const card = page.getByRole("article", { name: "Máy SERIALAIRPODS1" });
  await card.getByLabel("Giá bán *").fill("6tr");
  await expect(card.getByTestId("line-profit")).toContainText("⚠ dưới giá vốn");
  await page.getByRole("button", { name: "Xác nhận bán" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "thấp hơn giá vốn" })).toBeVisible();

  // chuyển sang nhận cọc 1tr
  await page.getByRole("radio", { name: "Cọc" }).click();
  await page.getByLabel("Tiền cọc *").fill("1tr");
  await page.getByLabel("SĐT khách").fill("0909333444");
  await page.getByRole("button", { name: "Xác nhận nhận cọc" }).click();
  await expect(page.getByTestId("sale-status")).toHaveText("Đã cọc");
  await expect(page.getByTestId("balance")).toHaveText("5.000.000 ₫");
  await page.goto(`/kho/${AIRPODS}`);
  await expect(page.getByTestId("item-status")).toHaveText("Khách cọc");
});
