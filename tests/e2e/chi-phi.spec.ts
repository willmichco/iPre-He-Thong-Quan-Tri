import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { deleteCost } from "@/server/costs/service";
import { finalizeBatchCosts, reopenBatchCosts } from "@/server/costing/service";
import { login } from "./helpers";

const CH011 = "60000000-0000-0000-0000-000000000001";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Kiểm thử Chi phí cần DATABASE_URL (CSDL đã nạp db/seed-vi-du.sql)");

/** Luôn trả chuyến ví dụ về như cũ (kể cả khi ca thử dừng giữa chừng): xoá khoản thử, chốt lại chuyến. */
test.afterEach(async () => {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const left = await sql<{ id: string }[]>`SELECT id::text FROM costs WHERE description = 'Kiểm máy E2E' AND deleted_at IS NULL`;
    const [b] = await sql<{ status: string }[]>`SELECT status::text FROM batches WHERE id = ${CH011}`;
    if (left.length && b.status === "COSTS_FINALIZED") await reopenBatchCosts(sql, CH011, "Dọn dữ liệu kiểm thử");
    for (const c of left) await deleteCost(sql, c.id);
    const [after] = await sql<{ status: string }[]>`SELECT status::text FROM batches WHERE id = ${CH011}`;
    if (after.status !== "COSTS_FINALIZED") await finalizeBatchCosts(sql, CH011);
  } finally {
    await sql.end();
  }
});

/** Mở khung "+ Thêm chi phí" nếu đang đóng (trang làm mới có thể giữ trạng thái mở). */
async function openAdd(page: Page) {
  const form = page.getByRole("form", { name: "Thêm chi phí" });
  if (!(await form.isVisible())) await page.getByText("+ Thêm chi phí").click();
  await expect(form).toBeVisible();
  return form;
}

/**
 * Chi phí theo chặng trên chuyến ví dụ CH-2026-011 (đã chốt). Ca thử: bị chặn khi đã chốt → mở lại → thêm khoản
 * dự toán → giá vốn & lãi đổi → xoá → chốt lại. Trả dữ liệu về như cũ.
 */
test("chi phí: chuyến đã chốt bị chặn; mở lại → thêm / xoá chi phí → giá vốn tự tính lại; cấu trúc giá vốn đối soát", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await login(page, "/chuyen-hang");
  await page.getByRole("link", { name: "Chuyến CH-2026-011" }).click();

  const structure = page.getByRole("table", { name: "Cấu trúc giá vốn" });
  await expect(structure).toContainText("54.040.800 ₫");
  await expect(structure).toContainText("1.224.408 ₫");
  await expect(structure).toContainText("55.943.208 ₫");
  await expect(page.getByTestId("reconcile")).toContainText("Đối soát: nhóm A = Σ tổng tiền các đơn mua ✓");
  const list = page.getByRole("table", { name: "Danh sách chi phí" });
  await expect(list.getByRole("row")).toHaveCount(5);
  await expect(list).toContainText("✓ 3 máy");

  // đã chốt → thêm chi phí bị chặn
  let add = await openAdd(page);
  await add.getByLabel("Loại chi phí *").selectOption("HANDLING");
  await add.getByLabel("Số tiền *").fill("90.000");
  await add.getByLabel("Mô tả").fill("Kiểm máy E2E");
  await add.getByRole("button", { name: "Thêm chi phí" }).click();
  await expect(add.getByRole("alert")).toContainText("CH-2026-011 đã chốt chi phí");

  const reopen = page.getByRole("form", { name: "Mở lại chuyến" });
  await reopen.getByLabel("Lý do mở lại *").fill("Kiểm thử chi phí");
  await reopen.getByRole("button", { name: "Mở lại chuyến" }).click();
  await expect(page.getByTestId("batch-status")).toHaveText("Đã về");

  add = await openAdd(page);
  await add.getByLabel("Loại chi phí *").selectOption("HANDLING");
  await add.getByLabel("Số tiền *").fill("90.000");
  await add.getByLabel("Mô tả").fill("Kiểm máy E2E");
  await add.getByLabel("Dự toán (chưa có hoá đơn)").check();
  await add.getByRole("button", { name: "Thêm chi phí" }).click();
  await expect(add.getByRole("status")).toContainText("Đã thêm chi phí · giá vốn CH-2026-011 +90.000 đ");
  await expect(structure).toContainText("56.033.208 ₫");
  await expect(page.getByText("Lãi (Tạm tính)")).toBeVisible();
  await expect(page.getByLabel("Tổng hợp chuyến")).toContainText("2.646.128 ₫");
  const row = list.getByRole("row", { name: "Kiểm máy, đóng gói, lưu kho Kiểm máy E2E" });
  await expect(row).toContainText("dự toán");
  await expect(row).toContainText("Theo số lượng");

  // còn dự toán → không chốt được
  await page.getByRole("button", { name: "Chốt chi phí chuyến" }).click();
  await expect(page.getByRole("form", { name: "Chốt chi phí" }).getByRole("alert")).toContainText("1 khoản chi phí còn là dự toán");

  await row.getByText("Sửa / xoá").click();
  await row.getByRole("button", { name: "Xoá chi phí" }).click();
  await expect(list.getByRole("row")).toHaveCount(5);
  await expect(structure).toContainText("55.943.208 ₫");

  await page.getByRole("button", { name: "Chốt chi phí chuyến" }).click();
  await expect(page.getByTestId("batch-status")).toHaveText("Đã chốt chi phí ✓");
});

test("trang kiện: chi phí của kiện, loại theo chặng đứng đầu", async ({ page }) => {
  await login(page, "/van-chuyen");
  await page
    .getByRole("listitem", { name: "Đã nhận" })
    .getByRole("link", { name: "Kiện AWB-0001" })
    .click()
    .catch(async () => {
      // kiện ví dụ nhận đã lâu (ngoài 30 ngày) → mở thẳng
      await page.goto("/van-chuyen/90000000-0000-0000-0000-000000000002");
    });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("AWB-0001");
  const list = page.getByRole("table", { name: "Danh sách chi phí" });
  await expect(list).toContainText("Cước Mỹ → VN");
  await expect(list).toContainText("684.000 ₫");
  await expect(list).toContainText("Theo cân nặng");
  await page.getByText("+ Thêm chi phí").click();
  await expect(page.getByRole("form", { name: "Thêm chi phí" }).getByLabel("Loại chi phí *")).toHaveValue("INTL_SHIPPING");
  await expect(page.getByRole("form", { name: "Thêm chi phí" }).getByLabel("Gắn vào *")).toHaveValue("SHIPMENT:90000000-0000-0000-0000-000000000002");
});
