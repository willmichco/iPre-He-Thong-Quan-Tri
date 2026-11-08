/**
 * Trợ lý — trả lời câu hỏi. Mỗi loại câu hỏi gọi đúng dịch vụ của trang tương ứng (Báo cáo, Kho, Thu chi, Vận chuyển,
 * Tổng quan) nên số liệu khớp từng đồng với giao diện; câu trả lời kèm link mở trang chi tiết.
 */
import type { Sql, TransactionSql } from "postgres";
import { dmy } from "@/domain/assistant/dates";
import type { Slots } from "@/domain/assistant/extract";
import { fallbackReply, helpReply } from "@/domain/assistant/examples";
import type { Intent } from "@/domain/assistant/intents";
import { formatVnd, shortVnd } from "@/domain/assistant/money";
import { fold } from "@/domain/assistant/normalize";
import type { Chip, Reply, TableCard } from "@/domain/assistant/reply";
import { warrantyState } from "@/domain/customers";
import { alertSettingsFrom, formatBp, periodRange, STAGES } from "@/domain/overview";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing-core";
import { parseRange, pnlStatement, rangeQuery, thresholdStatus, type Range } from "@/domain/reports";
import { CHANNEL_LABEL, SALE_STATUS_LABEL, type Channel } from "@/domain/sales-core";
import { daysLate, SHIPMENT_STATUS_LABEL } from "@/domain/shipping";
import { missingDossiers } from "@/server/attachments/service";
import { getCustomer, listCustomers } from "@/server/customers/service";
import { getDebts, listAccountBalances, listTransactions, weeklyCashflow } from "@/server/ledger/service";
import { getOverview, listItemsAtStatuses } from "@/server/overview/service";
import { byBatch, byChannel, byModel, inventory, monthlyPnl, opexByCategory, pnlTotals, taxReport } from "@/server/reports/service";
import { findItemForSale, getItemProfile } from "@/server/sales/service";
import { inboxCount } from "@/server/scans/service";
import { listShipments, listShortages } from "@/server/shipping/service";
import { findSaleByCode, findShipmentByCode, itemsByPartialCode, listSalesBetween, stockByVariant } from "./lookups";

type Db = Sql | TransactionSql;

export interface QueryCtx {
  db: Db;
  today: string;
}

const MAX_ROWS = 10;
const pct = (bp: number | null) => (bp === null ? "—" : formatBp(bp));
const signed = (v: bigint) => (v < 0n ? `−${shortVnd(-v)}` : shortVnd(v));
const toneOf = (v: bigint) => (v < 0n ? ("bad" as const) : ("good" as const));
const rangeOf = (s: Slots, today: string, fallback = "thang"): Range => parseRange(s.period ?? { ky: fallback }, today);
const reportHref = (bc: string, r: Range) => `/bao-cao?${new URLSearchParams({ bc, ...rangeQuery(r) })}`;
const table = (t: Omit<TableCard, "kind">, all: number): TableCard => ({ kind: "table", ...t, ...(all > t.rows.length ? { more: all - t.rows.length } : {}) });

/** Khách theo tên (không dấu, không phân biệt hoa thường) hoặc SĐT. */
export async function findCustomers(db: Db, s: { phone?: string; customerName?: string }) {
  if (s.phone) return (await listCustomers(db, s.phone, 5)).filter((c) => c.phone === s.phone);
  if (!s.customerName) return [];
  const want = fold(s.customerName).replace(/^(anh|chi|em|co|chu|ban|bac|ong|ba|cau|di|thim) /, "");
  const all = await listCustomers(db, "", 1000);
  const words = want.split(" ").filter(Boolean);
  const exact = all.filter((c) => fold(c.fullName) === fold(s.customerName!) || fold(c.fullName) === want);
  if (exact.length) return exact;
  // mọi từ của tên gõ đều là một từ trong tên khách ("Lan" khớp "Chị Lan", "Nguyễn Thị Lan")
  return all.filter((c) => {
    const have = fold(c.fullName).split(/\s+/);
    return words.every((w) => have.includes(w));
  });
}

export async function answerQuery(q: QueryCtx, intent: Intent, s: Slots): Promise<Reply> {
  const { db, today } = q;
  switch (intent) {
    case "HELP":
      return helpReply();

    case "STOCK": {
      if (s.variantIds.length) {
        const rows = await stockByVariant(db, s.variantIds);
        if (!rows.length) return { text: `Không còn máy ${s.productText ?? "dòng này"} — kể cả máy đang về.`, chips: [{ label: "Tồn kho", text: "tồn kho" }] };
        const t = rows.reduce((a, r) => a + r.inStock, 0);
        return {
          text: `${s.productText ? `"${s.productText}"` : "Dòng này"}: còn ${t} máy sẵn bán tại SG.`,
          cards: [
            table(
              {
                columns: ["Cấu hình", "Sẵn bán", "Khách cọc", "Đang về", "Vốn tồn", "Tồn lâu nhất"],
                numeric: [1, 2, 3, 4, 5],
                rows: rows.slice(0, MAX_ROWS).map((r) => [r.label, String(r.inStock), String(r.reserved), String(r.incoming), shortVnd(r.costVnd), r.oldestDays === null ? "—" : `${r.oldestDays} ngày`]),
              },
              rows.length,
            ),
          ],
          link: { href: "/kho", label: "Mở Kho máy" },
        };
      }
      const [inv, byVar] = await Promise.all([inventory(db), stockByVariant(db)]);
      const ready = inv.items.filter((i) => i.status === "IN_STOCK").length;
      const reserved = inv.items.length - ready;
      const incoming = byVar.reduce((a, r) => a + r.incoming, 0);
      return {
        text: `Tồn kho SG: ${ready} máy sẵn bán, ${reserved} máy khách cọc, ${incoming} máy đang về. Vốn nằm ở tồn SG: ${shortVnd(inv.totalVnd)}.`,
        cards: [
          {
            kind: "stat",
            items: inv.buckets.map((b) => ({ label: `Tồn ${b.bucket} ngày`, value: `${b.count} máy`, hint: shortVnd(b.capitalVnd), tone: b.bucket === ">60" && b.count ? "warn" : undefined })),
          },
          table(
            {
              title: "Theo cấu hình",
              columns: ["Cấu hình", "Sẵn bán", "Cọc", "Đang về"],
              numeric: [1, 2, 3],
              rows: byVar.slice(0, MAX_ROWS).map((r) => [r.label, String(r.inStock), String(r.reserved), String(r.incoming)]),
            },
            byVar.length,
          ),
        ],
        chips: [
          { label: "Máy tồn lâu", text: "máy tồn lâu" },
          { label: "Máy đang về", text: "máy nào đang về" },
          { label: "Xuất Excel tồn kho", text: "xuất excel tháng này" },
        ],
        link: { href: "/kho", label: "Mở Kho máy" },
      };
    }

    case "AGED_STOCK": {
      const [inv, settings] = await Promise.all([inventory(db), db<{ key: string; value: string }[]>`SELECT key, value::text FROM app_settings WHERE key LIKE 'alert.%'`]);
      const min = s.days ?? alertSettingsFrom(settings).agingDays;
      const items = inv.items.filter((i) => i.days >= min);
      if (!items.length) return { text: `Không có máy nào tồn từ ${min} ngày trở lên. 👍` };
      const capital = items.reduce((a, i) => a + i.costVnd, 0n);
      return {
        text: `${items.length} máy tồn từ ${min} ngày trở lên, vốn đọng ${shortVnd(capital)}. Cũ nhất trước:`,
        cards: [
          table(
            {
              columns: ["Máy", "Serial", "Ngày tồn", "Giá vốn", "Giá mục tiêu"],
              numeric: [2, 3, 4],
              rows: items.slice(0, MAX_ROWS).map((i) => [i.label, i.serial ?? "—", String(i.days), shortVnd(i.costVnd), i.targetPriceVnd === null ? "—" : shortVnd(i.targetPriceVnd)]),
              hrefs: items.slice(0, MAX_ROWS).map((i) => `/kho/${i.itemId}`),
            },
            items.length,
          ),
        ],
        link: { href: "/bao-cao?bc=ton-kho", label: "Báo cáo tồn kho" },
      };
    }

    case "STAGE": {
      const f = fold(s.rest);
      const stage =
        /\b(hn|ha noi)\b/.test(f) && !/sg|sai gon/.test(f)
          ? STAGES.filter((x) => x.key === "hn" || x.key === "hn-sg")
          : /\bkho my\b/.test(f)
            ? STAGES.filter((x) => x.key === "us-wh")
            : STAGES.filter((x) => x.key !== "sg" && x.key !== "warranty");
      const statuses = stage.flatMap((x) => [...x.statuses]);
      const rows = await listItemsAtStatuses(db, statuses, 200);
      if (!rows.length) return { text: `Không có máy nào ở chặng ${stage.map((x) => x.label).join(", ")}.` };
      const capital = rows.reduce((a, r) => a + BigInt(r.cost), 0n);
      return {
        text: `${rows.length} máy đang ở ${stage.map((x) => x.label).join(" / ")}, vốn ${shortVnd(capital)}.`,
        cards: [
          table(
            {
              columns: ["Máy", "Serial / IMEI", "Chặng", "Chuyến", "Giá vốn"],
              numeric: [4],
              rows: rows.slice(0, MAX_ROWS).map((r) => [r.label, r.serial_number ?? r.imei1 ?? "—", ITEM_STATUS_LABEL[r.status] ?? r.status, r.batch_code, shortVnd(BigInt(r.cost))]),
              hrefs: rows.slice(0, MAX_ROWS).map((r) => `/kho/${r.id}`),
            },
            rows.length,
          ),
        ],
        link: { href: "/van-chuyen", label: "Mở Vận chuyển" },
      };
    }

    case "CAPITAL": {
      const ov = await getOverview(db, periodRange("thang-nay", today), today);
      return {
        text: `Tổng vốn đang nằm trong hàng: ${shortVnd(ov.capital.totalVnd)} (${ov.capital.stages.reduce((a, x) => a + x.itemCount, 0)} máy).`,
        cards: [
          table(
            {
              columns: ["Chặng", "Số máy", "Vốn", "Tỷ trọng"],
              numeric: [1, 2, 3],
              rows: ov.capital.stages.filter((x) => x.itemCount).map((x) => [x.label, String(x.itemCount), shortVnd(x.capitalVnd), pct(x.shareBp)]),
            },
            0,
          ),
        ],
        link: { href: "/", label: "Mở Tổng quan" },
      };
    }

    case "ITEM_LOOKUP":
    case "PRICE_SUGGEST":
      return itemAnswer(q, intent, s);

    case "REVENUE": {
      const r = rangeOf(s, today);
      const [cur, prev] = await Promise.all([pnlTotals(db, r.from, r.toExcl), pnlTotals(db, r.prevFrom, r.prevToExcl)]);
      const st = pnlStatement(cur, prev);
      const line = (k: string) => st.find((x) => x.key === k);
      const gross = line("gross")?.current ?? cur.revenueVnd - cur.cogsVnd;
      const net = line("net")?.current ?? gross - cur.sellingExpenseVnd - cur.opexVnd;
      const prevNet = line("net")?.previous ?? 0n;
      return {
        text:
          `${r.label}: bán ${cur.units} máy, doanh thu ${shortVnd(cur.revenueVnd)}, lãi gộp ${signed(gross)}, lãi ròng (sau chi phí vận hành) ${signed(net)}` +
          `${cur.provisional ? ` — ${cur.provisional} máy lãi còn tạm tính (chuyến chưa chốt chi phí)` : ""}.`,
        cards: [
          {
            kind: "stat",
            items: [
              { label: "Doanh thu", value: shortVnd(cur.revenueVnd), hint: `${r.prevLabel}: ${shortVnd(prev.revenueVnd)}` },
              { label: "Giá vốn", value: shortVnd(cur.cogsVnd) },
              { label: "Lãi gộp", value: signed(gross), tone: toneOf(gross) },
              { label: "Chi phí bán + vận hành", value: shortVnd(cur.sellingExpenseVnd + cur.opexVnd) },
              { label: "Lãi ròng", value: signed(net), tone: toneOf(net), hint: `${r.prevLabel}: ${signed(prevNet)}` },
            ],
          },
        ],
        chips: [
          { label: "Từng tháng năm nay", text: "doanh thu từng tháng năm nay" },
          { label: "Dòng nào lãi nhất", text: `dòng nào lãi nhất ${r.key === "tuy-chon" ? "" : "tháng này"}`.trim() },
          { label: "Chi phí vận hành", text: "chi phí vận hành tháng này" },
        ],
        link: { href: reportHref("lai-lo", r), label: "Mở báo cáo Lãi lỗ" },
      };
    }

    case "MONTHLY": {
      const r = rangeOf(s, today, "nam");
      const rows = await monthlyPnl(db, r.from, r.toExcl);
      const tot = rows.reduce((a, m) => ({ rev: a.rev + m.revenueVnd, net: a.net + m.netVnd, u: a.u + m.units }), { rev: 0n, net: 0n, u: 0 });
      return {
        text: `${r.label}: ${tot.u} máy, doanh thu ${shortVnd(tot.rev)}, lãi ròng ${signed(tot.net)}.`,
        cards: [
          table(
            {
              columns: ["Tháng", "Số máy", "Doanh thu", "Lãi gộp", "Chi phí VH", "Lãi ròng"],
              numeric: [1, 2, 3, 4, 5],
              rows: rows.map((m) => [`${m.month.slice(5, 7)}/${m.month.slice(0, 4)}`, String(m.units), shortVnd(m.revenueVnd), signed(m.grossVnd), shortVnd(m.opexVnd), signed(m.netVnd)]),
            },
            0,
          ),
        ],
        link: { href: reportHref("lai-lo", r), label: "Mở báo cáo Lãi lỗ" },
      };
    }

    case "OPEX": {
      const r = rangeOf(s, today);
      let rows = await opexByCategory(db, r.from, r.toExcl);
      const f = fold(s.rest);
      const only = /quang cao|ads/.test(f) ? "OPEX_ADS" : /mat bang|nha|kho/.test(f) ? "OPEX_RENT" : /internet|dien thoai|phan mem/.test(f) ? "OPEX_TELECOM" : null;
      if (only) rows = rows.filter((x) => x.code === only);
      const total = rows.reduce((a, x) => a + x.amountVnd, 0n);
      return {
        text: `${r.label}: chi phí vận hành${only ? ` (${rows[0]?.name ?? "danh mục này"})` : ""} ${shortVnd(total)}.`,
        cards: rows.length ? [table({ columns: ["Danh mục", "Số tiền"], numeric: [1], rows: rows.map((x) => [x.name, shortVnd(x.amountVnd)]) }, 0)] : [],
        link: { href: `/thu-chi?${new URLSearchParams({ tu: r.from, den: addDaysIso(r.toExcl, -1) })}`, label: "Mở Sổ thu chi" },
      };
    }

    case "TOP_MODELS": {
      const r = rangeOf(s, today, s.period ? "thang" : "nam");
      const { rows } = await byModel(db, r.from, r.toExcl);
      if (!rows.length) return { text: `${r.label}: chưa bán máy nào.` };
      const byUnits = /ban chay|nhieu nhat/.test(fold(s.rest));
      const sorted = [...rows].sort((a, b) => (byUnits ? b.units - a.units : Number(b.profitVnd - a.profitVnd)));
      const top = sorted[0];
      return {
        text: `${r.label}: ${byUnits ? "bán chạy nhất" : "lãi nhất"} là ${top.model} — ${top.units} máy, lãi ${signed(top.profitVnd)}.`,
        cards: [
          table(
            {
              columns: ["Dòng máy", "Đã bán", "Doanh thu", "Lãi", "Ngày bán TB", "Còn tồn"],
              numeric: [1, 2, 3, 4, 5],
              rows: sorted.slice(0, MAX_ROWS).map((m) => [m.model, String(m.units), shortVnd(m.revenueVnd), signed(m.profitVnd), m.avgDaysToSell === null ? "—" : String(m.avgDaysToSell), String(m.inStock)]),
            },
            sorted.length,
          ),
        ],
        link: { href: reportHref("dong-may", r), label: "Mở báo cáo Dòng máy" },
      };
    }

    case "BY_CHANNEL": {
      const r = rangeOf(s, today, s.period ? "thang" : "nam");
      const rows = await byChannel(db, r.from, r.toExcl);
      if (!rows.length) return { text: `${r.label}: chưa có đơn bán.` };
      const top = rows[0];
      return {
        text: `${r.label}: kênh mang về nhiều nhất là ${CHANNEL_LABEL[top.channel as Channel] ?? top.channel} (${top.orders} đơn, ${shortVnd(top.revenueVnd)}).`,
        cards: [
          table(
            {
              columns: ["Kênh", "Đơn", "Máy", "Doanh thu", "Lãi"],
              numeric: [1, 2, 3, 4],
              rows: rows.map((c) => [CHANNEL_LABEL[c.channel as Channel] ?? c.channel, String(c.orders), String(c.units), shortVnd(c.revenueVnd), signed(c.profitVnd)]),
            },
            0,
          ),
        ],
        link: { href: reportHref("kenh", r), label: "Mở báo cáo Kênh bán" },
      };
    }

    case "BATCH": {
      const all = await byBatch(db, today);
      const only = s.batchCode ? all.filter((b) => b.code === s.batchCode) : all;
      if (s.batchCode && !only.length) return { text: `Không thấy chuyến ${s.batchCode}.` };
      if (only.length === 1) {
        const b = only[0];
        return {
          text: `Chuyến ${b.code}${b.name ? ` (${b.name})` : ""}: ${b.itemCount} máy, đã bán ${b.soldCount}, giá vốn ${shortVnd(b.totalLandedCostVnd)}, lãi đã thực hiện ${signed(b.realizedProfitVnd)}, ROI ${pct(b.roiBp)}.`,
          cards: [
            {
              kind: "stat",
              items: [
                { label: "Tổng giá vốn", value: shortVnd(b.totalLandedCostVnd) },
                { label: "Doanh thu", value: shortVnd(b.revenueVnd) },
                { label: "Lãi đã bán", value: signed(b.realizedProfitVnd), tone: toneOf(b.realizedProfitVnd) },
                { label: "Vốn còn tồn", value: shortVnd(b.unsoldCostVnd) },
                { label: "ROI", value: pct(b.roiBp) },
              ],
            },
          ],
          link: { href: `/chuyen-hang/${b.id}`, label: `Mở chuyến ${b.code}` },
        };
      }
      return {
        text: `${only.length} chuyến hàng. Mới nhất trước:`,
        cards: [
          table(
            {
              columns: ["Chuyến", "Máy", "Đã bán", "Giá vốn", "Lãi", "ROI"],
              numeric: [1, 2, 3, 4, 5],
              rows: only.slice(0, MAX_ROWS).map((b) => [b.code, String(b.itemCount), String(b.soldCount), shortVnd(b.totalLandedCostVnd), signed(b.realizedProfitVnd), pct(b.roiBp)]),
              hrefs: only.slice(0, MAX_ROWS).map((b) => `/chuyen-hang/${b.id}`),
            },
            only.length,
          ),
        ],
        link: { href: "/chuyen-hang", label: "Mở Chuyến hàng" },
      };
    }

    case "RECENT_SALES": {
      const r = s.period ? rangeOf(s, today) : parseRange({ tu: addDaysIso(today, -6), den: today }, today);
      const rows = await listSalesBetween(db, r.from, r.toExcl);
      if (!rows.length) return { text: `${r.label}: chưa có đơn bán nào.` };
      const rev = rows.reduce((a, x) => a + x.revenueVnd, 0n);
      return {
        text: `${r.label}: ${rows.length} đơn, doanh thu ${shortVnd(rev)}.`,
        cards: [
          table(
            {
              columns: ["Ngày", "Mã đơn", "Khách", "Máy", "Doanh thu", "Lãi", "Còn nợ"],
              numeric: [4, 5, 6],
              rows: rows.slice(0, MAX_ROWS).map((x) => [
                dmy(x.soldAt).slice(0, 5),
                `${x.code}${x.status === "DEPOSITED" ? " (cọc)" : ""}`,
                x.customer ?? "—",
                x.items,
                shortVnd(x.revenueVnd),
                x.profitVnd === null ? "—" : signed(x.profitVnd),
                x.balanceVnd > 0n ? shortVnd(x.balanceVnd) : "—",
              ]),
              hrefs: rows.slice(0, MAX_ROWS).map((x) => `/ban-hang/${x.id}`),
            },
            rows.length,
          ),
        ],
        link: { href: "/ban-hang", label: "Mở Bán hàng" },
      };
    }

    case "SALE_LOOKUP": {
      if (!s.saleCode) return { text: 'Gõ mã đơn, ví dụ "BH-2026-0012".' };
      const x = await findSaleByCode(db, s.saleCode);
      if (!x) return { text: `Không thấy đơn ${s.saleCode}.` };
      const chips: Chip[] = [];
      if (x.balanceVnd > 0n) chips.push({ label: "Thu thêm tiền", text: `thu nợ ${x.code} ${x.balanceVnd}` });
      if (x.status === "DEPOSITED") chips.push({ label: "Hoàn tất đơn", text: `hoàn tất đơn ${x.code}` });
      return {
        text: `${x.code} · ${SALE_STATUS_LABEL[x.status] ?? x.status} · ${dmy(x.soldAt)} · ${x.customer ?? "khách lẻ"}: ${x.items}.`,
        cards: [
          {
            kind: "stat",
            items: [
              { label: "Doanh thu", value: formatVnd(x.revenueVnd) },
              { label: "Lãi", value: x.profitVnd === null ? "—" : signed(x.profitVnd), tone: x.profitVnd === null ? undefined : toneOf(x.profitVnd) },
              { label: "Còn nợ", value: x.balanceVnd > 0n ? formatVnd(x.balanceVnd) : "Đã thu đủ", tone: x.balanceVnd > 0n ? "warn" : "good" },
            ],
          },
        ],
        chips,
        link: { href: `/ban-hang/${x.id}`, label: `Mở đơn ${x.code}` },
      };
    }

    case "DEBT": {
      const debts = await getDebts(db);
      let rec = debts.receivables.filter((r) => r.balanceVnd > 0n);
      if (s.customerName || s.phone) {
        const cs = await findCustomers(db, s);
        const names = new Set(cs.map((c) => fold(c.fullName)));
        rec = rec.filter((r) => (s.phone && r.phone === s.phone) || (r.party && names.has(fold(r.party))));
        if (!rec.length) return { text: `${s.customerName ?? s.phone} không còn nợ đơn nào.` };
      }
      if (!rec.length) return { text: "Không ai còn nợ. 👍" };
      const total = rec.reduce((a, r) => a + r.balanceVnd, 0n);
      return {
        text: `${s.customerName ?? "Khách"} còn nợ ${shortVnd(total)} (${rec.length} khoản).`,
        cards: [
          table(
            {
              columns: ["Đơn", "Khách", "Ngày", "Tổng", "Đã thu", "Còn nợ"],
              numeric: [3, 4, 5],
              rows: rec.slice(0, MAX_ROWS).map((r) => [r.label, r.party ?? "—", dmy(r.date).slice(0, 5), shortVnd(r.totalVnd), shortVnd(r.paidVnd), shortVnd(r.balanceVnd)]),
              hrefs: rec.slice(0, MAX_ROWS).map((r) => r.href),
            },
            rec.length,
          ),
        ],
        link: { href: "/thu-chi/cong-no", label: "Mở Công nợ" },
      };
    }

    case "PAYABLES": {
      const { payables, payableVnd } = await getDebts(db);
      if (!payables.length) return { text: "Không còn khoản nào phải trả. 👍" };
      return {
        text: `Còn phải trả ${shortVnd(payableVnd)} (${payables.length} khoản).`,
        cards: [
          table(
            {
              columns: ["Khoản", "Bên nhận", "Ngày", "Số tiền"],
              numeric: [3],
              rows: payables.slice(0, MAX_ROWS).map((p) => [p.label, p.party ?? "—", dmy(p.date).slice(0, 5), `${shortVnd(p.amountVnd)}${p.isEstimate ? " (dự toán)" : ""}`]),
              hrefs: payables.slice(0, MAX_ROWS).map((p) => p.href),
            },
            payables.length,
          ),
        ],
        link: { href: "/thu-chi/cong-no", label: "Mở Công nợ" },
      };
    }

    case "BALANCE": {
      const acc = (await listAccountBalances(db)).filter((a) => a.isActive);
      const hint = fold(s.rest + " " + s.accountHints.join(" "));
      const only = acc.filter((a) => {
        const n = fold(a.name);
        return (/tien mat/.test(hint) && (a.kind === "CASH" || /tien mat/.test(n))) || s.accountHints.some((h) => n.includes(h));
      });
      const list = only.length ? only : acc;
      const total = list.reduce((a, x) => a + (x.balanceVnd ?? 0n), 0n);
      const fmt = (a: (typeof acc)[number]) => (a.currency === "VND" ? formatVnd(a.balanceCents / 100n) : `$${(Number(a.balanceCents) / 100).toLocaleString("en-US")}`);
      return {
        text: list.length === 1 ? `${list[0].name}: ${fmt(list[0])}.` : `Tổng tiền ${list.length} tài khoản: ${shortVnd(total)}.`,
        cards: [
          table(
            {
              columns: ["Tài khoản", "Số dư", "Đối soát gần nhất"],
              numeric: [1],
              rows: list.map((a) => [a.name, fmt(a), a.lastReconciliation ? dmy(a.lastReconciliation.asOf) : "—"]),
              hrefs: list.map((a) => `/thu-chi/tai-khoan/${a.id}`),
            },
            0,
          ),
        ],
        link: { href: "/thu-chi", label: "Mở Sổ thu chi" },
      };
    }

    case "CASHFLOW": {
      if (s.period) {
        const r = rangeOf(s, today);
        const page = await listTransactions(db, { from: r.from, to: addDaysIso(r.toExcl, -1), limit: 500 });
        const rows = page.rows;
        // tổng của sổ quỹ — không tính chuyển tiền nội bộ giữa các tài khoản
        const tin = page.inVnd;
        const tout = page.outVnd;
        return {
          text: `${r.label}: thu ${shortVnd(tin)}, chi ${shortVnd(tout)}, chênh ${signed(tin - tout)} (${page.total} bút toán).`,
          cards: [
            table(
              {
                columns: ["Ngày", "Danh mục", "Tài khoản", "Thu", "Chi"],
                numeric: [3, 4],
                rows: rows.slice(0, MAX_ROWS).map((x) => [dmy(x.date).slice(0, 5), x.category, x.account, x.direction === "IN" ? shortVnd(x.amountVnd) : "", x.direction === "OUT" ? shortVnd(x.amountVnd) : ""]),
                hrefs: rows.slice(0, MAX_ROWS).map((x) => `/thu-chi/${x.id}`),
              },
              rows.length,
            ),
          ],
          link: { href: `/thu-chi?${new URLSearchParams({ tu: r.from, den: addDaysIso(r.toExcl, -1) })}`, label: "Mở Sổ thu chi" },
        };
      }
      const weeks = await weeklyCashflow(db, today, 6);
      return {
        text: "Dòng tiền 6 tuần gần nhất:",
        cards: [
          table(
            {
              columns: ["Tuần từ", "Thu", "Chi", "Chênh"],
              numeric: [1, 2, 3],
              rows: weeks.map((w) => [w.label, shortVnd(w.inVnd), shortVnd(w.outVnd), signed(w.inVnd - w.outVnd)]),
            },
            0,
          ),
        ],
        link: { href: "/thu-chi", label: "Mở Sổ thu chi" },
      };
    }

    case "SHIPMENTS": {
      if (s.tracking) {
        const sh = await findShipmentByCode(db, s.tracking);
        if (!sh) return { text: `Chưa có kiện ${s.tracking} trong hệ thống. Dán link / mã vận đơn ở trang Vận chuyển để bot theo dõi.`, link: { href: "/van-chuyen", label: "Mở Vận chuyển" } };
        return {
          text: `Kiện ${sh.label}: ${SHIPMENT_STATUS_LABEL[sh.status] ?? sh.status}, ${sh.itemCount} máy.`,
          link: { href: `/van-chuyen/${sh.id}`, label: "Mở kiện" },
        };
      }
      const rows = (await listShipments(db, 7)).filter((x) => x.status !== "ARRIVED");
      const late = rows.filter((x) => daysLate(x.eta, today, x.status) > 0);
      const lateOnly = /\btre\b|qua han/.test(fold(s.rest + " " + (s.period ? "" : "")));
      const list = lateOnly ? late : rows;
      if (!list.length) return { text: lateOnly ? "Không có kiện nào trễ. 👍" : "Không có kiện nào đang đi." };
      return {
        text: `${rows.length} kiện đang đi${late.length ? `, ${late.length} kiện trễ hẹn` : ""}.`,
        cards: [
          table(
            {
              columns: ["Vận đơn", "Chặng", "Trạng thái", "Máy", "Dự kiến", "Trễ"],
              numeric: [3, 5],
              rows: list.slice(0, MAX_ROWS).map((x) => {
                const d = daysLate(x.eta, today, x.status);
                return [x.trackingNumber ?? x.referenceCode ?? "—", LEG_LABEL[x.legType] ?? x.legType, x.trackStatusText ?? SHIPMENT_STATUS_LABEL[x.status] ?? x.status, String(x.itemCount), x.eta ? dmy(x.eta).slice(0, 5) : "—", d > 0 ? `${d} ngày` : ""];
              }),
              hrefs: list.slice(0, MAX_ROWS).map((x) => `/van-chuyen/${x.id}`),
            },
            list.length,
          ),
        ],
        link: { href: "/van-chuyen", label: "Mở Vận chuyển" },
      };
    }

    case "SHORTAGES": {
      const rows = await listShortages(db);
      if (!rows.length) return { text: "Không có kiện nào thiếu máy. 👍" };
      return {
        text: `${rows.length} máy còn thiếu khi nhận kiện:`,
        cards: [
          table(
            {
              columns: ["Kiện", "Máy", "Serial / IMEI"],
              rows: rows.slice(0, MAX_ROWS).map((r) => [r.tracking ?? "—", r.label, r.serial ?? r.imei1 ?? "—"]),
              hrefs: rows.slice(0, MAX_ROWS).map((r) => `/van-chuyen/${r.shipmentId}`),
            },
            rows.length,
          ),
        ],
        link: { href: "/van-chuyen", label: "Mở Vận chuyển" },
      };
    }

    case "ALERTS": {
      const ov = await getOverview(db, periodRange("thang-nay", today), today);
      if (!ov.alerts.length) return { text: "Không có việc gì cần xử lý. 👍", link: { href: "/", label: "Mở Tổng quan" } };
      return {
        text: `${ov.alerts.length} việc cần xử lý:`,
        cards: [
          table(
            {
              columns: ["Mức", "Việc", "Chi tiết"],
              rows: ov.alerts.slice(0, 12).map((a) => [a.level === "critical" ? "Gấp" : a.level === "warning" ? "Chú ý" : "Nhắc", a.title, a.detail ?? ""]),
              hrefs: ov.alerts.slice(0, 12).map((a) => a.href),
            },
            ov.alerts.length,
          ),
        ],
        link: { href: "/", label: "Mở Tổng quan" },
      };
    }

    case "TAX":
    case "UNINVOICED": {
      const year = s.period?.tu ? +s.period.tu.slice(0, 4) : s.period?.ky === "nam-truoc" ? +today.slice(0, 4) - 1 : +today.slice(0, 4);
      const t = await taxReport(db, year);
      const st = thresholdStatus(t.totalVnd, t.thresholdVnd, t.warnRatio);
      if (intent === "UNINVOICED") {
        if (!t.uninvoiced.length) return { text: `Năm ${year}: mọi đơn hoàn tất đều đã có số hoá đơn. 👍` };
        return {
          text: `Năm ${year}: ${t.uninvoiced.length} đơn chưa có số hoá đơn điện tử, doanh thu ${shortVnd(t.uninvoiced.reduce((a, u) => a + u.revenueVnd, 0n))}.`,
          cards: [
            table(
              {
                columns: ["Ngày", "Mã đơn", "Khách", "Doanh thu"],
                numeric: [3],
                rows: t.uninvoiced.slice(0, MAX_ROWS).map((u) => [dmy(u.date).slice(0, 5), u.code, u.customer ?? "—", shortVnd(u.revenueVnd)]),
                hrefs: t.uninvoiced.slice(0, MAX_ROWS).map((u) => `/ban-hang/${u.id}`),
              },
              t.uninvoiced.length,
            ),
          ],
          chips: t.uninvoiced[0] ? [{ label: `Ghi số HĐ cho ${t.uninvoiced[0].code}`, text: `hoá đơn ${t.uninvoiced[0].code} số ` }] : [],
          link: { href: `/bao-cao?bc=thue&ky=${year === +today.slice(0, 4) ? "nam" : "nam-truoc"}`, label: "Báo cáo Doanh thu thuế" },
        };
      }
      return {
        text:
          `Năm ${year}: doanh thu luỹ kế ${shortVnd(t.totalVnd)} = ${pct(st.usedBp)} ngưỡng ${shortVnd(t.thresholdVnd)}` +
          (st.level === "OVER" ? " — ĐÃ VƯỢT ngưỡng: phải dùng hoá đơn điện tử có mã của cơ quan thuế, kê khai GTGT / TNCN." : st.level === "WARN" ? ` — sắp chạm ngưỡng, còn ${shortVnd(st.remainingVnd)}.` : `, còn ${shortVnd(st.remainingVnd)}.`),
        cards: [
          {
            kind: "stat",
            items: [
              { label: "Doanh thu năm", value: shortVnd(t.totalVnd) },
              { label: "Đã có hoá đơn", value: shortVnd(t.invoicedVnd) },
              { label: "Đơn chưa có HĐ", value: String(t.uninvoiced.length), tone: t.uninvoiced.length ? "warn" : "good" },
              { label: "Ngưỡng", value: pct(st.usedBp), tone: st.level === "OK" ? "good" : st.level === "WARN" ? "warn" : "bad" },
            ],
          },
        ],
        chips: [{ label: "Đơn chưa xuất hoá đơn", text: "đơn nào chưa xuất hoá đơn" }],
        link: { href: `/bao-cao?bc=thue&ky=${year === +today.slice(0, 4) ? "nam" : "nam-truoc"}`, label: "Báo cáo Doanh thu thuế" },
      };
    }

    case "DOCS": {
      if (/hop cho|cho duyet/.test(fold(s.rest))) {
        const n = await inboxCount(db);
        return { text: n ? `Hộp chờ duyệt còn ${n} mã quét chưa duyệt.` : "Hộp chờ duyệt trống.", link: { href: "/quet-ma/hop-cho", label: "Mở Hộp chờ duyệt" } };
      }
      const rows = await missingDossiers(db);
      if (!rows.length) return { text: "Máy nào cũng đủ chứng từ nguồn gốc. 👍" };
      return {
        text: `${rows.length} máy còn thiếu chứng từ nguồn gốc (hoá đơn mua, vận đơn…) — cần bổ sung để chứng minh hàng nhập hợp pháp.`,
        cards: [
          table(
            {
              columns: ["Máy", "Serial", "Thiếu"],
              rows: rows.slice(0, MAX_ROWS).map((r) => [r.label, r.serial ?? "—", r.gaps.map((g) => (g === "PURCHASE" ? "hoá đơn mua" : "chứng từ nhập khẩu")).join(", ")]),
              hrefs: rows.slice(0, MAX_ROWS).map((r) => `/kho/${r.itemId}`),
            },
            rows.length,
          ),
        ],
        link: { href: "/kho/thieu-chung-tu", label: "Mở Máy thiếu chứng từ" },
      };
    }

    case "EXPORT": {
      const r = rangeOf(s, today);
      return {
        text: `Bảng kê ${r.label} (bán, nhập, thu chi, tồn kho, bảng kê nháp) — file Excel chuẩn .xlsx, cột ngày là ngày thật, cột tiền là số.`,
        link: { href: `/tro-ly/xuat?${new URLSearchParams(rangeQuery(r))}`, label: `Tải bảng kê ${r.label}`, download: true },
        chips: [
          { label: "Tháng trước", text: "xuất excel tháng trước" },
          { label: "Quý này", text: "xuất excel quý này" },
          { label: "Năm nay", text: "xuất excel năm nay" },
        ],
      };
    }

    case "BANG_KE":
      return { text: "Bảng kê nháp giữ các tin chưa đủ thông tin để ghi thật — bổ sung rồi bấm Ghi thật.", link: { href: "/tro-ly/bang-ke", label: "Mở Bảng kê nháp" } };

    case "CUSTOMER_LOOKUP": {
      const cs = await findCustomers(db, s);
      if (!cs.length) return { text: `Chưa có khách ${s.customerName ?? s.phone ?? ""}.`, chips: s.customerName || s.phone ? [{ label: "Thêm khách này", text: `thêm khách ${s.customerName ?? ""} ${s.phone ?? ""}`.trim() }] : [] };
      if (cs.length > 1)
        return {
          text: `Có ${cs.length} khách khớp:`,
          cards: [
            table(
              {
                columns: ["Khách", "SĐT", "Số đơn", "Còn nợ"],
                numeric: [2, 3],
                rows: cs.slice(0, MAX_ROWS).map((c) => [c.fullName, c.phone ?? "—", String(c.orders), c.balanceVnd > 0n ? shortVnd(c.balanceVnd) : "—"]),
                hrefs: cs.slice(0, MAX_ROWS).map((c) => `/ban-hang/khach-hang/${c.id}`),
              },
              cs.length,
            ),
          ],
        };
      const c = cs[0];
      const detail = await getCustomer(db, c.id);
      const sales = detail?.sales ?? [];
      return {
        text: `${c.fullName}${c.phone ? ` · ${c.phone}` : ""}: ${c.orders} đơn, doanh thu ${shortVnd(c.revenueVnd)}${c.balanceVnd > 0n ? `, còn nợ ${shortVnd(c.balanceVnd)}` : ""}${c.lastPurchase ? `, mua gần nhất ${dmy(c.lastPurchase)}` : ""}.`,
        cards: sales.length
          ? [
              table(
                {
                  columns: ["Đơn", "Ngày", "Trạng thái"],
                  rows: sales.slice(0, MAX_ROWS).map((x) => [x.code, dmy(x.date), SALE_STATUS_LABEL[x.status] ?? x.status]),
                  hrefs: sales.slice(0, MAX_ROWS).map((x) => `/ban-hang/${x.id}`),
                },
                sales.length,
              ),
            ]
          : [],
        link: { href: `/ban-hang/khach-hang/${c.id}`, label: "Mở hồ sơ khách" },
      };
    }

    default:
      return fallbackReply({ money: s.money.length > 0, date: !!s.period, product: s.variantIds.length > 0, code: s.codes.length > 0 });
  }
}

const LEG_LABEL: Record<string, string> = { US_DOMESTIC: "Nội địa Mỹ", US_TO_VN: "Mỹ → VN", HN_TO_SG: "HN → SG", OTHER: "Khác" };

function addDaysIso(d: string, n: number) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Tra một máy (IMEI / Serial / vài số cuối): trạng thái, giá vốn, lãi nếu đã bán, bảo hành, gợi ý giá. */
async function itemAnswer(q: QueryCtx, intent: Intent, s: Slots): Promise<Reply> {
  const { db, today } = q;
  const code = s.codes.find((c) => c.kind !== "IMEI_BAD") ?? s.codes[0];
  if (!code) {
    if (s.variantIds.length) return answerQuery(q, "STOCK", s);
    return { text: "Gõ IMEI, Serial hoặc vài số cuối (vd: tra đuôi 5672)." };
  }
  if (code.kind === "IMEI_BAD") return { text: `IMEI ${code.value} sai số kiểm tra (chữ số cuối) — kiểm tra lại, có thể gõ nhầm một số.` };
  let item = code.kind === "PARTIAL" ? null : await findItemForSale(db, code.value);
  if (!item) {
    const cands = await itemsByPartialCode(db, code.value);
    if (cands.length === 1) item = await findItemForSale(db, cands[0].serial_number ?? cands[0].imei1 ?? "");
    else if (cands.length > 1)
      return {
        text: `Có ${cands.length} máy khớp "${code.value}":`,
        cards: [
          table(
            {
              columns: ["Máy", "Serial", "IMEI", "Trạng thái"],
              rows: cands.map((c) => [c.label, c.serial_number ?? "—", c.imei1 ?? "—", ITEM_STATUS_LABEL[c.status] ?? c.status]),
              hrefs: cands.map((c) => `/kho/${c.id}`),
            },
            0,
          ),
        ],
        chips: cands.slice(0, 4).map((c) => ({ label: c.serial_number ?? c.imei1 ?? c.id, text: c.serial_number ?? c.imei1 ?? "" })),
      };
  }
  if (!item) return { text: `Không thấy máy ${code.value} trong hệ thống. Nếu là máy mới mua, nhập vào đơn mua trước (vd: nhập máy … vào CH-…).` };
  const profile = await getItemProfile(db, item.id);
  const sale = profile?.sales.filter((x) => !x.voided_at).at(-1);
  const rows: { label: string; value: string; hint?: string; tone?: "good" | "bad" | "warn" }[] = [
    { label: "Trạng thái", value: ITEM_STATUS_LABEL[item.status] ?? item.status },
    { label: "Giá vốn", value: formatVnd(item.costVnd), hint: item.hasEstimate ? "tạm tính" : undefined },
  ];
  if (item.daysInStock !== null && !sale) rows.push({ label: "Ngày tồn", value: `${item.daysInStock} ngày`, tone: item.daysInStock > 45 ? "warn" : undefined });
  if (item.targetPriceVnd !== null) rows.push({ label: "Giá mục tiêu", value: formatVnd(item.targetPriceVnd) });
  if (sale) {
    rows.push({ label: `Đã bán (${sale.code})`, value: formatVnd(sale.priceVnd) });
    if (sale.profitVnd !== null) rows.push({ label: "Lãi", value: signed(sale.profitVnd), tone: toneOf(sale.profitVnd) });
    const w = warrantyState(sale.warranty, today);
    rows.push({ label: "Bảo hành", value: sale.warranty ? `${w === "ACTIVE" ? "còn" : "hết"} tới ${dmy(sale.warranty)}` : "không" });
  }
  const chips: Chip[] = [];
  if (item.sellable !== "NO") {
    chips.push({ label: "Bán máy này", text: `bán ${item.serial ?? item.imei1} ` });
    chips.push({ label: "Đặt giá mục tiêu", text: `đặt giá máy ${item.serial ?? item.imei1} ` });
  }
  let text = `${item.label} · ${item.serial ?? ""}${item.imei1 ? ` · IMEI ${item.imei1}` : ""} · chuyến ${item.batchCode}.`;
  if (intent === "PRICE_SUGGEST") {
    const want = s.money[0] ? BigInt(s.money[0].vnd) : null;
    const margins = [1_000_000n, 2_000_000n, 3_000_000n];
    text += want
      ? ` Muốn lãi ${shortVnd(want)} thì bán tối thiểu ${formatVnd(item.costVnd + want)} (chưa tính giảm giá / phí ship).`
      : ` Giá vốn ${formatVnd(item.costVnd)} — lãi 1tr / 2tr / 3tr: ${margins.map((m) => shortVnd(item.costVnd + m)).join(" / ")}.`;
  }
  if (item.reason && !sale) text += ` ${item.reason}.`;
  return { text, cards: [{ kind: "stat", items: rows }], chips, link: { href: `/kho/${item.id}`, label: "Mở hồ sơ máy" } };
}
