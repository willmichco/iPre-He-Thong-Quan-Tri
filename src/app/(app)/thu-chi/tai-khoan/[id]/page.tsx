import Link from "next/link";
import { notFound } from "next/navigation";
import { formatAmount } from "@/domain/ledger";
import { periodRange } from "@/domain/overview";
import { accountStatement, balanceAt, listReconciliations, LedgerError } from "@/server/ledger/service";
import { ActionForm, Checkbox, Input, Submit } from "../../../_components/form";
import { catalogDb, Empty, NoDatabase } from "../../../danh-muc/shared";
import { todayVn } from "../../../van-chuyen/shared";
import { reconcileAction } from "../../actions";
import { LedgerTable } from "../../ui";
import { BackLink } from "../../../_components/BackLink";

export const metadata = { title: "Sổ tài khoản — Thu chi" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dmy = (d: string) => d.split("-").reverse().join("/");

export default async function AccountPage({ params, searchParams }: PageProps<"/thu-chi/tai-khoan/[id]">) {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const today = todayVn();
  const month = periodRange("thang-nay", today);
  const from = isDate(one(sp.tu)) ? one(sp.tu) : month.from;
  const to = isDate(one(sp.den)) ? one(sp.den) : today;
  let st;
  try {
    st = await accountStatement(db, id, from, to);
  } catch (e) {
    if (e instanceof LedgerError && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const [recs, nowBalance] = await Promise.all([listReconciliations(db, id), balanceAt(db, id, today)]);
  const cur = st.account.currency;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <BackLink href="/thu-chi">Sổ quỹ</BackLink>
      </div>
      <section className="card p-4" aria-label="Số dư">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">{st.account.name}</h2>
          <span className={`text-2xl font-bold tabular-nums ${nowBalance < 0n ? "text-danger" : ""}`} data-testid="account-now-balance">
            {formatAmount(nowBalance, cur)}
          </span>
          <span className="text-sm text-muted">số dư hôm nay</span>
          <Link href={`/thu-chi?tk=${id}`} className="ml-auto text-sm underline">
            Lọc trong sổ quỹ
          </Link>
        </div>
      </section>

      <section className="card p-4" aria-labelledby="doi-soat">
        <h2 id="doi-soat" className="font-semibold">
          Đối soát với sao kê
        </h2>
        <p className="mt-1 text-sm text-muted">
          Nhập số dư cuối ngày trên sao kê ngân hàng (hoặc tiền mặt đếm được). Hệ thống so với số dư sổ quỹ cùng ngày; chênh lệch nghĩa là còn khoản thu / chi
          chưa ghi hoặc ghi nhầm.
        </p>
        <ActionForm action={reconcileAction} resetOnSuccess label="Đối soát" className="field-row mt-3">
          <input type="hidden" name="accountId" value={id} />
          <input type="hidden" name="currency" value={cur} />
          <Input label="Ngày sao kê *" name="asOf" type="date" defaultValue={today} className="w-40" />
          <Input
            label={`Số dư thực tế (${cur}) *`}
            name="statement"
            inputMode="decimal"
            placeholder={cur === "VND" ? "12.500.000" : "1,250.00"}
            className="w-44"
          />
          {cur === "USD" && <Input label="Tỷ giá (nếu điều chỉnh)" name="fxRate" inputMode="decimal" className="w-32" />}
          <Input label="Ghi chú" name="note" className="grow min-w-40" />
          <Checkbox label="Ghi bút toán điều chỉnh cho khớp" name="adjust" />
          <Submit>Đối soát</Submit>
        </ActionForm>
        {recs.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm tabular-nums" aria-label="Lịch sử đối soát">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1 font-normal">Ngày</th>
                  <th className="py-1 text-right font-normal">Sao kê</th>
                  <th className="py-1 text-right font-normal">Hệ thống</th>
                  <th className="py-1 text-right font-normal">Chênh lệch</th>
                  <th className="py-1 pl-3 font-normal">Xử lý</th>
                </tr>
              </thead>
              <tbody>
                {recs.map((r) => (
                  <tr key={r.id} className="border-t border-border" data-testid="reconciliation">
                    <td className="py-1">{dmy(r.asOf)}</td>
                    <td className="py-1 text-right">{formatAmount(r.statementCents, cur)}</td>
                    <td className="py-1 text-right">{formatAmount(r.systemCents, cur)}</td>
                    <td className={`py-1 text-right ${r.diffCents === 0n ? "text-[var(--ok)]" : "text-[var(--warn)] font-semibold"}`}>
                      {r.diffCents === 0n ? "Khớp ✓" : formatAmount(r.diffCents, cur)}
                    </td>
                    <td className="py-1 pl-3 text-muted">{r.diffCents === 0n ? "" : r.adjusted ? "đã ghi điều chỉnh" : "chưa xử lý"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="so-tk">
        <div className="card flex flex-wrap items-end gap-3 p-4">
          <h2 id="so-tk" className="self-center font-semibold">
            Sổ tài khoản
          </h2>
          <form method="get" className="field-row ml-auto" aria-label="Chọn kỳ">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Từ ngày</span>
              <input type="date" name="tu" defaultValue={from} className="field" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Đến ngày</span>
              <input type="date" name="den" defaultValue={to} className="field" />
            </label>
            <button type="submit" className="btn-secondary">
              Xem
            </button>
          </form>
        </div>
        <p className="mt-2 text-sm tabular-nums">
          Đầu kỳ {dmy(from)}: <b>{formatAmount(st.openingCents, cur)}</b> → cuối kỳ {dmy(to)}:{" "}
          <b data-testid="closing-balance">{formatAmount(st.closingCents, cur)}</b>
        </p>
        <div className="mt-2">
          {st.rows.length === 0 ? <Empty>Không có bút toán trong kỳ.</Empty> : <LedgerTable rows={st.rows} showAccount={false} balances />}
        </div>
      </section>
    </div>
  );
}
