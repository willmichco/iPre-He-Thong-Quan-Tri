/**
 * Các báo cáo (thành phần máy chủ). Mỗi báo cáo đọc số liệu qua src/server/reports/service.ts — cùng hàm với xuất Excel.
 * Tiền hiện đủ số (vi-VN); tỷ lệ là điểm cơ bản; số âm có dấu "−" và màu cảnh báo (không chỉ dựa vào màu).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { CATEGORY_LABEL, LEG_LABEL } from "@/domain/catalog";
import { formatVnd, percentBp } from "@/domain/costing/money";
import { formatBp, shortVnd } from "@/domain/overview";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing-core";
import { byQuarter, median, pnlStatement, quadrant, QUADRANT_LABEL, thresholdStatus, type Range } from "@/domain/reports";
import { CHANNEL_LABEL } from "@/domain/sales-core";
import type { Db } from "@/server/actions/run";
import * as r from "@/server/reports/service";
import { Empty } from "../danh-muc/shared";

const mLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const dmy = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "—");
const margin = (profit: bigint, revenue: bigint) => (revenue > 0n ? percentBp(profit, revenue) : null);
const money = (v: bigint) => <span className={v < 0n ? "text-danger" : ""}>{formatVnd(v)}</span>;
const dec = (v: number | null) => (v === null ? "—" : v.toLocaleString("vi-VN", { maximumFractionDigits: 1 }));

/** Bảng số: cột đầu là nhãn, các cột sau canh phải, số dạng bảng. */
function Table({ label, head, rows, foot }: { label: string; head: string[]; rows: ReactNode[][]; foot?: ReactNode[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm tabular-nums" aria-label={label}>
        <thead className="text-left text-muted">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={`whitespace-nowrap px-3 py-2 font-normal ${i ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, k) => (
            <tr key={k} className="border-t border-border">
              {cells.map((c, i) => (
                <td key={i} className={`px-3 py-2 ${i ? "whitespace-nowrap text-right" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="border-t-2 border-border font-semibold">
              {foot.map((c, i) => (
                <td key={i} className={`px-3 py-2 ${i ? "whitespace-nowrap text-right" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Change({ bp }: { bp: number | null }) {
  if (bp === null) return <span className="text-muted">—</span>;
  return <span className={bp < 0 ? "text-danger" : bp > 0 ? "text-[var(--ok)]" : ""}>{`${bp > 0 ? "▲ " : bp < 0 ? "▼ " : ""}${formatBp(Math.abs(bp))}`}</span>;
}

function Bar({ value, max }: { value: bigint; max: bigint }) {
  const w = max > 0n && value > 0n ? Math.max(2, Math.round((Number(value) / Number(max)) * 100)) : 0;
  return (
    <span className="ml-auto block h-1.5 w-24 overflow-hidden rounded-full bg-[var(--fill)]" aria-hidden>
      <span className="block h-full rounded-full bg-[var(--primary)]" style={{ width: `${w}%` }} />
    </span>
  );
}

// ---- Lãi lỗ ---------------------------------------------------------------------------------------------

export async function PnlReport({ db, range }: { db: Db; range: Range }) {
  const [cur, prev, months, opex] = await Promise.all([
    r.pnlTotals(db, range.from, range.toExcl),
    r.pnlTotals(db, range.prevFrom, range.prevToExcl),
    r.monthlyPnl(db, range.from, range.toExcl),
    r.opexByCategory(db, range.from, range.toExcl),
  ]);
  const lines = pnlStatement(cur, prev);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="kqkd">
        <h2 id="kqkd" className="font-semibold">
          Kết quả kinh doanh
        </h2>
        <p className="mt-1 text-sm text-muted">
          {cur.units} máy bán trong kỳ
          {cur.provisional > 0 && <> · {cur.provisional} máy lãi còn “Tạm tính” (chuyến chưa chốt chi phí) — số có thể đổi khi chốt</>}
        </p>
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm tabular-nums" aria-label="Kết quả kinh doanh" data-testid="pnl-statement">
            <thead className="text-left text-muted">
              <tr>
                <th className="px-3 py-2 font-normal">Chỉ tiêu</th>
                <th className="px-3 py-2 text-right font-normal">{range.label}</th>
                <th className="px-3 py-2 text-right font-normal">% DT</th>
                <th className="px-3 py-2 text-right font-normal">{range.prevLabel}</th>
                <th className="px-3 py-2 text-right font-normal">Thay đổi</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr
                  key={l.key}
                  data-line={l.key}
                  className={`border-t border-border ${l.kind === "line" ? "" : "font-semibold"} ${l.kind === "total" ? "border-t-2 text-base" : ""}`}
                >
                  <td className={`px-3 py-2 ${l.kind === "line" && l.minus ? "pl-6" : ""}`}>{l.label}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{l.minus && l.current !== 0n ? <>−{formatVnd(l.current)}</> : money(l.current)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-muted">{formatBp(l.ofRevenueBp)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-muted">
                    {l.minus && l.previous !== 0n ? <>−{formatVnd(l.previous)}</> : formatVnd(l.previous)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Change bp={l.minus && l.changeBp !== null ? -l.changeBp : l.changeBp} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-muted">Thay đổi của dòng chi phí: ▲ xanh = chi ít hơn kỳ trước. Lãi ròng chưa trừ thuế hộ kinh doanh.</p>
      </section>

      {months.length > 1 && (
        <section aria-labelledby="theo-thang">
          <h2 id="theo-thang" className="font-semibold">
            Theo tháng
          </h2>
          <div className="mt-2">
            <Table
              label="Lãi lỗ theo tháng"
              head={["Tháng", "Số máy", "Doanh thu", "Giá vốn", "Lãi gộp", "Chi phí bán", "Vận hành", "Lãi ròng"]}
              rows={months.map((m) => [
                mLabel(m.month),
                m.units,
                formatVnd(m.revenueVnd),
                formatVnd(m.cogsVnd),
                money(m.grossVnd),
                formatVnd(m.sellingVnd),
                formatVnd(m.opexVnd),
                <b key="n">{money(m.netVnd)}</b>,
              ])}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="van-hanh">
        <h2 id="van-hanh" className="font-semibold">
          Chi phí vận hành theo danh mục
        </h2>
        <div className="mt-2">
          {opex.length === 0 ? (
            <Empty>Không có chi phí vận hành trong kỳ.</Empty>
          ) : (
            <Table
              label="Chi phí vận hành"
              head={["Danh mục", "Số tiền", ""]}
              rows={opex.map((o) => [o.name, formatVnd(o.amountVnd), <Bar key="b" value={o.amountVnd} max={opex[0].amountVnd} />])}
              foot={["Cộng", formatVnd(opex.reduce((s, o) => s + o.amountVnd, 0n)), ""]}
            />
          )}
        </div>
      </section>
    </div>
  );
}

// ---- Dòng máy -------------------------------------------------------------------------------------------

export async function ModelReport({ db, range }: { db: Db; range: Range }) {
  const { rows, medianDays } = await r.byModel(db, range.from, range.toExcl);
  if (!rows.length) return <Empty>Không có máy nào bán trong kỳ.</Empty>;
  const medMargin = median(rows.flatMap((x) => margin(x.profitVnd, x.revenueVnd) ?? []));
  const rev = rows.reduce((s, x) => s + x.revenueVnd, 0n);
  const profit = rows.reduce((s, x) => s + x.profitVnd, 0n);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        Xếp theo lãi. “Ngày bán” = số ngày từ khi máy về SG tới khi bán. Xếp loại so với trung vị của chính danh sách
        {medMargin !== null && ` (biên lãi ${formatBp(Math.round(medMargin))}`}
        {medianDays !== null && `, ${dec(medianDays)} ngày)`}.
      </p>
      <Table
        label="Lãi theo dòng máy"
        head={["Dòng máy", "Bán", "Doanh thu", "Lãi", "Biên lãi", "Ngày bán TB", "Đang tồn", "Xếp loại"]}
        rows={rows.map((x) => {
          const mg = margin(x.profitVnd, x.revenueVnd);
          const q = medMargin === null || medianDays === null ? null : quadrant(mg, x.avgDaysToSell, medMargin, medianDays);
          return [
            <span key="m">
              {x.model} <span className="text-xs text-muted">{CATEGORY_LABEL[x.category as keyof typeof CATEGORY_LABEL] ?? x.category}</span>
              {x.provisional > 0 && <span className="ml-1 text-xs text-[var(--warn)]">{x.provisional} tạm tính</span>}
            </span>,
            x.units,
            formatVnd(x.revenueVnd),
            money(x.profitVnd),
            formatBp(mg),
            dec(x.avgDaysToSell),
            x.inStock,
            q ? <span className={q === "STAR" ? "text-[var(--ok)]" : q === "WEAK" ? "text-[var(--warn)]" : "text-muted"}>{QUADRANT_LABEL[q]}</span> : "—",
          ];
        })}
        foot={[
          "Cộng",
          rows.reduce((s, x) => s + x.units, 0),
          formatVnd(rev),
          money(profit),
          formatBp(margin(profit, rev)),
          "",
          rows.reduce((s, x) => s + x.inStock, 0),
          "",
        ]}
      />
    </div>
  );
}

// ---- Chuyến ---------------------------------------------------------------------------------------------

export async function BatchReport({ db, today }: { db: Db; today: string }) {
  const rows = await r.byBatch(db, today);
  if (!rows.length) return <Empty>Chưa có chuyến nào.</Empty>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        Toàn bộ chuyến, xếp theo ROI trên máy đã bán. Chu kỳ vốn = từ ngày đặt đơn đầu tiên tới khi bán máy cuối (chưa bán hết: tới hôm nay, có dấu “+”).
      </p>
      <Table
        label="Xếp hạng chuyến"
        head={["Chuyến", "Đã bán", "Tổng giá vốn", "Doanh thu", "Lãi", "ROI", "Vốn còn đọng", "Chu kỳ vốn"]}
        rows={rows.map((b) => [
          <Link key="c" href={`/chuyen-hang/${b.id}`} className="font-medium underline">
            {b.code}
            {b.name && <span className="ml-1 font-normal text-muted">{b.name}</span>}
          </Link>,
          `${b.soldCount}/${b.itemCount}`,
          formatVnd(b.totalLandedCostVnd),
          formatVnd(b.revenueVnd),
          money(b.realizedProfitVnd),
          formatBp(b.roiBp),
          b.unsoldCostVnd > 0n ? <span className="text-[var(--warn)]">{formatVnd(b.unsoldCostVnd)}</span> : "0",
          b.cycleDays === null ? "—" : `${b.cycleDays}${b.soldOut ? "" : "+"} ngày`,
        ])}
      />
    </div>
  );
}

// ---- Kênh bán -------------------------------------------------------------------------------------------

export async function ChannelReport({ db, range }: { db: Db; range: Range }) {
  const rows = await r.byChannel(db, range.from, range.toExcl);
  if (!rows.length) return <Empty>Không có đơn bán nào trong kỳ.</Empty>;
  const max = rows[0].revenueVnd;
  return (
    <Table
      label="Theo kênh bán"
      head={["Kênh", "Đơn", "Máy", "Doanh thu", "", "Lãi", "Biên lãi", "Đơn TB"]}
      rows={rows.map((c) => [
        CHANNEL_LABEL[c.channel as keyof typeof CHANNEL_LABEL] ?? c.channel,
        c.orders,
        c.units,
        formatVnd(c.revenueVnd),
        <Bar key="b" value={c.revenueVnd} max={max} />,
        money(c.profitVnd),
        formatBp(margin(c.profitVnd, c.revenueVnd)),
        c.orders ? shortVnd(c.revenueVnd / BigInt(c.orders)) : "—",
      ])}
      foot={[
        "Cộng",
        rows.reduce((s, c) => s + c.orders, 0),
        rows.reduce((s, c) => s + c.units, 0),
        formatVnd(rows.reduce((s, c) => s + c.revenueVnd, 0n)),
        "",
        money(rows.reduce((s, c) => s + c.profitVnd, 0n)),
        formatBp(
          margin(
            rows.reduce((s, c) => s + c.profitVnd, 0n),
            rows.reduce((s, c) => s + c.revenueVnd, 0n),
          ),
        ),
        "",
      ]}
    />
  );
}

// ---- Vận chuyển -----------------------------------------------------------------------------------------

export async function TransportReport({ db, range, today }: { db: Db; range: Range; today: string }) {
  const rows = await r.transport(db, range.from, range.toExcl, today);
  if (!rows.length) return <Empty>Không có kiện nào gửi đi trong kỳ.</Empty>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">Kiện gửi đi trong kỳ. Trễ = nhận sau ngày dự kiến (ETA), hoặc chưa nhận mà đã quá ETA.</p>
      <Table
        label="Thời gian vận chuyển"
        head={["Chặng · đơn vị", "Kiện", "Máy", "Đã nhận", "Ngày đi TB", "Lâu nhất", "Trễ ETA", "Giữ HQ"]}
        rows={rows.map((t) => [
          <span key="l">
            {LEG_LABEL[t.leg as keyof typeof LEG_LABEL] ?? t.leg} · <b>{t.carrier}</b>
          </span>,
          t.shipments,
          t.items,
          t.arrived,
          dec(t.avgDays),
          dec(t.maxDays),
          t.late ? <span className="text-[var(--warn)]">{`${t.late} (${formatBp(Math.round((t.late * 10000) / t.shipments))})`}</span> : "0",
          t.hold ? <span className="text-danger">{t.hold}</span> : "0",
        ])}
      />
    </div>
  );
}

// ---- Tồn kho --------------------------------------------------------------------------------------------

export async function InventoryReport({ db, today }: { db: Db; today: string }) {
  const inv = await r.inventory(db);
  if (!inv.items.length) return <Empty>Không có máy nào tồn ở SG.</Empty>;
  const old = inv.items.filter((i) => i.days > 30);
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Tuổi tồn" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {inv.buckets.map((b) => (
          <div key={b.bucket} className="card p-4" data-testid={`aging-${b.bucket}`}>
            <p className="text-xs text-muted">{b.bucket === ">60" ? "Trên 60 ngày" : `${b.bucket} ngày`}</p>
            <p className={`mt-1 text-lg font-semibold tabular-nums ${b.bucket === ">60" && b.count ? "text-danger" : ""}`}>{b.count} máy</p>
            <p className="text-xs text-muted tabular-nums">{formatVnd(b.capitalVnd)} ₫</p>
          </div>
        ))}
      </section>
      <section aria-labelledby="can-xa">
        <h2 id="can-xa" className="font-semibold">
          {old.length ? `Cần xả: ${old.length} máy tồn trên 30 ngày` : "Danh sách tồn kho"}
        </h2>
        <p className="mt-1 text-sm text-muted">
          Tại SG ngày {dmy(today)}, cũ nhất trước. Tổng giá vốn {formatVnd(inv.totalVnd)} ₫.
        </p>
        <div className="mt-2">
          <Table
            label="Máy tồn kho"
            head={["Máy", "Ngày tồn", "Giá vốn", "Giá dự kiến", "Giá thị trường"]}
            rows={(old.length ? old : inv.items).map((i) => [
              <span key="m">
                <Link href={`/kho/${i.itemId}`} className="underline">
                  {i.label}
                </Link>
                <span className="block font-mono text-xs text-muted">
                  {i.serial ?? ""} · {ITEM_STATUS_LABEL[i.status] ?? i.status}
                </span>
              </span>,
              <span key="d" className={i.days > 60 ? "font-semibold text-danger" : i.days > 30 ? "text-[var(--warn)]" : ""}>
                {i.days}
              </span>,
              formatVnd(i.costVnd),
              i.targetPriceVnd === null ? "—" : formatVnd(i.targetPriceVnd),
              i.marketPriceVnd === null ? "—" : formatVnd(i.marketPriceVnd),
            ])}
          />
        </div>
      </section>
    </div>
  );
}

// ---- Doanh thu thuế -------------------------------------------------------------------------------------

export async function TaxReport({ db, year }: { db: Db; year: number; reportRange: Range }) {
  const t = await r.taxReport(db, year);
  const th = thresholdStatus(t.totalVnd, t.thresholdVnd, t.warnRatio);
  const sum = (a: r.TaxMonth, b: r.TaxMonth): r.TaxMonth => ({
    month: a.month,
    orders: a.orders + b.orders,
    units: a.units + b.units,
    revenueVnd: a.revenueVnd + b.revenueVnd,
    invoicedOrders: a.invoicedOrders + b.invoicedOrders,
    invoicedRevenueVnd: a.invoicedRevenueVnd + b.invoicedRevenueVnd,
  });
  const line = (label: string, m: r.TaxMonth) => [
    label,
    m.orders,
    m.units,
    formatVnd(m.revenueVnd),
    `${m.invoicedOrders}/${m.orders}`,
    formatVnd(m.invoicedRevenueVnd),
  ];
  const head = ["Kỳ", "Đơn", "Máy", "Doanh thu", "Có HĐĐT", "DT có HĐĐT"];
  const total = t.months.reduce(sum);
  const pct = Math.min(th.usedBp, 10000) / 100;
  return (
    <div className="flex flex-col gap-6">
      <section className="card p-4" aria-labelledby="nguong" data-testid="tax-threshold-report">
        <h2 id="nguong" className="font-semibold">
          Doanh thu năm {year}: {formatVnd(t.totalVnd)} ₫
        </h2>
        <div
          className="mt-2 h-2.5 overflow-hidden rounded-full bg-[var(--fill)]"
          role="meter"
          aria-valuenow={th.usedBp / 100}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Đã dùng ngưỡng"
        >
          <div
            className={`h-full rounded-full ${th.level === "OVER" ? "bg-[var(--danger)]" : th.level === "WARN" ? "bg-[var(--warn)]" : "bg-[var(--ok)]"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-sm">
          Ngưỡng doanh thu không phải nộp thuế GTGT, TNCN: <b>{formatVnd(t.thresholdVnd)} ₫</b> — đã dùng <b>{formatBp(th.usedBp)}</b>
          {th.level === "OVER" ? (
            <span className="text-danger">. Đã vượt ngưỡng: phải kê khai, nộp thuế và dùng hoá đơn điện tử có mã của cơ quan thuế.</span>
          ) : (
            <span className="text-muted"> · còn {formatVnd(th.remainingVnd)} ₫.</span>
          )}
        </p>
        <p className="mt-1 text-xs text-muted">
          Ngưỡng và tỷ lệ cảnh báo lấy từ cài đặt (pháp luật thuế thay đổi thường xuyên). Số liệu để đối chiếu, không thay thế tờ khai; kiểm tra quy định hiện
          hành trước khi kê khai.
        </p>
      </section>

      <section aria-labelledby="thang">
        <h2 id="thang" className="font-semibold">
          Theo tháng
        </h2>
        <div className="mt-2">
          <Table label="Doanh thu theo tháng" head={head} rows={t.months.map((m) => line(mLabel(m.month), m))} foot={line("Cả năm", total)} />
        </div>
      </section>

      <section aria-label="Theo quý và chi phí" className="grid items-start gap-4 lg:grid-cols-2">
        <div>
          <h2 className="font-semibold">Theo quý (kỳ khai GTGT)</h2>
          <div className="mt-2">
            <Table label="Doanh thu theo quý" head={head} rows={byQuarter(t.months, sum).map((q) => line(q.quarter, q.row))} foot={line("Cả năm", total)} />
          </div>
        </div>
        <div>
          <h2 className="font-semibold">Chi phí trong năm</h2>
          <div className="mt-2">
            <Table
              label="Chi phí trong năm"
              head={["Khoản", "Số tiền"]}
              rows={[
                ["Vận chuyển, thông quan", formatVnd(t.landedCostsVnd)],
                [
                  <span key="v" className="pl-3 text-muted">
                    trong đó có chứng từ hợp lệ
                  </span>,
                  formatVnd(t.landedCostsValidVnd),
                ],
                ["Chi phí vận hành (sổ quỹ)", formatVnd(t.opexVnd)],
              ]}
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="chua-hd">
        <h2 id="chua-hd" className="font-semibold">
          Đơn chưa ghi số hoá đơn điện tử ({t.uninvoiced.length})
        </h2>
        <div className="mt-2">
          {t.uninvoiced.length === 0 ? (
            <Empty>Mọi đơn hoàn tất trong năm đều đã ghi số hoá đơn.</Empty>
          ) : (
            <Table
              label="Đơn chưa xuất hoá đơn"
              head={["Đơn", "Ngày", "Khách", "Doanh thu"]}
              rows={t.uninvoiced.map((u) => [
                <Link key="u" href={`/ban-hang/${u.id}`} className="underline">
                  {u.code}
                </Link>,
                dmy(u.date),
                u.customer ?? "—",
                formatVnd(u.revenueVnd),
              ])}
              foot={["Cộng", "", "", formatVnd(t.uninvoiced.reduce((s, u) => s + u.revenueVnd, 0n))]}
            />
          )}
        </div>
      </section>
    </div>
  );
}
