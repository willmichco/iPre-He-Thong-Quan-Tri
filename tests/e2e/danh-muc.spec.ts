import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Danh mục với CSDL thật (CI: đã nạp db/seed-vi-du.sql). Ca thêm mới dùng tên/mã riêng cho từng lần chạy và
 * tự dọn sạch ở cuối, nên chạy lại nhiều lần không bị trùng.
 */

const stamp = () => Date.now().toString(36).toUpperCase().slice(-4);

/** Part No. hợp lệ, không trùng: 5 ký tự + LL/A */
const partNo = (s: string) => `Z${s.padStart(4, "0").slice(-4)}LL/A`;

async function acceptDialogs(page: Page) {
  page.on("dialog", (d) => d.accept());
}

test("xem danh mục ví dụ: mẫu máy, cấu hình, mã Part No., cân nặng", async ({ page }) => {
  await login(page, "/danh-muc");
  await expect(page.getByRole("heading", { name: "Danh mục", level: 1 })).toBeVisible();
  const variant = page.getByRole("listitem", { name: "iPhone Pro Max · 256GB · Silver" });
  await expect(variant).toContainText("IPPM-256-SLV");
  await expect(variant).toContainText("0,6 kg");
  await expect(variant).toContainText("MDEM1LL/A");

  const tabs = page.getByRole("navigation", { name: "Mục danh mục" });
  await tabs.getByRole("link", { name: "Vận chuyển" }).click();
  await expect(page).toHaveURL(/\/danh-muc\/van-chuyen$/);
  await expect(page.getByRole("listitem", { name: "Forwarder A" })).toContainText("② Mỹ → VN");
  await tabs.getByRole("link", { name: "Tài khoản tiền" }).click();
  await expect(page.getByRole("listitem", { name: "Ngân hàng chính" })).toContainText("Ngân hàng · VND");
});

test("thêm mẫu máy → cấu hình → gán Part No. một lần → bộ quét tự nhận ra → dọn dẹp", async ({ page }, info) => {
  await acceptDialogs(page);
  const s = stamp() + (info.project.name === "iphone" ? "I" : "D");
  const modelName = `iPad Thử ${s}`;
  const code = partNo(s);
  await login(page, "/danh-muc");

  // bỏ trống tên → báo lỗi ngay dưới ô, không lưu
  const addModel = page.getByRole("form", { name: "Thêm mẫu máy" });
  await addModel.getByRole("button", { name: "Thêm" }).click();
  await expect(addModel.getByText("Nhập tên mẫu máy").first()).toBeVisible();

  await addModel.getByLabel("Dòng sản phẩm").selectOption("IPAD");
  await addModel.getByLabel("Tên mẫu máy *").fill(modelName);
  await addModel.getByLabel("Năm ra mắt").fill("2026");
  await addModel.getByRole("button", { name: "Thêm" }).click();
  await expect(addModel.getByRole("status")).toContainText(`Đã thêm mẫu máy ${modelName}`);
  await expect(addModel.getByLabel("Tên mẫu máy *")).toHaveValue(""); // lưu xong thì xoá trắng form

  const card = page.getByRole("article", { name: modelName });
  await card.getByText("+ Thêm cấu hình").click();
  const addVariant = card.getByRole("form", { name: `Thêm cấu hình cho ${modelName}` });
  await addVariant.getByLabel("Dung lượng").fill("256GB");
  await addVariant.getByLabel("Màu").fill("Blue");
  await addVariant.getByLabel("Cân nặng mặc định (kg)").fill("0,45");
  await addVariant.getByRole("button", { name: "Thêm cấu hình" }).click();
  await expect(addVariant.getByRole("status")).toContainText(/Đã thêm cấu hình IPADTHU/);
  const label = `${modelName} · 256GB · Blue`;
  await expect(card.getByRole("listitem", { name: label })).toContainText("0,45 kg");

  // tra mã chưa có → hỏi một lần → gán
  await page.goto(`/danh-muc/ma-may?code=${encodeURIComponent(code.toLowerCase())}`);
  await expect(page.getByText("chưa có trong danh mục")).toBeVisible();
  const assign = page.getByRole("form", { name: "Gán mã cho cấu hình" });
  const option = assign.getByLabel("Cấu hình").locator("option", { hasText: label });
  await assign.getByLabel("Cấu hình").selectOption((await option.getAttribute("value"))!);
  await assign.getByRole("button", { name: "Gán mã" }).click();
  // gán xong trang tự làm mới: mã giờ đã có trong danh mục
  await expect(page.getByRole("status")).toContainText(`${code} là ${label}`);
  await expect(page.getByRole("row", { name: new RegExp(code.replace("/", "\\/")) })).toContainText("LL/A");

  // bộ quét: nhập Part No. → hiện cấu hình từ danh mục
  await page.goto("/quet-ma");
  await page.getByRole("tab", { name: /Nhập tay/ }).click();
  const input = page.getByLabel(/Nhập một mã/);
  await input.fill(code);
  await input.press("Enter");
  await expect(page.getByTestId("part-info")).toContainText(`✓ ${label} · 0,45 kg`);

  // dọn dẹp: bỏ mã → xoá cấu hình → xoá mẫu máy
  await page.goto("/danh-muc");
  const item = page.getByRole("article", { name: modelName }).getByRole("listitem", { name: label });
  await item.getByRole("button", { name: `Bỏ mã ${code}` }).click();
  await expect(item).not.toContainText(code);
  await item.getByText("Sửa · gán mã · xoá").click();
  await item.getByRole("button", { name: "Xoá cấu hình" }).click();
  await expect(page.getByRole("article", { name: modelName }).getByRole("listitem")).toHaveCount(0);
  const again = page.getByRole("article", { name: modelName });
  await again.getByText("Sửa / xoá mẫu máy").click();
  await again.getByRole("button", { name: "Xoá mẫu máy" }).click();
  await expect(page.getByRole("article", { name: modelName })).toHaveCount(0);
});

test("bộ quét: Part No. chưa có trong danh mục → gợi ý gán cấu hình", async ({ page }) => {
  await login(page, "/quet-ma");
  await page.getByRole("tab", { name: /Nhập tay/ }).click();
  const input = page.getByLabel(/Nhập một mã/);
  await input.fill("ZQQQ9LL/A");
  await input.press("Enter");
  const info = page.getByTestId("part-info");
  await expect(info).toContainText("chưa có trong danh mục");
  await expect(info.getByRole("link", { name: "gán cấu hình một lần" })).toHaveAttribute("href", "/danh-muc/ma-may?code=ZQQQ9LL%2FA");
});

test("đổi cân nặng của cấu hình đang dùng trong chuyến ĐÃ CHỐT → bị chặn, không lưu", async ({ page }) => {
  await login(page, "/danh-muc");
  const item = page.getByRole("listitem", { name: "iPhone Pro Max · 256GB · Silver" });
  await item.getByText("Sửa · gán mã · xoá").click();
  const form = item.getByRole("form", { name: "Sửa cấu hình IPPM-256-SLV" });
  await form.getByLabel("Cân nặng mặc định (kg)").fill("0,95");
  await form.getByRole("button", { name: "Lưu cấu hình" }).click();
  await expect(form.getByRole("alert")).toContainText("CH-2026-011 đã chốt chi phí");
  await expect(form.getByLabel("Cân nặng mặc định (kg)")).toHaveValue("0,95"); // không mất dữ liệu đã gõ
  await page.reload();
  await expect(page.getByRole("listitem", { name: "iPhone Pro Max · 256GB · Silver" })).toContainText("0,6 kg");
});
