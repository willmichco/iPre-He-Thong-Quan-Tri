/**
 * Dạng 1: camera hướng vào màn hình Cài đặt › Giới thiệu của một iPhone khác (tiếng Việt, chế độ tối,
 * ám màu, TAY RUNG: 12/30 khung lệch & nhòe) → tự tìm vùng chữ, chờ yên, tự chụp, đọc, bỏ phiếu — không bấm nút.
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
  // Camera đang chạy ở chế độ màn hình. Không chờ riêng chữ "Đang đọc chữ…": mỗi lần đọc chỉ ~0,3 s và đọc xong
  // thì tự dừng, nên trạng thái đó có thể đã qua trước khi kiểm thử kịp thấy (máy CI nhanh).
  await expect(page.getByTestId("scan-status")).toContainText(/Đang tìm vùng chữ|Giữ yên|Đang đọc chữ|Đã đọc|Xong máy này/);

  const card = page.locator("article.sc-card").first();
  await expect(card.getByLabel(/^IMEI 1/)).toHaveValue(SAMPLE.imei1, { timeout: 120_000 });
  await expect(card.getByLabel(/^IMEI 2/)).toHaveValue(SAMPLE.imei2, { timeout: 30_000 });
  // Serial cần 2 lần chụp đọc khớp mới được nhận
  await expect(card.getByLabel(/^Serial/)).toHaveValue(SAMPLE.serial, { timeout: 30_000 });
  await expect(card.getByText("Aa Đọc chữ").first()).toBeVisible();
  await expect(page.getByText(/✓ Serial F2LXQ7Y9KD/)).toBeVisible();
  // Đọc xong → có phát tín hiệu rung "thành công"
  expect(await page.evaluate(() => window.__ipreHaptics?.success ?? 0)).toBeGreaterThanOrEqual(1);
  // Đủ thông tin → camera TỰ DỪNG đọc: không đọc thêm lần nào, không sinh máy trùng, không ghi đè
  await expect(page.getByText("Đã đọc xong máy này")).toBeVisible({ timeout: 10_000 });
  const reads = await page.evaluate(() => window.__ipreOcrTimes?.length ?? 0);
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => window.__ipreOcrTimes?.length ?? 0)).toBe(reads);
  await expect(page.locator("article.sc-card")).toHaveCount(1);
  await expect(card.getByLabel(/^Serial/)).toHaveValue(SAMPLE.serial);
  // "Quét máy tiếp theo" → đọc lại từ đầu (cùng màn hình → vẫn là máy đó, không sinh máy mới)
  await page.getByRole("button", { name: "Quét máy tiếp theo" }).click();
  await expect(page.getByText("Đã đọc xong máy này")).toBeHidden();
  await expect(page.getByText("Đã đọc xong máy này")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("article.sc-card")).toHaveCount(1);
});
