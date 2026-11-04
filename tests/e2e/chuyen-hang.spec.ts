import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Chuyến · Đơn mua · Máy với CSDL thật (CI: đã nạp db/seed-vi-du.sql). Dữ liệu thử dùng mã riêng cho mỗi lần chạy
 * và tự dọn sạch ở cuối.
 */

/** IMEI hợp lệ (Luhn) ngẫu nhiên — không trùng giữa các lần chạy. */
function randomImei() {
  const d = ["35", ...Array.from({ length: 12 }, () => String(Math.floor(Math.random() * 10)))].join("");
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let x = Number(d[i]);
    if (i % 2 === 1) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return d + String((10 - (sum % 10)) % 10);
}
const stamp = () => Date.now().toString(36).toUpperCase().slice(-5);

async function paste(target: Locator, text: string) {
  await target.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

function grid(page: Page) {
  return page.getByRole("table", { name: "Lưới nhập máy" });
}

test("tạo chuyến → đơn mua → dán bảng từ Excel → lưu → giá vốn tự tính → dọn dẹp", async ({ page }, info) => {
  page.on("dialog", (d) => d.accept());
  const s = stamp() + (info.project.name === "iphone" ? "I" : "D");
  const code = `CH-E2E-${s}`;
  const imei = randomImei();
  const serial = `F2E${s}`.slice(0, 10).padEnd(10, "X");

  await login(page, "/chuyen-hang");
  await expect(page.getByRole("link", { name: "Chuyến CH-2026-011" })).toContainText("55.943.208 ₫");

  const create = page.getByRole("form", { name: "Tạo chuyến" });
  await create.getByLabel("Mã chuyến").fill(code.toLowerCase());
  await create.getByLabel("Tên / ghi nhớ").fill("Chuyến kiểm thử");
  await create.getByLabel("Tỷ giá dự kiến").fill("26.350");
  await create.getByRole("button", { name: "Tạo chuyến" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(code);
  await expect(page.getByTestId("batch-status")).toHaveText("Nháp");

  // đơn mua: tỷ giá điền sẵn từ tỷ giá dự kiến của chuyến (26.350 = hai mươi sáu nghìn ba trăm năm mươi)
  const addPo = page.getByRole("form", { name: "Thêm đơn mua" });
  await expect(addPo.getByLabel("Tỷ giá thực tế *")).toHaveValue("26.350");
  await addPo.getByRole("button", { name: "Thêm đơn mua" }).click();
  await expect(addPo.getByText("Chọn nơi mua", { exact: true })).toBeVisible();
  await addPo.getByLabel("Nơi mua *").selectOption({ label: "Apple Store" });
  await addPo.getByLabel("Mã đơn").fill(`W${s}`);
  await addPo.getByLabel("Subtotal *").fill("1,798.00");
  await addPo.getByRole("button", { name: "Thêm đơn mua" }).click();
  await expect(page.getByRole("article", { name: `Đơn mua Apple Store · W${s}` })).toContainText("0 ₫");
  await expect(page.getByTestId("batch-status")).toHaveText("Đang mua");

  // dán bảng có tiêu đề cột từ Excel vào ô đầu tiên
  await paste(
    grid(page).getByLabel("Cấu hình dòng 1"),
    `Cấu hình\tĐơn giá\tSerial\tIMEI\tPart No.\npm 256 sil\t$1,199.00\t${serial}\t${imei}\tMDEM1LL/A\nair 128\t599\t\t\t`,
  );
  await expect(page.getByRole("status").filter({ hasText: "Đã dán 2 dòng (xếp theo tiêu đề cột)" })).toBeVisible();
  await expect(grid(page).getByLabel("Cấu hình dòng 1")).toHaveValue("iPhone Pro Max · 256GB · Silver");
  await expect(grid(page).getByLabel("Cấu hình dòng 2")).toHaveValue("iPad Air 11 · 128GB · Blue");
  await expect(grid(page).getByLabel("IMEI 1 dòng 1")).toHaveValue(imei);
  await expect(page.getByTestId("subtotal-check")).toContainText("= Subtotal ✓");

  // IMEI gõ sai → báo lỗi ngay tại ô, chưa cho lưu
  await grid(page).getByLabel("Cấu hình dòng 3").fill("airpods");
  await grid(page).getByLabel("Đơn giá dòng 3").fill("249");
  await grid(page).getByLabel("IMEI 1 dòng 3").fill("123456789012345");
  await expect(grid(page).getByRole("alert").filter({ hasText: "IMEI sai" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lưu lưới máy" })).toBeDisabled();
  await grid(page).getByRole("button", { name: "Xoá dòng 3" }).click();

  await page.getByRole("button", { name: "Lưu lưới máy" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu: thêm 2 máy" })).toBeVisible();
  // 1.798 USD × 26.350 = 47.377.300 ₫ — chia theo giá trị
  await expect(page.getByRole("article", { name: `Đơn mua Apple Store · W${s}` })).toContainText("47.377.300 ₫");
  await expect(grid(page).getByRole("row", { name: "Dòng 1" })).toContainText("Đã đặt");
  await expect(grid(page).getByRole("row", { name: "Dòng 1" })).toContainText("31.593.650 ₫");

  // trùng serial với máy đã có (dữ liệu ví dụ) → máy chủ chặn, báo đúng ô
  await grid(page).getByLabel("Serial dòng 2").fill("SERIALIPHONE01");
  await page.getByRole("button", { name: "Lưu lưới máy" }).click();
  await expect(grid(page).getByText("SERIALIPHONE01 đã có ở một máy khác (chuyến CH-2026-011)")).toBeVisible();

  // dọn dẹp: xoá 2 máy → xoá đơn → xoá chuyến
  await page.reload();
  await grid(page).getByRole("button", { name: "Xoá dòng 2" }).click();
  await grid(page).getByRole("button", { name: "Xoá dòng 1" }).click();
  await page.getByRole("button", { name: "Lưu lưới máy" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã lưu: xoá 2 máy" })).toBeVisible();
  const po = page.getByRole("article", { name: `Đơn mua Apple Store · W${s}` });
  await po.getByText("Sửa / xoá đơn mua").click();
  await po.getByRole("button", { name: "Xoá đơn mua" }).click();
  await expect(page.getByRole("article", { name: `Đơn mua Apple Store · W${s}` })).toHaveCount(0);
  await page.getByText("Sửa thông tin chuyến").click();
  await page.getByRole("button", { name: "Xoá chuyến" }).click();
  await expect(page).toHaveURL(/\/chuyen-hang$/);
  await expect(page.getByRole("link", { name: `Chuyến ${code}` })).toHaveCount(0);
});

test("máy quét USB: gõ mã + Enter → xuống dòng cùng cột; IMEI quét nhầm vào cột Serial tự chuyển sang cột IMEI", async ({ page }) => {
  await login(page, "/chuyen-hang");
  await page.getByRole("link", { name: "Chuyến CH-2026-011" }).click();
  const imei = randomImei();
  const serialCell = grid(page).getByLabel("Serial dòng 4");
  await serialCell.fill(imei);
  await serialCell.press("Enter");
  await expect(grid(page).getByLabel("Serial dòng 5")).toBeFocused();
  await expect(grid(page).getByLabel("Serial dòng 4")).toHaveValue("");
  await expect(grid(page).getByLabel("IMEI 1 dòng 4")).toHaveValue(imei);
  // Part No. có trong danh mục → tự điền cấu hình
  await grid(page).getByLabel("Part No. dòng 4").fill("mdem2ll/a");
  await grid(page).getByLabel("Part No. dòng 4").press("Enter");
  await expect(grid(page).getByLabel("Cấu hình dòng 4")).toHaveValue("iPad Air 11 · 128GB · Blue");
});

test("chuyến đã chốt: sửa đơn giá bị chặn; mở lại phải có lý do; chốt lại được", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await login(page, "/chuyen-hang");
  await page.getByRole("link", { name: "Chuyến CH-2026-011" }).click();
  await expect(page.getByTestId("batch-status")).toHaveText("Đã chốt chi phí ✓");
  await expect(page.getByText("Lãi (Chốt)")).toBeVisible();

  await grid(page).getByLabel("Đơn giá dòng 1").fill("1149");
  await page.getByRole("button", { name: "Lưu lưới máy" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "CH-2026-011 đã chốt chi phí" })).toBeVisible();
  await page.reload();
  await expect(grid(page).getByLabel("Đơn giá dòng 1")).toHaveValue("1199.00");

  const reopen = page.getByRole("form", { name: "Mở lại chuyến" });
  await reopen.getByRole("button", { name: "Mở lại chuyến" }).click();
  await expect(reopen.getByText(/phải ghi lý do/).first()).toBeVisible();
  await reopen.getByLabel("Lý do mở lại *").fill("Kiểm thử mở lại rồi chốt lại");
  await reopen.getByRole("button", { name: "Mở lại chuyến" }).click();
  await expect(page.getByTestId("batch-status")).toHaveText("Đã về");
  await expect(page.getByText("Lãi (Tạm tính)")).toBeVisible();

  await page.getByRole("button", { name: "Chốt chi phí chuyến" }).click();
  await expect(page.getByTestId("batch-status")).toHaveText("Đã chốt chi phí ✓");
  await expect(page.getByRole("region", { name: "Tổng hợp chuyến" }).or(page.getByLabel("Tổng hợp chuyến"))).toContainText("2.706.128 ₫");
});
