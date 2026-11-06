import Link from "next/link";
import { displayValue, SETTING_GROUPS, SETTINGS } from "@/domain/settings";
import { requireOwner } from "@/server/auth/session";
import { getSettings } from "@/server/settings/service";
import { ActionForm, Input, Select, Submit } from "../_components/form";
import { Glyph } from "../_components/Glyph";
import { catalogDb, NoDatabase } from "../danh-muc/shared";
import { saveSettingsAction } from "./actions";

export const metadata = { title: "Cài đặt" };

export default async function SettingsPage() {
  const db = await catalogDb();
  const owner = await requireOwner();
  const values = db ? await getSettings(db) : {};
  return (
    <main className="mx-auto max-w-4xl p-4 md:p-8">
      <h1 className="text-2xl font-bold">Cài đặt</h1>
      {!db ? (
        <div className="mt-4">
          <NoDatabase />
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-6">
          <section className="card p-4" aria-labelledby="tham-so">
            <h2 id="tham-so" className="font-semibold">
              Tham số
            </h2>
            <ActionForm action={saveSettingsAction} label="Cài đặt" className="mt-2 flex flex-col gap-5">
              {SETTING_GROUPS.map((g) => (
                <fieldset key={g.key} className="flex flex-col gap-3">
                  <legend className="mb-1 text-sm font-semibold text-muted">{g.label}</legend>
                  {SETTINGS.filter((s) => s.group === g.key).map((s) => (
                    <div key={s.key} className="field-row">
                      {s.type === "enum" ? (
                        <Select
                          label={s.label}
                          name={s.key}
                          options={s.options}
                          defaultValue={displayValue(s, values[s.key])}
                          className="w-full sm:w-[28rem]"
                        />
                      ) : (
                        <Input
                          label={`${s.label}${s.type === "int" ? ` (${s.unit})` : s.type === "percent" ? " (% ngưỡng)" : " (đồng)"}`}
                          name={s.key}
                          inputMode={s.type === "int" ? "numeric" : "decimal"}
                          defaultValue={displayValue(s, values[s.key])}
                          className="w-full sm:w-80"
                        />
                      )}
                      {s.hint && <p className="basis-full text-xs text-muted">{s.hint}</p>}
                    </div>
                  ))}
                </fieldset>
              ))}
              <div>
                <Submit>Lưu cài đặt</Submit>
              </div>
            </ActionForm>
          </section>

          <section className="card p-4" aria-labelledby="du-lieu">
            <h2 id="du-lieu" className="font-semibold">
              Sao lưu &amp; dữ liệu
            </h2>
            <p className="mt-1 text-sm text-muted">
              Tải toàn bộ dữ liệu (mọi bảng, dạng CSV mở được bằng Excel) về máy để lưu trữ hoặc chuyển sang hệ thống khác. Gói có thông tin khách hàng — giữ an
              toàn. Mỗi lần tải được ghi nhật ký.
            </p>
            <a href="/cai-dat/xuat-du-lieu" className="btn-secondary mt-3 inline-flex" download data-testid="export-all">
              ⤓ Tải toàn bộ dữ liệu (.zip)
            </a>
            <p className="mt-3 text-xs text-muted">
              Sao lưu tự động hằng ngày (pg_dump mã hoá, giữ 30 bản ngày + 12 bản tháng) được bật khi triển khai lên máy chủ thật — đang chờ chọn nơi triển
              khai.
            </p>
          </section>

          <section className="card p-4" aria-labelledby="cai-app">
            <h2 id="cai-app" className="font-semibold">
              Cài lên điện thoại
            </h2>
            <ul className="mt-2 list-disc pl-5 text-sm">
              <li>
                <b>iPhone (Safari):</b> bấm nút Chia sẻ → <i>Thêm vào MH chính</i>.
              </li>
              <li>
                <b>Android (Chrome):</b> menu ⋮ → <i>Cài đặt ứng dụng</i> / <i>Thêm vào màn hình chính</i>.
              </li>
            </ul>
            <p className="mt-2 text-xs text-muted">
              Mở như một ứng dụng riêng, có lối tắt Bán máy · Quét mã · Kho máy (nhấn giữ biểu tượng). Số liệu luôn lấy mới từ máy chủ — mất mạng thì báo, không
              hiện số cũ. Cần địa chỉ HTTPS (có khi triển khai thật).
            </p>
          </section>

          <section className="card p-4" aria-labelledby="bao-mat">
            <h2 id="bao-mat" className="font-semibold">
              Bảo mật
            </h2>
            <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted">Tài khoản chủ</dt>
                <dd>{owner.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Đăng nhập</dt>
                <dd>Mật khẩu + mã xác thực 2 lớp (TOTP) · chống dò mật khẩu</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted">Đổi mật khẩu / mã 2 lớp: chạy lại `npm run auth:setup` trên máy chủ (xem README).</p>
            <Link
              href="/cai-dat/nhat-ky"
              className="group mt-3 flex items-center gap-3 rounded-2xl bg-[var(--fill)] p-3 text-sm transition-colors hover:bg-[var(--fill-strong)]"
            >
              <span className="icon-tile h-9 w-9 rounded-[11px]">
                <Glyph name="history" size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Nhật ký thay đổi →</span>
                <span className="text-xs text-muted">ai sửa gì, lúc nào, giá trị trước và sau.</span>
              </span>
            </Link>
          </section>

          <p className="text-sm text-muted">
            Danh mục (mẫu máy, nơi mua, vận chuyển, tài khoản tiền) ở{" "}
            <Link href="/danh-muc" className="underline">
              Danh mục
            </Link>
            ; danh mục thu chi ở{" "}
            <Link href="/thu-chi/danh-muc" className="underline">
              Thu chi
            </Link>
            .
          </p>
        </div>
      )}
    </main>
  );
}
