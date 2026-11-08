import Link from "next/link";
import { addDays, isReportKey, parseRange, PRESETS, rangeQuery, REPORTS, type Range, type ReportKey } from "@/domain/reports";
import { catalogDb, NoDatabase } from "../danh-muc/shared";
import { todayVn } from "../van-chuyen/shared";
import { BatchReport, ChannelReport, InventoryReport, ModelReport, PnlReport, TaxReport, TransportReport } from "./sections";
import { Glyph } from "../_components/Glyph";

export const metadata = { title: "Báo cáo" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
/** Báo cáo không phụ thuộc kỳ (chụp tại hôm nay / toàn thời gian) hoặc theo năm. */
const NO_PERIOD: ReportKey[] = ["chuyen", "ton-kho"];

const href = (key: ReportKey, q: Record<string, string>) => `/bao-cao?${new URLSearchParams({ bc: key, ...q })}`;

export default async function ReportsPage({ searchParams }: PageProps<"/bao-cao">) {
  const db = await catalogDb();
  const sp = await searchParams;
  const bc = one(sp.bc);
  const key: ReportKey = isReportKey(bc) ? bc : "lai-lo";
  const today = todayVn();
  const range = parseRange({ ky: one(sp.ky), tu: one(sp.tu), den: one(sp.den) }, today);
  const rq = rangeQuery(range);
  const usesPeriod = !NO_PERIOD.includes(key);

  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Báo cáo</h1>
        {db && (
          <a href={`/bao-cao/xuat?${new URLSearchParams({ bc: key, ...rq })}`} className="btn-secondary ml-auto" download data-testid="export-xlsx">
            <Glyph name="download" size={17} />
            Xuất Excel
          </a>
        )}
      </div>
      <nav aria-label="Loại báo cáo" className="segmented mt-4">
        {REPORTS.map((r) => (
          <Link key={r.key} href={href(r.key, rq)} aria-current={r.key === key ? "page" : undefined}>
            {r.label}
          </Link>
        ))}
      </nav>
      {usesPeriod && <PeriodBar reportKey={key} range={range} today={today} />}
      <div className="mt-5">
        {!db ? (
          <NoDatabase />
        ) : key === "lai-lo" ? (
          <PnlReport db={db} range={range} />
        ) : key === "dong-may" ? (
          <ModelReport db={db} range={range} />
        ) : key === "chuyen" ? (
          <BatchReport db={db} today={today} />
        ) : key === "kenh" ? (
          <ChannelReport db={db} range={range} />
        ) : key === "van-chuyen" ? (
          <TransportReport db={db} range={range} today={today} />
        ) : key === "ton-kho" ? (
          <InventoryReport db={db} today={today} />
        ) : (
          <TaxReport db={db} year={+range.from.slice(0, 4)} reportRange={range} />
        )}
      </div>
    </main>
  );
}

function PeriodBar({ reportKey, range, today }: { reportKey: ReportKey; range: Range; today: string }) {
  const presets = reportKey === "thue" ? PRESETS.filter((p) => p.key === "nam" || p.key === "nam-truoc") : PRESETS;
  // sổ thuế theo năm: "Năm nay" sáng khi kỳ đang xem thuộc năm nay
  const year = +range.from.slice(0, 4);
  const thisYear = +today.slice(0, 4);
  const isCurrent = (k: string) => (reportKey === "thue" ? (k === "nam" ? year === thisYear : year === thisYear - 1) : range.key === k);
  return (
    <div className="card mt-3 flex flex-wrap items-end gap-3 p-3 md:p-4">
      <nav aria-label="Chọn kỳ" className="segmented">
        {presets.map((p) => (
          <Link key={p.key} href={href(reportKey, { ky: p.key })} aria-current={isCurrent(p.key) ? "page" : undefined}>
            {p.label}
          </Link>
        ))}
      </nav>
      {reportKey !== "thue" && (
        <form method="get" className="field-row" aria-label="Kỳ tuỳ chọn">
          <input type="hidden" name="bc" value={reportKey} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Từ ngày</span>
            <input type="date" name="tu" defaultValue={range.from} className="field" required />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Đến ngày</span>
            <input type="date" name="den" defaultValue={addDays(range.toExcl, -1)} className="field" required />
          </label>
          <button type="submit" className="btn-secondary">
            Xem
          </button>
        </form>
      )}
      <p className="basis-full text-sm text-muted" data-testid="period-label">
        {reportKey === "thue" ? `Năm ${range.from.slice(0, 4)}` : `${range.label} · so với ${range.prevLabel}`}
      </p>
    </div>
  );
}
