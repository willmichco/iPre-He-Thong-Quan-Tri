import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { login } from "./helpers";

/**
 * Trợ lý nhập liệu trên dữ liệu ví dụ: AirPods (SERIALAIRPODS1) đang tồn ở SG. Mỗi ca tự dọn: xoá đơn bán / khách / phiếu /
 * bảng kê / tin nhắn tạo trong ca, trả AirPods về "Tồn kho SG".
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử Trợ lý cần DATABASE_URL (CSDL đã nạp db/seed-vi-du.sql)");
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
    await sql`DELETE FROM chat_actions WHERE created_at >= ${startedAt}`;
    await sql`DELETE FROM bang_ke_nhap WHERE created_at >= ${startedAt}`;
    await sql`DELETE FROM chat_messages WHERE created_at >= ${startedAt}`;
    await sql`DELETE FROM customers WHERE created_at >= ${startedAt}`;
    await sql`UPDATE items SET status = 'IN_STOCK' WHERE id = ${AIRPODS}`;
  } finally {
    await sql.end();
  }
});

async function say(page: Page, text: string) {
  const before = await page.getByTestId("msg-bot").count();
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-input").press("Enter");
  await expect(page.getByTestId("msg-bot")).toHaveCount(before + 1);
  // chỉ số cố định: .last() là bộ chọn "lười", sẽ trỏ sang tin mới hơn về sau
  return page.getByTestId("msg-bot").nth(before);
}

test("hỏi tồn kho → bán qua phiếu → sửa giá → xác nhận → mở đơn bán thấy đúng giá", async ({ page }) => {
  await login(page, "/tro-ly");
  const stock = await say(page, "tồn kho");
  await expect(stock).toContainText("1 máy sẵn bán");
  await expect(stock.getByTestId("stat-card")).toBeVisible();

  const first = await say(page, "bán serial SERIALAIRPODS1 cho chị Lan 0901 234 567 6tr5 zalo ck");
  const card1 = first.getByTestId("preview-card");
  await expect(card1.getByTestId("row-Giá bán")).toHaveText("6.500.000 đ");
  await expect(card1.getByTestId("row-Khách")).toContainText("Chị Lan · 0901234567");
  await expect(card1.getByTestId("preview-profit")).toContainText("Lãi dự kiến");

  // sửa bằng nút "Sửa" trên phiếu
  await card1.getByTestId("btn-edit").click();
  await card1.getByTestId("edit-input").fill("giá 7tr");
  await card1.getByTestId("edit-input").press("Enter");
  await expect(page.getByTestId("preview-card")).toHaveCount(2);
  const card2 = page.getByTestId("preview-card").nth(1);
  await expect(card2.getByTestId("row-Giá bán")).toHaveText("7.000.000 đ");
  await expect(card1.getByTestId("preview-status")).toHaveText("Bản cũ — đã sửa bên dưới");

  await card2.getByTestId("btn-confirm").click();
  const done = page.getByTestId("msg-bot").last();
  await expect(done).toContainText(/✓ Đã ghi đơn bán BH-\d{4}-\d{4}/);
  await expect(card2.getByTestId("preview-status")).toHaveText("Đã ghi");
  await done.getByRole("link", { name: "Mở bản ghi vừa tạo" }).click();
  await expect(page).toHaveURL(/\/ban-hang\/[0-9a-f-]{36}$/);
  await expect(page.getByText("7.000.000").first()).toBeVisible();
});

test("máy chưa có → Bảng kê nháp → sửa mã máy → Ghi thật → xác nhận trong chat", async ({ page }) => {
  await login(page, "/tro-ly");
  const r = await say(page, "bán 356789012345672 cho anh Nam 6tr");
  await expect(r).toContainText("Bảng kê nháp");
  await page.getByTestId("link-bang-ke").click();
  const row = page.getByTestId("bang-ke-row").filter({ hasText: "356789012345672" });
  await row.getByLabel("IMEI / Serial").fill("SERIALAIRPODS1");
  await row.getByTestId("bk-promote").click();
  await expect(page).toHaveURL(/\/tro-ly$/);
  await expect(page.getByTestId("preview-card")).toHaveCount(1);
  const card = page.getByTestId("preview-card").first();
  await expect(card.getByTestId("row-Giá bán")).toHaveText("6.000.000 đ");
  await card.getByTestId("btn-confirm").click();
  await expect(page.getByTestId("msg-bot").last()).toContainText("✓ Đã ghi đơn bán");
  await page.goto("/tro-ly/bang-ke?tt=PROMOTED");
  await expect(page.getByRole("link", { name: "Mở bản ghi →" }).first()).toBeVisible();
});

test("xuất bảng kê Excel từ câu nhắn", async ({ page }) => {
  await login(page, "/tro-ly");
  const r = await say(page, "xuất excel tháng này");
  const [download] = await Promise.all([page.waitForEvent("download"), r.getByTestId("bot-download").click()]);
  expect(download.suggestedFilename()).toMatch(/^ipre-bang-ke-\d{4}-\d{2}\.xlsx$/);
});

test("điện thoại: ô nhập không bị thanh điều hướng dưới che", async ({ page, isMobile }) => {
  test.skip(!isMobile, "chỉ kiểm trên điện thoại");
  await login(page, "/tro-ly");
  const input = await page.getByTestId("chat-input").boundingBox();
  const nav = await page.getByRole("navigation", { name: "Điều hướng nhanh" }).boundingBox();
  expect(input && nav).toBeTruthy();
  expect(input!.y + input!.height).toBeLessThanOrEqual(nav!.y);
});
