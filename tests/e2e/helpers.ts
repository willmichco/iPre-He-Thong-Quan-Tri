import { expect, type Page } from "@playwright/test";
import { Secret, TOTP } from "otpauth";
import { E2E_OWNER } from "../../playwright.config";

export function currentCode() {
  return new TOTP({ secret: Secret.fromBase32(E2E_OWNER.totpSecret), digits: 6, period: 30 }).generate();
}

export async function login(page: Page, next = "/") {
  await page.goto(`/dang-nhap?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(E2E_OWNER.email);
  await page.getByLabel("Mật khẩu").fill(E2E_OWNER.password);
  await page.getByLabel(/Mã xác thực/).fill(currentCode());
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page).toHaveURL(new RegExp(`${next === "/" ? "/$" : next}`));
}
