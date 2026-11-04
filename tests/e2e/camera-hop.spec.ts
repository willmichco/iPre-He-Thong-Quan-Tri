/**
 * Quét trực tiếp bằng camera: Chromium phát video giả là khung hình nhãn hộp mẫu
 * (mã Code 128 mảnh, hơi nghiêng, hơi mờ). Bắt lỗi đã gặp trên hộp máy thật:
 * camera chạy nhưng không đọc được mã nào.
 */
import { expect, test } from "@playwright/test";
import { SAMPLE } from "./fixtures";
import { login } from "./helpers";

test.setTimeout(90_000);

test("dạng 2 — camera tự đọc mã vạch sau hộp, không cần bấm nút", async ({ page }) => {
  await login(page, "/quet-ma");
  await expect(page.getByText("Sẵn sàng", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Bật camera quét" }).click();
  await expect(page.getByText(/Đang tự quét/)).toBeVisible();

  // Nhãn mẫu có 2 máy; sau vài khung hình phải đọc được cả Serial và IMEI 1 của iPhone (mã mảnh nhất)
  const values = () =>
    page.locator("article.sc-card").evaluateAll((cards) =>
      cards.flatMap((c) => Array.from(c.querySelectorAll("input")).map((i) => (i as HTMLInputElement).value)),
    );
  await expect.poll(values, { timeout: 30_000 }).toEqual(expect.arrayContaining([SAMPLE.serial, SAMPLE.imei1]));
  await expect(page.locator("article.sc-card").first().getByText("▌▌▌ Mã vạch").first()).toBeVisible();

  // Hai nhãn xếp chồng trong khung: mỗi máy phải nhận đúng Part No. của mình (không gán chéo)
  const partBySerial = () =>
    page.locator("article.sc-card").evaluateAll((cards) =>
      Object.fromEntries(
        cards.map((c) => {
          const v = (label: string) =>
            (Array.from(c.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label))?.querySelector("input") as HTMLInputElement | null)?.value ?? "";
          return [v("Serial"), v("Part No")];
        }),
      ),
    );
  await expect.poll(partBySerial, { timeout: 20_000 }).toEqual({ F2LXQ7Y9KD: "MDEM1LL/A", C02XL0GTJGH5: "MDEM2VN/A" });

  // Nút dự phòng vẫn có
  await expect(page.getByRole("button", { name: /Chụp & đọc kỹ/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Nhập tay/ })).toBeVisible();
});
