import Link from "next/link";
import { notFound } from "next/navigation";
import { formatVnd } from "@/domain/costing";
import { warrantyState } from "@/domain/customers";
import { SALE_STATUS_LABEL } from "@/domain/sales-core";
import { getCustomer } from "@/server/customers/service";
import { ActionForm, Input, Submit } from "../../../_components/form";
import { catalogDb, Empty, NoDatabase } from "../../../danh-muc/shared";
import { todayVn } from "../../../van-chuyen/shared";
import { anonymizeCustomerAction, saveCustomerAction } from "../actions";
import { CustomerFields } from "../fields";

export const metadata = { title: "Khách hàng — Bán hàng" };

const dmy = (d: string | null) => (d ? d.split("-").reverse().join("/") : "—");

export default async function CustomerPage({ params }: PageProps<"/ban-hang/khach-hang/[id]">) {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-4xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const c = await getCustomer(db, id);
  if (!c) notFound();
  const today = todayVn();
  return (
    <main className="mx-auto max-w-4xl p-4 md:p-8">
      <Link href="/ban-hang/khach-hang" className="text-sm text-muted hover:text-text">
        ← Khách hàng
      </Link>
      <div className="mt-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold" data-testid="customer-name">
          {c.fullName}
        </h1>
        {c.phone && <span className="tabular-nums text-muted">{c.phone}</span>}
        {c.anonymized && <span className="chip">đã ẩn danh</span>}
      </div>

      <section className="mt-4 grid grid-cols-3 gap-3" aria-label="Tổng hợp khách">
        <div className="card p-4">
          <p className="text-xs text-muted">Số đơn</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{c.sales.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Đã mua</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{formatVnd(c.revenueVnd)} ₫</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Còn nợ</p>
          <p className={`mt-1 text-lg font-semibold tabular-nums ${c.balanceVnd > 0n ? "text-[var(--warn)]" : ""}`} data-testid="customer-balance">
            {formatVnd(c.balanceVnd)} ₫
          </p>
        </div>
      </section>

      <section className="mt-6" aria-labelledby="may">
        <h2 id="may" className="font-semibold">
          Máy đã mua · bảo hành
        </h2>
        <div className="mt-2">
          {c.items.length === 0 ? (
            <Empty>Chưa mua máy nào.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {c.items.map((i) => {
                const w = warrantyState(i.warrantyUntil, today);
                return (
                  <li key={`${i.saleId}-${i.itemId}`} className="card flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 text-sm">
                    <Link href={`/kho/${i.itemId}`} className={`font-medium underline ${i.returned ? "line-through text-muted" : ""}`}>
                      {i.label}
                    </Link>
                    <span className="font-mono text-xs text-muted">{i.serial ?? i.imei1}</span>
                    <Link href={`/ban-hang/${i.saleId}`} className="text-xs text-muted underline">
                      {i.saleCode}
                    </Link>
                    <span className="ml-auto text-xs">
                      {i.returned ? (
                        <span className="text-muted">khách đã trả lại</span>
                      ) : w === "ACTIVE" ? (
                        <span className="text-[var(--ok)]">bảo hành tới {dmy(i.warrantyUntil)}</span>
                      ) : w === "EXPIRED" ? (
                        <span className="text-muted">hết bảo hành {dmy(i.warrantyUntil)}</span>
                      ) : (
                        <span className="text-muted">chưa có bảo hành (đơn cọc)</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-6" aria-labelledby="don">
        <h2 id="don" className="font-semibold">
          Đơn bán
        </h2>
        <div className="mt-2">
          {c.sales.length === 0 ? (
            <Empty>Chưa có đơn.</Empty>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm tabular-nums" aria-label="Đơn của khách">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="px-3 py-2 font-normal">Đơn</th>
                    <th className="px-3 py-2 font-normal">Ngày</th>
                    <th className="px-3 py-2 font-normal">Trạng thái</th>
                    <th className="px-3 py-2 text-right font-normal">Tổng</th>
                    <th className="px-3 py-2 text-right font-normal">Còn nợ</th>
                  </tr>
                </thead>
                <tbody>
                  {c.sales.map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Link href={`/ban-hang/${s.id}`} className="underline">
                          {s.code}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{dmy(s.date)}</td>
                      <td className="px-3 py-2">{SALE_STATUS_LABEL[s.status] ?? s.status}</td>
                      <td className="px-3 py-2 text-right">{formatVnd(s.totalVnd)}</td>
                      <td className={`px-3 py-2 text-right ${s.balanceVnd > 0n ? "text-[var(--warn)]" : ""}`}>
                        {formatVnd(s.balanceVnd > 0n ? s.balanceVnd : 0n)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {!c.anonymized && (
        <>
          <section className="card mt-6 p-4" aria-labelledby="sua-kh">
            <h2 id="sua-kh" className="font-semibold">
              Thông tin liên hệ
            </h2>
            <ActionForm action={saveCustomerAction} label="Sửa khách" className="field-row mt-3">
              <input type="hidden" name="id" value={c.id} />
              <CustomerFields c={c} />
              <Submit variant="secondary">Lưu</Submit>
            </ActionForm>
          </section>
          <details className="card mt-4 p-4">
            <summary className="cursor-pointer text-sm text-danger">Khách yêu cầu xoá dữ liệu cá nhân…</summary>
            <p className="mt-2 text-sm text-muted">
              Ẩn danh hoá: xoá tên, số điện thoại, Zalo, Facebook, địa chỉ, ghi chú. Các đơn bán vẫn được giữ (nghĩa vụ lưu sổ sách, kê khai thuế) nhưng không
              còn gắn với thông tin định danh. <b>Không hoàn tác được.</b>
            </p>
            <ActionForm
              action={anonymizeCustomerAction}
              confirm="Ẩn danh hoá khách này? Thông tin cá nhân sẽ bị xoá vĩnh viễn."
              label="Ẩn danh hoá"
              className="field-row mt-3"
            >
              <input type="hidden" name="id" value={c.id} />
              <Input label="Lý do / căn cứ yêu cầu *" name="reason" placeholder="Khách nhắn Zalo ngày …" className="grow min-w-56" />
              <Submit variant="danger">Ẩn danh hoá</Submit>
            </ActionForm>
          </details>
        </>
      )}
    </main>
  );
}
