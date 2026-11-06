import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Nhật ký thay đổi: mở từ Cài đặt, lọc theo đối tượng, xem lịch sử một đối tượng từ trang chi tiết. Chỉ đọc. */
test("nhật ký thay đổi: danh sách, lọc, lịch sử của một kiện", async ({ page }) => {
  await login(page, "/cai-dat");
  await page.getByRole("link", { name: "Nhật ký thay đổi →" }).click();
  await expect(page.getByRole("heading", { name: "Nhật ký thay đổi", level: 1 })).toBeVisible();
  await expect(page.getByTestId("audit-row").first()).toBeVisible();

  const filter = page.getByRole("form", { name: "Lọc nhật ký" });
  await filter.getByLabel("Đối tượng", { exact: true }).selectOption({ label: "Kiện" });
  await filter.getByRole("button", { name: "Lọc" }).click();
  await expect(page).toHaveURL(/loai=shipment/);
  const rows = page.getByTestId("audit-row");
  await expect(rows.first()).toBeVisible();
  for (const t of await rows.allInnerTexts()) expect(t).toContain("Kiện");

  // lịch sử một kiện của dữ liệu ví dụ, mở từ trang kiện
  await page.goto("/van-chuyen/90000000-0000-0000-0000-000000000001");
  await page.getByRole("link", { name: "Lịch sử thay đổi" }).click();
  await expect(page).toHaveURL(/\/cai-dat\/nhat-ky\?id=90000000-0000-0000-0000-000000000001/);
  await expect(page.getByText("Đang xem lịch sử của một đối tượng")).toBeVisible();

  // tìm không ra → báo rõ
  await page.goto("/cai-dat/nhat-ky?q=KHONG-CO-DONG-NAO-X9");
  await expect(page.getByText("Không có dòng nào khớp bộ lọc.")).toBeVisible();
});
