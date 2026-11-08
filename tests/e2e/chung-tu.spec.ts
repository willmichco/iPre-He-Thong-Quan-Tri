import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Hồ sơ nguồn gốc của AirPods (dữ liệu ví dụ, chưa có chứng từ): tải hoá đơn mua + vận đơn Mỹ → VN ngay trên trang máy
 * → hồ sơ đủ; mở chứng từ; xoá lại để không ảnh hưởng kiểm thử khác.
 */
const AIRPODS = "80000000-0000-0000-0000-000000000003";
const pdf = (s: string) => Buffer.from(`%PDF-1.4\n${s}\n%%EOF`);

test("tải chứng từ trên hồ sơ máy → đủ hồ sơ → mở / xoá", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "/kho");
  await expect(page.getByTestId("missing-docs-link")).toBeVisible();
  await page.goto(`/kho/${AIRPODS}`);
  const status = page.getByTestId("dossier-status");
  await expect(status).toContainText("thiếu hoá đơn mua");
  await expect(status).toContainText("thiếu vận đơn");

  const dossier = page.getByTestId("dossier");
  const upload = async (section: ReturnType<typeof dossier.locator>, kind: string, name: string) => {
    await section.getByText("+ Thêm chứng từ (ảnh / PDF)").click();
    const form = section.getByRole("form");
    await form.getByLabel("Loại").selectOption({ label: kind });
    await form.getByLabel(/Tệp/).setInputFiles({ name, mimeType: "application/pdf", buffer: pdf(name) });
    await form.getByRole("button", { name: "Tải lên" }).click();
    await expect(form.getByRole("status")).toHaveText("✓ Đã lưu 1 chứng từ");
  };
  const po = dossier.getByTestId("attachments-PURCHASE_ORDER");
  await upload(po, "Hoá đơn", "hoa-don-apple.pdf");
  await expect(status).toContainText("thiếu vận đơn");
  const intl = dossier.getByTestId("attachments-SHIPMENT").filter({ hasText: "AWB-0001" });
  await upload(intl, "Vận đơn / AWB", "awb-0001.pdf");
  await expect(status).toHaveText("đủ chứng từ mua và nhập khẩu");

  // mở chứng từ: đúng tệp PDF, cần đăng nhập
  const href = await po.getByRole("link", { name: "hoa-don-apple.pdf" }).getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.headers()["content-type"]).toBe("application/pdf");
  expect((await res.body()).toString()).toContain("hoa-don-apple.pdf");

  // dọn: xoá cả hai
  for (const [sec, name] of [
    [po, "hoa-don-apple.pdf"],
    [intl, "awb-0001.pdf"],
  ] as const) {
    page.once("dialog", (d) => d.accept());
    await sec
      .getByRole("form", { name: `Xoá ${name}` })
      .getByRole("button", { name: "Xoá" })
      .click();
    await expect(sec.getByRole("link", { name })).toHaveCount(0);
  }
  await expect(status).toContainText("thiếu hoá đơn mua");
});

test("tệp không phải ảnh / PDF bị từ chối", async ({ page }) => {
  await login(page, "/kho");
  await page.goto(`/kho/${AIRPODS}`);
  const item = page.getByTestId("dossier").getByTestId("attachments-ITEM");
  await item.getByText("+ Thêm chứng từ (ảnh / PDF)").click();
  const form = item.getByRole("form");
  await form.getByLabel(/Tệp/).setInputFiles({ name: "trang.html", mimeType: "text/html", buffer: Buffer.from("<html><script>alert(1)</script>") });
  await form.getByRole("button", { name: "Tải lên" }).click();
  await expect(form.getByRole("alert")).toContainText("chỉ nhận ảnh (JPG, PNG, WebP, HEIC) hoặc PDF");
});
