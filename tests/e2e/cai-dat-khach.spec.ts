import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("cài đặt: sửa ngưỡng, báo lỗi theo ô, trả lại như cũ; tải toàn bộ dữ liệu", async ({ page }) => {
  await login(page, "/cai-dat");
  const form = page.getByRole("form", { name: "Cài đặt" });
  const aging = form.getByLabel(/Báo máy tồn lâu sau/);
  const old = await aging.inputValue();
  await aging.fill("0");
  await form.getByRole("button", { name: "Lưu cài đặt" }).click();
  await expect(form.getByRole("alert")).toContainText("từ 1 đến 365 ngày");
  await aging.fill("45");
  await form.getByRole("button", { name: "Lưu cài đặt" }).click();
  await expect(form.getByRole("status")).toHaveText("✓ Đã lưu 1 cài đặt");
  await page.reload();
  await expect(form.getByLabel(/Báo máy tồn lâu sau/)).toHaveValue("45");
  await form.getByLabel(/Báo máy tồn lâu sau/).fill(old);
  await form.getByRole("button", { name: "Lưu cài đặt" }).click();
  await expect(form.getByRole("status")).toHaveText("✓ Đã lưu 1 cài đặt");

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-all").click()]);
  expect(dl.suggestedFilename()).toMatch(/^ipre-du-lieu-\d{8}-\d{6}\.zip$/);
  const bytes = readFileSync((await dl.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
});

test("khách hàng: thêm → hồ sơ → sửa → ẩn danh hoá theo yêu cầu", async ({ page }) => {
  await login(page, "/ban-hang/khach-hang");
  await expect(page.getByRole("link", { name: /Khách Khách A/ })).toBeVisible();
  await page.getByText("+ Thêm khách").click();
  const add = page.getByRole("form", { name: "Thêm khách" });
  const phone = `09${String(Date.now()).slice(-8)}`;
  await add.getByLabel("Tên khách *").fill("Chị Thử E2E");
  await add.getByLabel("Số điện thoại").fill(phone.replace(/(\d{4})(\d{3})/, "$1 $2 "));
  await add.getByRole("button", { name: "Thêm" }).click();
  await expect(page).toHaveURL(/\/ban-hang\/khach-hang\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("customer-name")).toHaveText("Chị Thử E2E");
  await expect(page.getByText(phone)).toBeVisible();

  const edit = page.getByRole("form", { name: "Sửa khách" });
  await edit.getByLabel("Địa chỉ giao hàng").fill("Q.1, TP.HCM");
  await edit.getByRole("button", { name: "Lưu" }).click();
  await expect(edit.getByRole("status")).toHaveText("✓ Đã lưu thông tin khách");

  await page.getByText("Khách yêu cầu xoá dữ liệu cá nhân…").click();
  const anon = page.getByRole("form", { name: "Ẩn danh hoá" });
  await anon.getByLabel(/Lý do/).fill("Khách yêu cầu qua Zalo (e2e)");
  page.once("dialog", (d) => d.accept());
  await anon.getByRole("button", { name: "Ẩn danh hoá" }).click();
  await expect(page.getByTestId("customer-name")).toHaveText(/^Khách đã ẩn danh #/);
  await expect(page.getByText(phone)).toHaveCount(0);
});
