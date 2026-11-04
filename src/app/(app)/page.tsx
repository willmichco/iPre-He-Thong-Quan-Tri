import Link from "next/link";
import { CATEGORY_LABEL, type Category } from "@/domain/catalog";
import { formatVnd } from "@/domain/costing";
import { ALERT_LEVEL_ICON, ALERT_LEVEL_LABEL, changeBp, formatBp, parsePeriod, PERIOD_LABEL, PERIODS, periodRange, shortVnd, STAGES } from "@/domain/overview";
import { BATCH_STATUS_LABEL } from "@/domain/purchasing";
import { getOverview } from "@/server/overview/service";
import { HBars, MonthBars } from "./_overview/charts";
import { catalogDb, NoDatabase } from "./danh-muc/shared";
import { todayVn } from "./van-chuyen/shared";

export const metadata = { title: "Tổng quan" };

function Delta({ bp, suffix = "" }: { bp: number | null; suffix?: string }) {
  if (bp === null) return null;
  const up = bp > 0;
  const down = bp < 0;
  return (
    <span className={up ? "text-[var(--ok)]" : down ? "text-danger" : "text-muted"}>
      {up ? "▲" : down ? "▼" : "■"} {formatBp(Math.abs(bp)).replace(" %", suffix || " %")}
    </span>
  );
}

function Kpi({ label, value, sub, testid, href }: { label: string; value: string; sub: React.ReactNode; testid: string; href?: string }) {
  const body = (
    <>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums" data-testid={`${testid}-value`}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </>
  );
  return href ? (
    <Link href={href} className="card block p-4 hover:border-primary" data-testid={testid}>
      {body}
    </Link>
  ) : (
    <div className="card p-4" data-testid={testid}>
      {body}
    </div>
  );
}

const levelClass = { critical: "border-[var(--danger)]", warning: "border-[var(--warn)]", info: "border-border" } as const;

export default async function OverviewPage({ searchParams }: PageProps<"/">) {
  const db = await catalogDb();
  const raw = (await searchParams).ky;
  const key = parsePeriod(Array.isArray(raw) ? raw[0] : raw);
  if (!db)
    return (
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        <h1 className="text-2xl font-bold">Tổng quan</h1>
        <div className="mt-4">
          <NoDatabase />
        </div>
      </main>
    );
  const today = todayVn();
  const o = await getOverview(db, periodRange(key, today), today);
  const { current: c, previous: p } = o;
  const marginDelta = c.marginBp !== null && p.marginBp !== null ? c.marginBp - p.marginBp : null;
  const visibleStages = o.capital.stages.filter((s) => s.key !== "warranty" || s.itemCount > 0);

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Tổng quan</h1>
        <div className="flex gap-2">
          <Link href="/chuyen-hang" className="btn-secondary">
            + Chuyến
          </Link>
          <Link href="/ban-hang/moi" className="btn-primary">
            + Bán
          </Link>
        </div>
      </div>

      <nav aria-label="Kỳ báo cáo" className="mt-3 flex gap-1 overflow-x-auto border-b border-border">
        {PERIODS.map((k) => (
          <Link
            key={k}
            href={k === "thang-nay" ? "/" : `/?ky=${k}`}
            aria-current={k === key ? "page" : undefined}
            className={`whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px ${k === key ? "border-primary text-primary font-semibold" : "border-transparent text-muted"}`}
          >
            {PERIOD_LABEL[k]}
          </Link>
        ))}
        <span className="ml-auto hidden self-center whitespace-nowrap px-2 text-xs text-muted sm:inline">
          {o.period.label} · so với {o.period.prevLabel}
        </span>
      </nav>

      {/* Thẻ KPI */}
      <section aria-label="Chỉ số chính" className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          testid="kpi-capital"
          label="Vốn trong hàng"
          value={shortVnd(o.capital.totalVnd)}
          href="/kho"
          sub={
            <>
              {o.capital.itemCount} máy · {shortVnd(o.capital.onTheWayVnd)} đang trên đường
            </>
          }
        />
        <Kpi
          testid="kpi-revenue"
          label={`Doanh thu ${key === "nam-nay" ? "năm" : "tháng"}`}
          value={shortVnd(c.revenueVnd)}
          href="/ban-hang"
          sub={
            <>
              {c.units} máy <Delta bp={changeBp(c.revenueVnd, p.revenueVnd)} />
            </>
          }
        />
        <Kpi
          testid="kpi-profit"
          label="Lãi máy"
          value={`${c.profitVnd > 0n ? "+" : ""}${shortVnd(c.profitVnd)}`}
          href="/ban-hang"
          sub={
            <>
              {c.provisional > 0 ? <span className="text-[var(--warn)]">{c.provisional} máy tạm tính</span> : c.units > 0 ? "đã chốt" : "chưa bán máy nào"}{" "}
              <Delta bp={changeBp(c.profitVnd, p.profitVnd)} />
            </>
          }
        />
        <Kpi
          testid="kpi-margin"
          label="Biên lãi"
          value={formatBp(c.marginBp)}
          sub={<>{marginDelta !== null ? <Delta bp={marginDelta} suffix=" điểm" /> : "lãi máy / doanh thu"}</>}
        />
        <Kpi
          testid="kpi-stock"
          label="Tồn kho SG"
          value={o.stock.avgDays === null ? "—" : `${o.stock.avgDays} ngày`}
          href="/kho"
          sub={
            <>
              tuổi tồn TB · {o.stock.count} máy · {shortVnd(o.stock.costVnd)}
            </>
          }
        />
      </section>
      {c.opexVnd !== 0n && (
        <p className="mt-2 text-xs text-muted" data-testid="net-profit">
          Lãi ròng sau chi phí vận hành ({shortVnd(c.opexVnd)}): <strong className="text-text">{shortVnd(c.netProfitVnd)}</strong> — chưa trừ thuế.
        </p>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[3fr_2fr]">
        {/* Vốn theo chặng */}
        <section className="card p-4" aria-labelledby="von-chang">
          <h2 id="von-chang" className="font-semibold">
            Vốn đang nằm ở đâu
          </h2>
          <p className="text-xs text-muted">Theo giá vốn hiện tại · bấm một chặng để xem danh sách máy · máy khách đã cọc tính ở chỗ máy đang nằm</p>
          {/* thanh tỷ trọng */}
          {o.capital.totalVnd > 0n && (
            <div className="mt-3 flex h-3 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
              {visibleStages
                .filter((s) => s.shareBp > 0)
                .map((s, k, arr) => (
                  <span
                    key={s.key}
                    title={`${s.label}: ${formatBp(s.shareBp)}`}
                    className="bg-primary"
                    style={{ width: `${s.shareBp / 100}%`, opacity: s.key === "sg" ? 1 : 0.35 + (0.55 * k) / Math.max(arr.length, 1) }}
                  />
                ))}
            </div>
          )}
          <div className="mt-3">
            <HBars
              testid="capital-stages"
              label="Vốn theo chặng"
              rows={visibleStages.map((s) => ({
                key: s.key,
                label: s.label,
                value: s.capitalVnd,
                note: `${s.itemCount} máy${s.shareBp ? ` · ${formatBp(s.shareBp).replace(",00 ", " ")}` : ""}`,
                href: `/kho?chang=${s.key}`,
              }))}
            />
          </div>
          <p className="mt-3 text-sm">
            Tổng: <strong className="tabular-nums">{formatVnd(o.capital.totalVnd)} ₫</strong> · {o.capital.itemCount} máy
          </p>
        </section>

        {/* Cần xử lý */}
        <section className="card p-4" aria-labelledby="can-xu-ly">
          <h2 id="can-xu-ly" className="font-semibold">
            Cần xử lý <span className="text-sm font-normal text-muted">· {o.alerts.length}</span>
          </h2>
          {o.alerts.length === 0 ? (
            <p className="mt-2 text-sm text-muted" data-testid="no-alerts">
              ✓ Không có việc gì cần xử lý.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2" data-testid="alerts">
              {o.alerts.map((a, k) => (
                <li key={`${a.kind}-${k}`} data-kind={a.kind}>
                  <Link href={a.href} className={`block rounded-lg border-l-4 bg-[var(--bg)] px-3 py-2 hover:underline ${levelClass[a.level]}`}>
                    <span className="text-sm">
                      <span aria-hidden>{ALERT_LEVEL_ICON[a.level]} </span>
                      <span className="sr-only">{ALERT_LEVEL_LABEL[a.level]}: </span>
                      {a.title}
                    </span>
                    {a.detail && <span className="block text-xs text-muted">{a.detail}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 border-t border-border pt-3 text-sm" data-testid="tax-threshold">
            <div className="flex justify-between">
              <span>Doanh thu năm {today.slice(0, 4)}</span>
              <span className="tabular-nums">
                {shortVnd(o.yearRevenueVnd)} / {shortVnd(o.settings.revenueThresholdVnd)}
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-[var(--bg)]" aria-hidden>
              <div
                className={`h-2 rounded-full ${(o.taxBp ?? 0) >= o.settings.thresholdWarningRatio * 10000 ? "bg-danger" : "bg-primary"}`}
                style={{ width: `${Math.min((o.taxBp ?? 0) / 100, 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted">
              {formatBp(o.taxBp)} ngưỡng doanh thu hộ kinh doanh đã cấu hình · khách còn nợ {shortVnd(o.receivableVnd)}
            </p>
          </div>
        </section>
      </div>

      {/* Biểu đồ 12 tháng */}
      <section aria-label="Doanh thu và lãi 12 tháng" className="mt-5 grid gap-5 md:grid-cols-2">
        <MonthBars testid="chart-revenue" title="Doanh thu" points={o.months.map((m) => ({ month: m.month, value: m.revenueVnd, units: m.units }))} />
        <MonthBars testid="chart-profit" title="Lãi máy" points={o.months.map((m) => ({ month: m.month, value: m.profitVnd, units: m.units }))} />
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="card p-4" aria-labelledby="lai-dong-may">
          <h2 id="lai-dong-may" className="font-semibold">
            Lãi theo dòng máy <span className="text-sm font-normal text-muted">· {o.period.label}</span>
          </h2>
          {o.categories.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Chưa bán máy nào trong kỳ.</p>
          ) : (
            <div className="mt-3">
              <HBars
                testid="profit-categories"
                label="Lãi theo dòng máy"
                rows={o.categories.map((r) => ({
                  key: r.category,
                  label: CATEGORY_LABEL[r.category as Category] ?? r.category,
                  value: r.profitVnd,
                  note: `${r.units} máy · DT ${shortVnd(r.revenueVnd)}`,
                }))}
              />
            </div>
          )}
        </section>

        <section className="card p-4" aria-labelledby="tuoi-ton">
          <h2 id="tuoi-ton" className="font-semibold">
            Tuổi tồn kho SG
          </h2>
          <div className="mt-3">
            <HBars
              testid="aging-buckets"
              label="Tuổi tồn kho"
              rows={o.stock.buckets.map((b) => ({ key: b.bucket, label: b.label, value: b.costVnd, note: `${b.count} máy` }))}
            />
          </div>
          <p className="mt-2 text-xs text-muted">Cảnh báo khi máy tồn quá {o.settings.agingDays} ngày.</p>
        </section>
      </div>

      {/* Chuyến đang chạy */}
      <section className="mt-5" aria-labelledby="chuyen-chay">
        <h2 id="chuyen-chay" className="text-lg font-semibold">
          Chuyến đang chạy <span className="text-sm font-normal text-muted">· {o.activeBatches.length}</span>
        </h2>
        {o.activeBatches.length === 0 ? (
          <p className="card mt-2 p-4 text-sm text-muted">Không có chuyến nào đang mua / đang về.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2" data-testid="active-batches">
            {o.activeBatches.map((b) => {
              const segs = STAGES.filter((s) => s.key !== "warranty").map((s) => ({ ...s, n: b.byStage[s.key] ?? 0 }));
              const denom = b.itemCount || 1;
              return (
                <li key={b.id} aria-label={b.code}>
                  <Link href={`/chuyen-hang/${b.id}`} className="card block p-3 hover:border-primary">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span className="font-mono font-semibold">{b.code}</span>
                      <span className="text-muted">
                        {BATCH_STATUS_LABEL[b.status] ?? b.status}
                        {b.status === "ARRIVED" && !b.finalized ? " · chưa chốt chi phí" : ""} · {b.itemCount} máy · {shortVnd(b.capitalVnd)}
                      </span>
                    </div>
                    <div className="mt-2 flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-[var(--bg)]" aria-hidden>
                      {segs
                        .filter((s) => s.n > 0)
                        .map((s) => (
                          <span
                            key={s.key}
                            title={`${s.label}: ${s.n}`}
                            className={s.key === "sg" ? "bg-primary" : "bg-primary opacity-40"}
                            style={{ width: `${(s.n / denom) * 100}%` }}
                          />
                        ))}
                      {b.soldCount > 0 && (
                        <span title={`Đã bán: ${b.soldCount}`} className="bg-[var(--ok)]" style={{ width: `${(b.soldCount / denom) * 100}%` }} />
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {segs
                        .filter((s) => s.n > 0)
                        .map((s) => `${s.label} ${s.n}`)
                        .concat(b.soldCount > 0 ? [`Đã bán ${b.soldCount}`] : [])
                        .join(" · ") || "—"}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
