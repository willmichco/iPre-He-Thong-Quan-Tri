import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Quét nhãn mẫu trên trang Quét mã → gửi vào hộp chờ → duyệt (soát, sửa) → bỏ (dọn để không ảnh hưởng kiểm thử khác). */
test("quét → gửi vào hộp chờ duyệt → soát từng dòng → sửa → bỏ", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "/quet-ma");
  await page.getByRole("tab", { name: /Ảnh/ }).click();
  await expect(page.getByText("Sẵn sàng", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Thử với nhãn mẫu" }).click();
  await expect(page.getByText(/→ 2 máy mới/)).toBeVisible();

  await page.getByRole("button", { name: "Gửi vào hộp chờ duyệt (2)" }).click();
  await expect(page.getByText("Đã gửi 2 máy vào hộp chờ duyệt")).toBeVisible();
  await page.getByRole("button", { name: "Gửi vào hộp chờ duyệt (2)" }).click(); // gửi lại: không trùng
  await expect(page.getByText(/bỏ qua 2 máy đã gửi trước đó/)).toBeVisible();

  await page.goto("/quet-ma");
  await expect(page.getByTestId("inbox-link")).toHaveText("Hộp chờ duyệt (2) →");
  await page.getByTestId("inbox-link").click();
  await expect(page.getByRole("heading", { name: /Hộp chờ duyệt/ })).toBeVisible();
  const rows = page.getByTestId("inbox-row");
  await expect(rows).toHaveCount(2);
  const iphone = rows.filter({ hasText: "F2LXQ7Y9KD" });
  await expect(iphone).toHaveAttribute("data-level", "OK");
  await expect(iphone).toContainText("iPhone Pro Max · 256GB · Silver");
  await expect(iphone).toContainText("350000000000006 đã có trong hệ thống"); // IMEI trùng máy ví dụ
  const ipad = rows.filter({ hasText: "C02XL0GTJGH5" });
  await expect(ipad).toHaveAttribute("data-level", "WARN");
  await expect(ipad).toContainText("Không phải hàng thị trường LL/A");

  // sửa Serial dòng iPad (nguồn thành ✍ tay)
  await ipad.getByText("Sửa").click();
  const edit = ipad.getByRole("form");
  await edit.getByLabel("Serial").fill("c02xl0gtjgh6");
  await edit.getByRole("button", { name: "Lưu" }).click();
  await expect(rows.filter({ hasText: "C02XL0GTJGH6" })).toContainText("✍");

  // bỏ cả hai (dòng không lỗi đã được chọn sẵn)
  await page.getByRole("button", { name: "Bỏ dòng đã chọn" }).click();
  await expect(page.getByText("Hộp chờ trống.")).toBeVisible();
});
