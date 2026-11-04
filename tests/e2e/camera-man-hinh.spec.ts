/**
 * Dạng 1: camera hướng vào màn hình Cài đặt › Giới thiệu của một iPhone khác (giao diện tiếng Việt,
 * ám màu, hơi mờ) → tự đọc chữ IMEI, IMEI2, Số sê-ri, Số kiểu máy — không bấm nút.
 */
import { expect, test } from "@playwright/test";
import { SAMPLE } from "./fixtures";
import { login } from "./helpers";

test.setTimeout(150_000);

test("dạng 1 — camera tự đọc IMEI/Serial trên màn hình máy, không cần bấm nút", async ({ page }) => {
  await login(page, "/quet-ma");
  await expect(page.getByText("Sẵn sàng", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /Màn hình máy/ }).click();
  await page.getByRole("button", { name: "Bật camera quét" }).click();
  await expect(page.getByText(/tự đọc màn hình|Đang đọc chữ/)).toBeVisible();

  const card = page.locator("article.sc-card").first();
  await expect(card.getByLabel(/^IMEI 1/)).toHaveValue(SAMPLE.imei1, { timeout: 120_000 });
  await expect(card.getByLabel(/^IMEI 2/)).toHaveValue(SAMPLE.imei2, { timeout: 30_000 });
  await expect(card.getByLabel(/^Serial/)).toHaveValue(SAMPLE.serial, { timeout: 30_000 });
  await expect(card.getByText("Aa Đọc chữ").first()).toBeVisible();
  // Đọc lại liên tục cùng một màn hình không sinh máy trùng
  await page.waitForTimeout(4000);
  await expect(page.locator("article.sc-card")).toHaveCount(1);
});
