import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { shortVnd } from "../../src/domain/overview";
import { login } from "./helpers";

/** Tổng quan trên dữ liệu ví dụ — chỉ đọc. Số kỳ vọng lấy thẳng từ view trong CSDL để không phụ thuộc ngày chạy. */
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử Tổng quan cần DATABASE_URL (CSDL đã nạp db/seed-vi-du.sql)");

test("thẻ KPI, vốn theo chặng → bấm 'Tồn SG' mở Kho máy đã lọc; đổi kỳ 'Năm nay'", async ({ page }) => {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const [cap] = await sql<{ c: string }[]>`SELECT COALESCE(SUM(capital_vnd), 0)::text AS c FROM v_capital_by_stage`;
  const [yr] = await sql<{ r: string | null }[]>`
    SELECT SUM(net_revenue_vnd)::text AS r FROM v_sale_item_profit
     WHERE EXTRACT(YEAR FROM sold_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Ho_Chi_Minh')`;
  await sql.end();

  await login(page, "/");
  await expect(page.getByRole("heading", { name: "Tổng quan", level: 1 })).toBeVisible();
  await expect(page.getByTestId("kpi-capital-value")).toHaveText(shortVnd(BigInt(cap.c)));
  await expect(page.getByTestId("chart-revenue").locator("rect[rx]").first()).toBeAttached();
  await expect(page.getByRole("heading", { name: /Cần xử lý/ })).toBeVisible();
  await expect(page.getByTestId("tax-threshold")).toContainText("Doanh thu năm");

  await page.getByRole("link", { name: "Năm nay" }).click();
  await expect(page).toHaveURL(/\?ky=nam-nay/);
  await expect(page.getByTestId("kpi-revenue-value")).toHaveText(shortVnd(BigInt(yr.r ?? "0")));

  await page
    .getByTestId("capital-stages")
    .getByRole("link", { name: /Tồn SG/ })
    .click();
  await expect(page).toHaveURL(/\/kho\?chang=sg/);
  await expect(page.getByTestId("stage-filter")).toHaveText("Chặng: Tồn SG");
  await expect(page.getByRole("table", { name: "Danh sách máy" }).getByRole("link", { name: "AirPods Pro · White" })).toBeVisible();
});
