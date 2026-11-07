import { expect, test, type Page } from "@playwright/test";
import { formatAmount } from "../../src/domain/ledger";
import { login } from "./helpers";

/**
 * Thu chi trên dữ liệu ví dụ: bút toán tự sinh có liên kết về chứng từ, ghi khoản chi vận hành, chuyển tiền,
 * đối soát khớp, xoá bút toán. Các kiểm thử khác (bán hàng…) chạy trước có thể đã đổi số dư → so tương đối.
 * Khoản ghi thêm được xoá ở cuối (chuyển tiền: cả hai vế). Chạy cả máy tính (bảng) lẫn điện thoại (thẻ).
 */
const vnd = (t: string | null) => BigInt((t ?? "").replace(/[^\d−-]/g, "").replace("−", "-"));
const show = (v: bigint) => formatAmount(v * 100n, "VND");
/** Sổ quỹ đang hiển thị: bảng (máy tính) hoặc danh sách thẻ (điện thoại). */
const ledger = (page: Page) => page.locator('[aria-label="Sổ quỹ"], [aria-label="Sổ quỹ (dạng thẻ)"]').filter({ visible: true });
const entry = (page: Page, text: string) => ledger(page).locator("tr, li").filter({ hasText: text }).first();

test("sổ quỹ: tự sinh, ghi chi vận hành, chuyển tiền, đối soát, xoá", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "/thu-chi");
  await expect(page.getByRole("heading", { name: "Thu chi", level: 1 })).toBeVisible();
  const bankBalance = page.getByRole("link", { name: "Tài khoản Ngân hàng chính" }).getByTestId("account-balance");
  const start = vnd(await bankBalance.textContent());

  // bút toán tự sinh → ghi rõ chứng từ gốc
  await expect(entry(page, "Đơn mua W123456789")).toContainText("54.040.800 ₫");
  // máy tính: liên kết riêng về chuyến (điện thoại: cả thẻ mở chi tiết bút toán, ở đó có liên kết)
  const table = page.getByRole("table", { name: "Sổ quỹ" });
  if (await table.isVisible())
    await expect(table.getByRole("link", { name: /Đơn mua W123456789 · CH-2026-011/ })).toHaveAttribute("href", /\/chuyen-hang\//);

  // ghi khoản chi vận hành
  await page.getByText("+ Khoản chi vận hành / thu khác").click();
  const form = page.getByRole("form", { name: "Khoản chi vận hành" });
  await form.getByLabel("Danh mục *").selectOption({ label: "Chi · Quảng cáo" });
  await form.getByLabel("Tài khoản *").selectOption({ label: "Ngân hàng chính" });
  await form.getByLabel("Số tiền *").fill("1,2tr");
  await form.getByLabel("Ghi chú").fill("QC e2e");
  await form.getByRole("button", { name: "Ghi sổ" }).click();
  await expect(form.getByRole("status")).toHaveText("✓ Đã ghi vào sổ quỹ");
  await expect(bankBalance).toHaveText(show(start - 1_200_000n));
  await expect(entry(page, "QC e2e")).toContainText("1.200.000 ₫");

  // chuyển tiền: tổng thu chi toàn sổ không đổi, chỉ thêm 2 bút toán
  const totals = await page.getByTestId("ledger-totals").textContent();
  await page.getByText("Chuyển tiền / đổi ngoại tệ").click();
  const tf = page.getByRole("form", { name: "Chuyển tiền" });
  await tf.getByLabel("Từ tài khoản *").selectOption({ label: "Ngân hàng chính" });
  await tf.getByLabel("Sang tài khoản *").selectOption({ label: "Thẻ Visa (VND)" });
  await tf.getByLabel("Số chuyển *").fill("5tr");
  await tf.getByLabel("Ghi chú").fill("Trả thẻ e2e");
  await tf.getByRole("button", { name: "Chuyển" }).click();
  await expect(tf.getByRole("status")).toHaveText("✓ Đã ghi chuyển tiền (2 bút toán)");
  await expect(bankBalance).toHaveText(show(start - 6_200_000n));
  await expect(page.getByTestId("ledger-totals")).toHaveText(totals!.replace(/^\d+/, (n) => String(Number(n) + 2)));

  // đối soát tài khoản ngân hàng với đúng số dư → khớp
  await page.getByRole("link", { name: "Tài khoản Ngân hàng chính" }).click();
  await expect(page.getByTestId("account-now-balance")).toHaveText(show(start - 6_200_000n));
  const rec = page.getByRole("form", { name: "Đối soát" });
  await rec.getByLabel(/Số dư thực tế/).fill((start - 6_200_000n).toString());
  await rec.getByRole("button", { name: "Đối soát" }).click();
  await expect(rec.getByRole("status")).toHaveText("✓ Khớp số dư ✓");
  await expect(page.getByTestId("reconciliation").first()).toContainText("Khớp ✓");

  // xoá: chuyển tiền (cả hai vế) và khoản chi e2e
  for (const text of ["Trả thẻ e2e", "QC e2e"]) {
    await page.goto("/thu-chi");
    await entry(page, text).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/thu-chi\/[0-9a-f-]{36}$/);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: /^Xoá/ }).click();
    await expect(page).toHaveURL(/\/thu-chi$/);
  }
  await expect(page.getByRole("link", { name: "Tài khoản Ngân hàng chính" }).getByTestId("account-balance")).toHaveText(show(start));
});

test("công nợ hiển thị; bút toán tự sinh không sửa / xoá được trong sổ quỹ", async ({ page }) => {
  await login(page, "/thu-chi/cong-no");
  await expect(page.getByRole("heading", { name: "Phải thu" })).toBeVisible();
  await expect(page.getByTestId("payable-total")).toContainText("₫");
  await page.goto("/thu-chi?dm=PURCHASE");
  await entry(page, "54.040.800").getByRole("link").first().click();
  await expect(page.getByText("Bút toán tự sinh — sửa số tiền")).toBeVisible();
  await expect(page.getByRole("form", { name: "Sửa bút toán" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Xoá/ })).toHaveCount(0);
});
