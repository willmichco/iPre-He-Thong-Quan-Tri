import { ACCOUNT_KIND_LABEL, ACCOUNT_KINDS } from "@/domain/catalog";
import { listAccounts, type AccountRow } from "@/server/catalog/service";
import { deleteAccountAction, saveAccountAction } from "../actions";
import { catalogDb, Empty, NoDatabase } from "../shared";
import { ActionForm, Checkbox, Input, Select, Submit } from "../../_components/form";

export const metadata = { title: "Danh mục — Tài khoản tiền" };

const KIND_OPTIONS = ACCOUNT_KINDS.map((k) => [k, ACCOUNT_KIND_LABEL[k]] as const);
const CURRENCY_OPTIONS = [
  ["VND", "VND"],
  ["USD", "USD"],
] as const;
const money = (v: string, cur: string) =>
  `${Number(v).toLocaleString("vi-VN", { minimumFractionDigits: cur === "USD" ? 2 : 0, maximumFractionDigits: 2 })} ${cur === "USD" ? "USD" : "₫"}`;

function AccountFields({ a }: { a?: AccountRow }) {
  return (
    <>
      <Input label="Tên tài khoản *" name="name" defaultValue={a?.name} placeholder="Tiền mặt, VCB, thẻ Visa…" className="grow min-w-56" />
      <Select label="Loại" name="kind" options={KIND_OPTIONS} defaultValue={a?.kind ?? "BANK"} />
      <Select label="Tiền tệ" name="currency" options={CURRENCY_OPTIONS} defaultValue={a?.currency ?? "VND"} />
      <Input
        label="Số dư đầu kỳ"
        name="openingBalance"
        inputMode="decimal"
        defaultValue={a ? String(Number(a.openingBalance)) : ""}
        placeholder="0"
        className="w-40"
      />
      <Checkbox label="Đang dùng" name="isActive" defaultChecked={a ? a.isActive : true} />
    </>
  );
}

export default async function AccountsPage() {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const accounts = await listAccounts(db);
  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4" aria-labelledby="them-tk">
        <h2 id="them-tk" className="font-semibold">
          Thêm tài khoản tiền
        </h2>
        <p className="mt-1 text-sm text-muted">Nơi tiền ra vào: tiền mặt, ngân hàng, thẻ thanh toán đơn Mỹ, ví điện tử.</p>
        <ActionForm action={saveAccountAction} resetOnSuccess label="Thêm tài khoản" className="mt-3 field-row">
          <AccountFields />
          <Submit>Thêm</Submit>
        </ActionForm>
      </section>
      {accounts.length === 0 ? (
        <Empty>Chưa có tài khoản nào.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {accounts.map((a) => (
            <li key={a.id} className="card p-4" aria-label={a.name}>
              <div className="flex flex-wrap items-baseline gap-2">
                <b className={a.isActive ? "" : "text-muted line-through"}>{a.name}</b>
                <span className="text-sm text-muted">
                  {ACCOUNT_KIND_LABEL[a.kind]} · {a.currency} · đầu kỳ {money(a.openingBalance, a.currency)} · {a.usageCount} giao dịch
                </span>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-muted">Sửa / xoá</summary>
                <ActionForm action={saveAccountAction} label={`Sửa ${a.name}`} className="mt-3 field-row">
                  <input type="hidden" name="id" value={a.id} />
                  <AccountFields a={a} />
                  <Submit variant="secondary">Lưu</Submit>
                </ActionForm>
                <ActionForm action={deleteAccountAction} confirm={`Xoá tài khoản ${a.name}?`} label={`Xoá ${a.name}`}>
                  <input type="hidden" name="id" value={a.id} />
                  <Submit variant="danger">Xoá</Submit>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
