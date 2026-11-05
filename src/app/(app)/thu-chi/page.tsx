import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { formatAmount } from "@/domain/ledger";
import { periodRange, shortVnd, type PeriodKey } from "@/domain/overview";
import { ACCOUNT_KIND_LABEL } from "@/domain/catalog";
import { cashSummary, getDebts, listAccountBalances, listCategories, listTransactions, weeklyCashflow } from "@/server/ledger/service";
import { catalogDb, Empty, NoDatabase } from "../danh-muc/shared";
import { todayVn } from "../van-chuyen/shared";
import { CashflowBars, categoryOptions, EntryForm, LedgerTable, TransferForm } from "./ui";

export const metadata = { title: "Thu chi" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const QUICK: { key: PeriodKey; label: string }[] = [
  { key: "thang-nay", label: "Tháng này" },
  { key: "thang-truoc", label: "Tháng trước" },
  { key: "nam-nay", label: "Năm nay" },
];

export default async function CashPage({ searchParams }: PageProps<"/thu-chi">) {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const sp = await searchParams;
  const today = todayVn();
  const f = {
    accountId: one(sp.tk) || null,
    category: one(sp.dm) || null,
    from: isDate(one(sp.tu)) ? one(sp.tu) : null,
    to: isDate(one(sp.den)) ? one(sp.den) : null,
    source: one(sp.nguon) === "tay" ? ("MANUAL" as const) : one(sp.nguon) === "tu-dong" ? ("AUTO" as const) : null,
    q: one(sp.q) || null,
  };
  const [accounts, cats, weeks, debts, page] = await Promise.all([
    listAccountBalances(db),
    listCategories(db),
    weeklyCashflow(db, today),
    getDebts(db),
    listTransactions(db, f),
  ]);
  const summary = await cashSummary(db, accounts, debts);
  const active = accounts.filter((a) => a.isActive).map((a) => ({ id: a.id, name: a.name, currency: a.currency }));
  const filtered = !!(f.accountId || f.category || f.from || f.to || f.source || f.q);
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ tk: f.accountId ?? "", dm: f.category ?? "", nguon: one(sp.nguon), q: f.q ?? "", ...extra })) if (v) p.set(k, v);
    return `/thu-chi?${p}`;
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Tổng hợp */}
      <section aria-label="Tổng hợp tiền" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi
          label="Tiền hiện có"
          value={summary.cashVnd}
          testid="kpi-cash"
          note={summary.unconvertedUsdCents ? `+ ${formatAmount(summary.unconvertedUsdCents, "USD")} chưa quy đổi` : undefined}
        />
        <Kpi label="Vốn trong hàng" value={summary.capitalInGoodsVnd} testid="kpi-goods" note="máy chưa bán, theo giá vốn" />
        <Kpi label="Phải thu" value={summary.receivableVnd} testid="kpi-receivable" href="/thu-chi/cong-no" />
        <Kpi label="Phải trả" value={summary.payableVnd} testid="kpi-payable" href="/thu-chi/cong-no#phai-tra" danger={summary.payableVnd > 0n} />
        <Kpi label="Tài sản lưu động ròng" value={summary.netLiquidVnd} testid="kpi-net" note="tiền + hàng + phải thu − phải trả" strong />
      </section>

      {/* Tài khoản */}
      <section aria-labelledby="tk">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="tk" className="font-semibold">
            Tài khoản
          </h2>
          <Link href="/danh-muc/tai-khoan" className="text-sm text-muted underline">
            Thêm / sửa tài khoản
          </Link>
        </div>
        {accounts.length === 0 ? (
          <div className="mt-2">
            <Empty>Chưa có tài khoản — thêm ở Danh mục › Tài khoản tiền.</Empty>
          </div>
        ) : (
          <ul className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/thu-chi/tai-khoan/${a.id}`}
                  className={`card block p-4 transition-transform hover:-translate-y-0.5 ${a.isActive ? "" : "opacity-60"}`}
                  aria-label={`Tài khoản ${a.name}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <b className="truncate">{a.name}</b>
                    <span className="text-xs text-muted">{ACCOUNT_KIND_LABEL[a.kind as keyof typeof ACCOUNT_KIND_LABEL] ?? a.kind}</span>
                  </div>
                  <p className={`mt-1 text-xl font-semibold tabular-nums ${a.balanceCents < 0n ? "text-danger" : ""}`} data-testid="account-balance">
                    {formatAmount(a.balanceCents, a.currency)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {a.currency === "USD" && a.balanceVnd !== null && <>≈ {shortVnd(a.balanceVnd)} · </>}
                    {a.txnCount} bút toán ·{" "}
                    {a.lastReconciliation ? (
                      a.lastReconciliation.diffCents === 0n ? (
                        <span className="text-[var(--ok)]">khớp sao kê {a.lastReconciliation.asOf.split("-").reverse().join("/")}</span>
                      ) : (
                        <span className="text-[var(--warn)]">lệch {formatAmount(a.lastReconciliation.diffCents, a.currency)}</span>
                      )
                    ) : (
                      "chưa đối soát"
                    )}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        {/* Nhập tay */}
        {active.length > 0 && (
          <section aria-label="Ghi sổ" className="grid gap-3">
            <details className="card p-4" open={!filtered && page.total === 0}>
              <summary className="cursor-pointer font-semibold">+ Khoản chi vận hành / thu khác</summary>
              <p className="mt-1 text-sm text-muted">
                Quảng cáo, điện thoại, phần mềm, mặt bằng… (trừ vào lãi ròng). Chi phí của từng chuyến / kiện nhập ở trang chuyến hoặc kiện.
              </p>
              <EntryForm accounts={active} categories={categoryOptions(cats, "OPERATING")} today={today} label="Khoản chi vận hành" />
            </details>
            <details className="card p-4">
              <summary className="cursor-pointer font-semibold">+ Góp / rút vốn · nộp thuế</summary>
              <p className="mt-1 text-sm text-muted">Góp vốn, rút vốn / rút lãi không phải doanh thu hay chi phí; nộp thuế được tính là chi phí vận hành.</p>
              <EntryForm accounts={active} categories={categoryOptions(cats, "CAPITAL")} today={today} label="Góp rút vốn" />
            </details>
            {active.length > 1 && (
              <details className="card p-4">
                <summary className="cursor-pointer font-semibold">⇄ Chuyển tiền / đổi ngoại tệ</summary>
                <p className="mt-1 text-sm text-muted">
                  Ghi 2 bút toán (ra – vào), không ảnh hưởng lãi lỗ. Phí chuyển (nếu có) ghi riêng là khoản chi vận hành.
                </p>
                <TransferForm accounts={active} today={today} />
              </details>
            )}
          </section>
        )}

        <CashflowBars weeks={weeks} />
      </div>

      {/* Sổ quỹ */}
      <section aria-labelledby="so-quy">
        <h2 id="so-quy" className="font-semibold">
          Sổ quỹ
        </h2>
        <form method="get" role="search" aria-label="Lọc sổ quỹ" className="field-row mt-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Tài khoản</span>
            <select name="tk" defaultValue={f.accountId ?? ""} className="field">
              <option value="">Tất cả</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Danh mục</span>
            <select name="dm" defaultValue={f.category ?? ""} className="field">
              <option value="">Tất cả</option>
              {cats.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.direction === "IN" ? "Thu" : "Chi"} · {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Nguồn</span>
            <select name="nguon" defaultValue={one(sp.nguon)} className="field">
              <option value="">Tất cả</option>
              <option value="tu-dong">Tự sinh từ chứng từ</option>
              <option value="tay">Nhập tay / chuyển tiền</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Từ ngày</span>
            <input type="date" name="tu" defaultValue={f.from ?? ""} className="field" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Đến ngày</span>
            <input type="date" name="den" defaultValue={f.to ?? ""} className="field" />
          </label>
          <label className="grow flex flex-col gap-1 text-sm min-w-40">
            <span className="text-muted">Tìm ghi chú / đối tượng</span>
            <input name="q" defaultValue={f.q ?? ""} className="field" />
          </label>
          <button type="submit" className="btn-secondary">
            Lọc
          </button>
          {filtered && (
            <Link href="/thu-chi" className="btn-secondary">
              Bỏ lọc
            </Link>
          )}
        </form>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {QUICK.map((p) => {
            const r = periodRange(p.key, today);
            const to = dayBefore(r.to);
            const on = f.from === r.from && f.to === to;
            return (
              <Link key={p.key} href={qs({ tu: r.from, den: to })} className="chip" aria-current={on ? "true" : undefined}>
                {p.label}
              </Link>
            );
          })}
        </p>
        <p className="mt-2 text-sm tabular-nums" data-testid="ledger-totals">
          {page.total} bút toán · thu <b className="text-[var(--ok)]">{formatVnd(page.inVnd)} ₫</b> · chi <b>{formatVnd(page.outVnd)} ₫</b> · ròng{" "}
          <b className={page.inVnd < page.outVnd ? "text-danger" : ""}>{formatVnd(page.inVnd - page.outVnd)} ₫</b>
          {!f.accountId && <span className="text-muted"> (không tính chuyển tiền nội bộ)</span>}
        </p>
        <div className="mt-2">
          {page.rows.length === 0 ? (
            <Empty>{filtered ? "Không có bút toán nào khớp bộ lọc." : "Chưa có bút toán nào."}</Empty>
          ) : (
            <LedgerTable rows={page.rows} />
          )}
        </div>
        {page.truncated && (
          <p className="mt-2 text-sm text-muted">Đang hiện {page.rows.length} bút toán mới nhất — lọc theo ngày để xem các bút toán cũ hơn.</p>
        )}
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
  href,
  testid,
  danger = false,
  strong = false,
}: {
  label: string;
  value: bigint;
  note?: string;
  href?: string;
  testid: string;
  danger?: boolean;
  strong?: boolean;
}) {
  const body = (
    <>
      <p className="text-xs text-muted">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold tabular-nums ${danger ? "text-[var(--warn)]" : value < 0n ? "text-danger" : ""}`}
        data-testid={`${testid}-value`}
      >
        {formatVnd(value)} ₫
      </p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </>
  );
  const cls = `card p-4 ${strong ? "col-span-2 md:col-span-1 ring-1 ring-[var(--primary-tint)]" : ""}`;
  return href ? (
    <Link href={href} className={`${cls} block transition-transform hover:-translate-y-0.5`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
