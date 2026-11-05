/**
 * Báo cáo → các trang tính Excel. Mỗi báo cáo xuất cùng số liệu với màn hình (cùng hàm truy vấn).
 */
import type { Sql, TransactionSql } from "postgres";
import { CATEGORY_LABEL, LEG_LABEL } from "@/domain/catalog";
import { percentBp } from "@/domain/costing/money";
import { formatBp } from "@/domain/overview";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing-core";
import { byQuarter, median, pnlStatement, quadrant, QUADRANT_LABEL, REPORTS, thresholdStatus, type Range, type ReportKey } from "@/domain/reports";
import { CHANNEL_LABEL } from "@/domain/sales-core";
import * as r from "./service";
import type { Sheet } from "./xlsx";

type Db = Sql | TransactionSql;

const mLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const dmy = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");
const margin = (profit: bigint, revenue: bigint) => (revenue > 0n ? percentBp(profit, revenue) : null);

export async function exportReport(db: Db, key: ReportKey, range: Range, today: string): Promise<{ filename: string; sheets: Sheet[] }> {
  const title = REPORTS.find((x) => x.key === key)!.label;
  const head = (extra?: string) => [`iPre — Báo cáo ${title.toLowerCase()}`, extra ?? `Kỳ: ${range.label}`, `Xuất ngày ${dmy(today)}`];
  const slug = range.key === "tuy-chon" ? `${range.from}_${range.toExcl}` : range.from.slice(0, 7);
  const file = (s: string) => `ipre-${key}-${s}.xlsx`;

  switch (key) {
    case "lai-lo": {
      const [cur, prev, months, opex] = await Promise.all([
        r.pnlTotals(db, range.from, range.toExcl),
        r.pnlTotals(db, range.prevFrom, range.prevToExcl),
        r.monthlyPnl(db, range.from, range.toExcl),
        r.opexByCategory(db, range.from, range.toExcl),
      ]);
      const lines = pnlStatement(cur, prev);
      return {
        filename: file(slug),
        sheets: [
          {
            name: "Kết quả kinh doanh",
            title: [...head(), `So với: ${range.prevLabel}`, `${cur.units} máy bán; ${cur.provisional} máy lãi còn "Tạm tính" (chuyến chưa chốt chi phí)`],
            columns: [
              { header: "Chỉ tiêu", type: "text" },
              { header: range.label, type: "money" },
              { header: "% doanh thu", type: "pct" },
              { header: range.prevLabel, type: "money" },
              { header: "Thay đổi", type: "pct" },
            ],
            rows: lines.map((l) => [l.label, l.minus ? -l.current : l.current, l.ofRevenueBp, l.minus ? -l.previous : l.previous, l.changeBp]),
          },
          {
            name: "Theo tháng",
            title: head(),
            columns: [
              { header: "Tháng", type: "text" },
              { header: "Số máy", type: "int" },
              { header: "Doanh thu", type: "money" },
              { header: "Giá vốn", type: "money" },
              { header: "Lãi gộp", type: "money" },
              { header: "Chi phí bán", type: "money" },
              { header: "Chi phí vận hành", type: "money" },
              { header: "Lãi ròng trước thuế", type: "money" },
            ],
            rows: months.map((m) => [mLabel(m.month), m.units, m.revenueVnd, m.cogsVnd, m.grossVnd, m.sellingVnd, m.opexVnd, m.netVnd]),
            total: [
              "Cộng",
              months.reduce((s, m) => s + m.units, 0),
              ...(["revenueVnd", "cogsVnd", "grossVnd", "sellingVnd", "opexVnd", "netVnd"] as const).map((k) => months.reduce((s, m) => s + m[k], 0n)),
            ],
          },
          {
            name: "Chi phí vận hành",
            title: head(),
            columns: [
              { header: "Danh mục", type: "text" },
              { header: "Số tiền", type: "money" },
            ],
            rows: opex.map((o) => [o.name, o.amountVnd]),
            total: ["Cộng", opex.reduce((s, o) => s + o.amountVnd, 0n)],
          },
        ],
      };
    }
    case "dong-may": {
      const { rows, medianDays } = await r.byModel(db, range.from, range.toExcl);
      const medMargin = median(rows.flatMap((x) => margin(x.profitVnd, x.revenueVnd) ?? []));
      return {
        filename: file(slug),
        sheets: [
          {
            name: "Theo dòng máy",
            title: head(),
            columns: [
              { header: "Dòng máy", type: "text" },
              { header: "Nhóm", type: "text" },
              { header: "Số máy bán", type: "int" },
              { header: "Doanh thu", type: "money" },
              { header: "Giá vốn", type: "money" },
              { header: "Lãi", type: "money" },
              { header: "Biên lãi", type: "pct" },
              { header: "Ngày bán TB (từ khi về SG)", type: "dec" },
              { header: "Đang tồn", type: "int" },
              { header: "Xếp loại", type: "text" },
            ],
            rows: rows.map((x) => {
              const mg = margin(x.profitVnd, x.revenueVnd);
              const q = medMargin === null || medianDays === null ? null : quadrant(mg, x.avgDaysToSell, medMargin, medianDays);
              return [
                x.model,
                CATEGORY_LABEL[x.category as keyof typeof CATEGORY_LABEL] ?? x.category,
                x.units,
                x.revenueVnd,
                x.cogsVnd,
                x.profitVnd,
                mg,
                x.avgDaysToSell,
                x.inStock,
                q ? QUADRANT_LABEL[q] : "",
              ];
            }),
            total: totalsRow(rows),
          },
        ],
      };
    }
    case "chuyen": {
      const rows = await r.byBatch(db, today);
      return {
        filename: file(today),
        sheets: [
          {
            name: "Theo chuyến",
            title: head("Toàn bộ chuyến (không lọc theo kỳ), xếp theo ROI trên máy đã bán"),
            columns: [
              { header: "Mã chuyến", type: "text" },
              { header: "Tên", type: "text" },
              { header: "Số máy", type: "int" },
              { header: "Đã bán", type: "int" },
              { header: "Tổng giá vốn", type: "money" },
              { header: "Doanh thu", type: "money" },
              { header: "Lãi đã thực hiện", type: "money" },
              { header: "ROI (máy đã bán)", type: "pct" },
              { header: "Vốn còn đọng", type: "money" },
              { header: "Đặt đơn đầu", type: "text" },
              { header: "Bán máy cuối", type: "text" },
              { header: "Chu kỳ vốn (ngày)", type: "int" },
            ],
            rows: rows.map((b) => [
              b.code,
              b.name ?? "",
              b.itemCount,
              b.soldCount,
              b.totalLandedCostVnd,
              b.revenueVnd,
              b.realizedProfitVnd,
              b.roiBp,
              b.unsoldCostVnd,
              dmy(b.firstOrder),
              dmy(b.lastSale),
              b.cycleDays === null ? null : `${b.cycleDays}${b.soldOut ? "" : "+"}`,
            ]),
          },
        ],
      };
    }
    case "kenh": {
      const rows = await r.byChannel(db, range.from, range.toExcl);
      return {
        filename: file(slug),
        sheets: [
          {
            name: "Theo kênh bán",
            title: head(),
            columns: [
              { header: "Kênh", type: "text" },
              { header: "Số đơn", type: "int" },
              { header: "Số máy", type: "int" },
              { header: "Doanh thu", type: "money" },
              { header: "Lãi", type: "money" },
              { header: "Biên lãi", type: "pct" },
              { header: "Giá trị đơn TB", type: "money" },
            ],
            rows: rows.map((c) => [
              CHANNEL_LABEL[c.channel as keyof typeof CHANNEL_LABEL] ?? c.channel,
              c.orders,
              c.units,
              c.revenueVnd,
              c.profitVnd,
              margin(c.profitVnd, c.revenueVnd),
              c.orders ? c.revenueVnd / BigInt(c.orders) : null,
            ]),
          },
        ],
      };
    }
    case "van-chuyen": {
      const rows = await r.transport(db, range.from, range.toExcl, today);
      return {
        filename: file(slug),
        sheets: [
          {
            name: "Vận chuyển",
            title: head(`Kiện gửi đi trong kỳ ${range.label}`),
            columns: [
              { header: "Chặng", type: "text" },
              { header: "Đơn vị vận chuyển", type: "text" },
              { header: "Số kiện", type: "int" },
              { header: "Số máy", type: "int" },
              { header: "Đã nhận", type: "int" },
              { header: "Ngày đi TB", type: "dec" },
              { header: "Lâu nhất", type: "dec" },
              { header: "Trễ ETA", type: "int" },
              { header: "Tỉ lệ trễ", type: "pct" },
              { header: "Đang giữ HQ", type: "int" },
            ],
            rows: rows.map((t) => [
              LEG_LABEL[t.leg as keyof typeof LEG_LABEL] ?? t.leg,
              t.carrier,
              t.shipments,
              t.items,
              t.arrived,
              t.avgDays,
              t.maxDays,
              t.late,
              t.shipments ? Math.round((t.late * 10000) / t.shipments) : null,
              t.hold,
            ]),
          },
        ],
      };
    }
    case "ton-kho": {
      const inv = await r.inventory(db);
      return {
        filename: file(today),
        sheets: [
          {
            name: "Tuổi tồn",
            title: head(`Tồn kho tại SG ngày ${dmy(today)}`),
            columns: [
              { header: "Tuổi tồn (ngày)", type: "text" },
              { header: "Số máy", type: "int" },
              { header: "Giá vốn", type: "money" },
            ],
            rows: inv.buckets.map((b) => [b.bucket, b.count, b.capitalVnd]),
            total: ["Cộng", inv.items.length, inv.totalVnd],
          },
          {
            name: "Danh sách máy",
            title: head(`Tồn kho tại SG ngày ${dmy(today)} — cũ nhất trước`),
            columns: [
              { header: "Máy", type: "text" },
              { header: "Serial", type: "text" },
              { header: "Trạng thái", type: "text" },
              { header: "Số ngày tồn", type: "int" },
              { header: "Giá vốn", type: "money" },
              { header: "Giá bán dự kiến", type: "money" },
              { header: "Giá thị trường", type: "money" },
            ],
            rows: inv.items.map((i) => [
              i.label,
              i.serial ?? "",
              ITEM_STATUS_LABEL[i.status as keyof typeof ITEM_STATUS_LABEL] ?? i.status,
              i.days,
              i.costVnd,
              i.targetPriceVnd,
              i.marketPriceVnd,
            ]),
          },
        ],
      };
    }
    case "thue": {
      const year = +range.from.slice(0, 4);
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
      const cols = [
        { header: "Kỳ", type: "text" as const },
        { header: "Số đơn", type: "int" as const },
        { header: "Số máy", type: "int" as const },
        { header: "Doanh thu", type: "money" as const },
        { header: "Đơn đã xuất HĐĐT", type: "int" as const },
        { header: "Doanh thu đã xuất HĐĐT", type: "money" as const },
      ];
      const line = (label: string, m: r.TaxMonth) => [label, m.orders, m.units, m.revenueVnd, m.invoicedOrders, m.invoicedRevenueVnd];
      const tot = t.months.reduce(sum);
      return {
        filename: file(String(year)),
        sheets: [
          {
            name: `Doanh thu ${year}`,
            title: [
              `iPre — Sổ doanh thu năm ${year} (phục vụ kê khai thuế hộ kinh doanh)`,
              `Ngưỡng doanh thu không chịu thuế: ${t.thresholdVnd.toLocaleString("vi-VN")} đ — đã dùng ${formatBp(th.usedBp)}`,
              "Số liệu để đối chiếu, không thay thế tờ khai; đối chiếu quy định hiện hành trước khi kê khai.",
              `Xuất ngày ${dmy(today)}`,
            ],
            columns: cols,
            rows: t.months.map((m) => line(mLabel(m.month), m)),
            total: line("Cả năm", tot),
          },
          {
            name: "Theo quý",
            title: [`Doanh thu theo quý năm ${year}`],
            columns: cols,
            rows: byQuarter(t.months, sum).map((q) => line(q.quarter, q.row)),
            total: line("Cả năm", tot),
          },
          {
            name: "Chưa xuất hoá đơn",
            title: [`Đơn bán hoàn tất năm ${year} chưa ghi số hoá đơn điện tử`],
            columns: [
              { header: "Mã đơn", type: "text" },
              { header: "Ngày bán", type: "text" },
              { header: "Khách", type: "text" },
              { header: "Doanh thu", type: "money" },
            ],
            rows: t.uninvoiced.map((u) => [u.code, dmy(u.date), u.customer ?? "", u.revenueVnd]),
            total: ["Cộng", "", "", t.uninvoiced.reduce((s, u) => s + u.revenueVnd, 0n)],
          },
          {
            name: "Chi phí",
            title: [`Chi phí năm ${year}`],
            columns: [
              { header: "Khoản", type: "text" },
              { header: "Số tiền", type: "money" },
            ],
            rows: [
              ["Chi phí vận chuyển / thông quan (phát sinh trong năm)", t.landedCostsVnd],
              ["  trong đó có chứng từ hợp lệ", t.landedCostsValidVnd],
              ["Chi phí vận hành (sổ quỹ)", t.opexVnd],
            ],
          },
        ],
      };
    }
  }
}

function totalsRow(rows: r.ModelRow[]) {
  const rev = rows.reduce((s, x) => s + x.revenueVnd, 0n);
  const profit = rows.reduce((s, x) => s + x.profitVnd, 0n);
  return [
    "Cộng",
    "",
    rows.reduce((s, x) => s + x.units, 0),
    rev,
    rows.reduce((s, x) => s + x.cogsVnd, 0n),
    profit,
    margin(profit, rev),
    null,
    rows.reduce((s, x) => s + x.inStock, 0),
    "",
  ];
}
