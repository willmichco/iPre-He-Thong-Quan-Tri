import { expect, test } from "@playwright/test";
import { E2E_OWNER } from "../../playwright.config";
import { login } from "./helpers";

test("chưa đăng nhập → bị chuyển về trang đăng nhập, giữ lại trang định vào", async ({ page }) => {
  await page.goto("/quet-ma");
  await expect(page).toHaveURL(/\/dang-nhap\?next=%2Fquet-ma/);
  await expect(page.getByRole("heading", { name: /iPre/ })).toBeVisible();
});

test("API cần đăng nhập trả 401; kiểm tra sức khoẻ thì không", async ({ request }) => {
  const res = await request.get("/api/v1/items");
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
});

test("sai mã xác thực → báo lỗi, không vào được", async ({ page }) => {
  await page.goto("/dang-nhap");
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Mật khẩu").fill(E2E_OWNER.password);
  await page.getByLabel(/Mã xác thực/).fill("000000");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByText("Email, mật khẩu hoặc mã xác thực không đúng.")).toBeVisible();
  await expect(page).toHaveURL(/\/dang-nhap/);
});

test("đủ email + mật khẩu + mã 2 lớp → vào được, đăng xuất được", async ({ page, isMobile }) => {
  await login(page, "/quet-ma");
  await expect(page.getByRole("heading", { name: "Quét mã máy" })).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "ipre_session");
  expect(session?.httpOnly).toBe(true);
  if (!isMobile) {
    await page.getByRole("button", { name: "Đăng xuất" }).click();
    await expect(page).toHaveURL(/\/dang-nhap/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/dang-nhap/);
  }
});
