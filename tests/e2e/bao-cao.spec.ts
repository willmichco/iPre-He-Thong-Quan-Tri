import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/** Báo cáo trên dữ liệu ví dụ (tháng 10/2026, kỳ cố định để không phụ thuộc ngày chạy). Chỉ đọc. */
const OCT = "tu=2026-10-01&den=2026-10-31";

test("lãi lỗ tháng 10 → đổi báo cáo giữ nguyên kỳ → xuất Excel; sổ thuế năm 2026", async ({ page }) => {
  await login(page, "/bao-cao");
  await page.goto(`/bao-cao?bc=lai-lo&${OCT}`);
  await expect(page.getByRole("heading", { name: "Báo cáo", level: 1 })).toBeVisible();
  await expect(page.getByTestId("period-label")).toHaveText("01/10/2026 – 31/10/2026 · so với 01/09/2026 – 30/09/2026");
  const st = page.getByTestId("pnl-statement");
  await expect(st.locator('[data-line="revenue"]')).toContainText("51.700.000");
  await expect(st.locator('[data-line="net"]')).toContainText("2.206.128");

  await page.getByRole("navigation", { name: "Loại báo cáo" }).getByRole("link", { name: "Kênh bán" }).click();
  await expect(page).toHaveURL(/bc=kenh&tu=2026-10-01&den=2026-10-31/);
  const tbl = page.getByRole("table", { name: "Theo kênh bán" });
  await expect(tbl.getByRole("row").filter({ hasText: "Facebook" })).toContainText("34.500.000");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-xlsx").click()]);
  expect(dl.suggestedFilename()).toBe("ipre-kenh-2026-10-01_2026-11-01.xlsx");
  const bytes = readFileSync((await dl.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.length).toBeGreaterThan(1000);

  await page.getByRole("navigation", { name: "Loại báo cáo" }).getByRole("link", { name: "Doanh thu thuế" }).click();
  await expect(page.getByTestId("tax-threshold-report")).toContainText("Doanh thu năm 2026");
  await expect(page.getByRole("table", { name: "Đơn chưa xuất hoá đơn" })).toContainText("BH-2026-0002");

  await page.getByRole("navigation", { name: "Loại báo cáo" }).getByRole("link", { name: "Tồn kho" }).click();
  await expect(page.getByRole("table", { name: "Máy tồn kho" })).toBeVisible();
});

test("xuất Excel cần đăng nhập; báo cáo lạ → 404", async ({ page, request }) => {
  const anon = await request.get("/bao-cao/xuat?bc=lai-lo", { maxRedirects: 0 });
  expect(anon.headers()["content-type"] ?? "").not.toContain("spreadsheet");
  await login(page, "/bao-cao");
  const bad = await page.request.get("/bao-cao/xuat?bc=khong-co");
  expect(bad.status()).toBe(404);
  const ok = await page.request.get(`/bao-cao/xuat?bc=thue&${OCT}`);
  expect(ok.headers()["content-type"]).toContain("spreadsheetml");
});
