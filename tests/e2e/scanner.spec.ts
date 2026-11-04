import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

async function openPhotoTab(page: Page) {
  await login(page, "/quet-ma");
  await page.getByRole("tab", { name: /Ảnh/ }).click();
  await expect(page.getByText("Sẵn sàng", { exact: true })).toBeVisible();
}

function card(page: Page, n: number) {
  return page.locator("article.sc-card", { hasText: `Máy #${n}` });
}

test("nhãn mẫu: đọc đủ Part No., Serial, IMEI, UPC cho 2 máy và cảnh báo hàng không phải LL/A", async ({ page }) => {
  await openPhotoTab(page);
  await page.getByRole("button", { name: "Thử với nhãn mẫu" }).click();
  await expect(page.getByText(/→ 2 máy mới/)).toBeVisible();

  const iphone = card(page, 1);
  await expect(iphone.getByLabel(/^Serial/)).toHaveValue("F2LXQ7Y9KD");
  await expect(iphone.getByLabel(/^IMEI 1/)).toHaveValue("350000000000006");
  await expect(iphone.getByLabel(/^IMEI 2/)).toHaveValue("350000000000014");
  await expect(iphone.getByLabel(/^Part No/)).toHaveValue("MDEM1LL/A");
  await expect(iphone.getByLabel(/^UPC/)).toHaveValue("012345678905");

  const ipad = card(page, 2);
  await expect(ipad.getByLabel(/^Serial/)).toHaveValue("C02XL0GTJGH5");
  await expect(ipad.getByLabel(/^IMEI 1/)).toHaveValue("490154203237518");
  await expect(ipad).toContainText("không phải hàng LL/A");

  // Quét lại cùng nhãn: không tạo máy trùng
  await page.getByRole("button", { name: "Thử với nhãn mẫu" }).click();
  await expect(page.getByText(/0 máy mới, 2 máy đã có/)).toBeVisible();
  await expect(page.locator("article.sc-card")).toHaveCount(2);
});

test("tải ảnh chụp lên (PNG) → đọc được mã như ảnh từ điện thoại", async ({ page, browser }) => {
  // Tạo "ảnh chụp" của nhãn mẫu bằng một trang riêng
  const shot = await browser.newPage({ viewport: { width: 640, height: 1000 }, deviceScaleFactor: 2 });
  const svgUrl = new URL("/nhan-mau.svg", test.info().project.use.baseURL).toString();
  await shot.setContent(`<body style="margin:0;background:#fff"><img id="nhan" src="${svgUrl}" width="600"></body>`);
  await shot.locator("#nhan").evaluate((img: HTMLImageElement) => img.decode());
  const png = await shot.locator("#nhan").screenshot({ type: "png" });
  await shot.close();

  await openPhotoTab(page);
  await page.getByTestId("photo-input").setInputFiles({ name: "hop-may.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText(/hop-may\.png/).first()).toBeVisible();
  await expect(page.locator("article.sc-card")).toHaveCount(2);
  await expect(card(page, 1).getByLabel(/^IMEI 1/)).toHaveValue("350000000000006");
});

test("dán từ Excel + sửa tay: IMEI sai số kiểm tra bị đánh dấu lỗi", async ({ page }) => {
  await login(page, "/quet-ma");
  await page.getByRole("tab", { name: /Nhập tay/ }).click();
  await page.getByLabel(/Dán danh sách mã/).fill("F2LXQ7Y9KD\t350000000000006\tMDEM1LL/A\nC02XL0GTJGH5, 350000000000014");
  await page.getByRole("button", { name: "Thêm từ văn bản" }).click();
  await expect(page.locator("article.sc-card")).toHaveCount(2);

  const second = card(page, 2);
  const imei = second.getByLabel(/^IMEI 1/);
  await imei.fill("350000000000015");
  await imei.press("Enter");
  await expect(second).toContainText("IMEI sai số kiểm tra");
  await expect(page.getByText(/1 lỗi cần sửa/)).toBeVisible();

  await second.getByLabel(/^IMEI 1/).fill("350000000000014");
  await second.getByLabel(/^IMEI 1/).press("Enter");
  await expect(page.getByText(/lỗi cần sửa/)).toHaveCount(0);

  // Xoá phiên có bước xác nhận ngay trong trang
  await page.getByRole("button", { name: "Xoá phiên" }).click();
  await page.getByRole("button", { name: "Xoá hết" }).click();
  await expect(page.locator("article.sc-card")).toHaveCount(0);
});
