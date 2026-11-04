import { expect, test, type Page } from "@playwright/test";
import { aboutScreenshot, SAMPLE } from "./fixtures";
import { login } from "./helpers";

// Lần đầu đọc chữ phải tải bộ OCR (~7 MB) và khởi tạo — cho thêm thời gian
test.setTimeout(120_000);

function card(page: Page, n: number) {
  return page.locator("article.sc-card", { hasText: `Máy #${n}` });
}

async function openTab(page: Page, tab: RegExp) {
  await login(page, "/quet-ma");
  await page.getByRole("tab", { name: tab }).click();
  await expect(page.getByText("Sẵn sàng", { exact: true })).toBeVisible();
}

for (const variant of [
  { lang: "en", dark: true },
  { lang: "vi", dark: false },
] as const) {
  test(`ảnh chụp màn hình Giới thiệu (${variant.lang}, ${variant.dark ? "tối" : "sáng"}) → tự đọc chữ, không cần bấm`, async ({ page, browser }) => {
    const png = await aboutScreenshot(browser, variant);
    await openTab(page, /Ảnh/);
    await page.getByTestId("photo-input").setInputFiles({ name: "gioi-thieu.png", mimeType: "image/png", buffer: png });

    const c = card(page, 1);
    await expect(c.getByLabel(/^IMEI 1/)).toHaveValue(SAMPLE.imei1, { timeout: 90_000 });
    await expect(c.getByLabel(/^IMEI 2/)).toHaveValue(SAMPLE.imei2);
    await expect(c.getByLabel(/^Serial/)).toHaveValue(SAMPLE.serial);
    // Part No. đọc bằng chữ có thể sai 1 ký tự (nhãn "Đọc chữ" nhắc soát lại); IMEI có Luhn, Serial có nhãn neo → phải đúng tuyệt đối
    await expect(c.getByLabel(/^Part No/)).toHaveValue(/^MDEM.?LL\/A$/);
    // Giá trị đọc bằng chữ được đánh dấu để soát lại
    await expect(c.getByText("Aa Đọc chữ").first()).toBeVisible();
    await expect(c).toContainText("soát lại");
  });
}

test("dán ảnh chụp màn hình vào vùng dán → tự nhận diện", async ({ page, browser }) => {
  const png = await aboutScreenshot(browser, { lang: "en", dark: false });
  await openTab(page, /Ảnh/);
  await page.locator(".sc-paste-zone").evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "screenshot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png.toString("base64"));
  await expect(card(page, 1).getByLabel(/^IMEI 1/)).toHaveValue(SAMPLE.imei1, { timeout: 90_000 });
});

test("dán mã dạng chữ → tự thêm ngay, không cần bấm nút", async ({ page }) => {
  await openTab(page, /Nhập tay/);
  await page.getByLabel(/Hoặc dán danh sách/).evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `${SAMPLE.serial}\t${SAMPLE.imei1}\t${SAMPLE.part}`);
  await expect(page.locator("article.sc-card")).toHaveCount(1);
  await expect(card(page, 1).getByLabel(/^Serial/)).toHaveValue(SAMPLE.serial);
  await expect(card(page, 1).getByLabel(/^IMEI 1/)).toHaveValue(SAMPLE.imei1);
});

test("gõ IMEI đủ 15 số hợp lệ → tự thêm, không cần Enter; serial thì Enter", async ({ page }) => {
  await openTab(page, /Nhập tay/);
  const input = page.getByLabel(/Nhập một mã/);
  await input.pressSequentially(SAMPLE.imei1, { delay: 10 });
  await expect(card(page, 1).getByLabel(/^IMEI 1/)).toHaveValue(SAMPLE.imei1);
  await expect(input).toHaveValue("");
  await input.fill(SAMPLE.serial);
  await expect(card(page, 1).getByLabel(/^Serial/)).toHaveValue(""); // chưa Enter thì chưa thêm
  await input.press("Enter");
  await expect(card(page, 1).getByLabel(/^Serial/)).toHaveValue(SAMPLE.serial);
});
