import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing";
import { STAGES } from "@/domain/overview";
import { listItemsAtStatuses } from "@/server/overview/service";
import { searchItems } from "@/server/sales/service";
import { missingDossiers } from "@/server/attachments/service";
import { catalogDb, Empty, NoDatabase } from "../danh-muc/shared";

export const metadata = { title: "Kho máy" };

const ageClass = (d: number | null) =>
  d === null ? "" : d > 60 ? "text-danger font-semibold" : d > 30 ? "text-[var(--warn)]" : d > 15 ? "" : "text-[var(--ok)]";

export default async function StockPage({ searchParams }: PageProps<"/kho">) {
  const db = await catalogDb();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  const q = one(sp.q);
  // lọc theo chặng (bấm từ thanh "Vốn đang nằm ở đâu" ở Tổng quan)
  const stage = q ? undefined : STAGES.find((s) => s.key === one(sp.chang));
  const [items, missing] = db ? await Promise.all([stage ? listItemsAtStatuses(db, stage.statuses) : searchItems(db, q), missingDossiers(db)]) : [[], []];
  const total = items.reduce((a, i) => a + BigInt(i.cost), 0n);
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Kho máy</h1>
        {db && (
          <Link
            href="/kho/thieu-chung-tu"
            className="badge ml-auto transition-[filter] hover:brightness-95"
            data-tone={missing.length ? "warn" : "ok"}
            data-testid="missing-docs-link"
          >
            {missing.length ? `${missing.length} máy thiếu chứng từ nguồn gốc` : "Hồ sơ chứng từ đủ"}
          </Link>
        )}
      </div>
      <form method="get" role="search" className="mt-3 flex gap-2">
        <label className="flex grow flex-col gap-1 text-sm">
          <span className="text-muted">Tìm theo Serial / IMEI / Part No. / tên máy — trống: máy đang tồn ở SG</span>
          <input name="q" defaultValue={q} className="field font-mono" autoCapitalize="characters" autoComplete="off" placeholder="Quét hoặc gõ mã" />
        </label>
        <button type="submit" className="btn-secondary self-end">
          Tìm
        </button>
      </form>
      {stage && (
        <p className="mt-3 flex items-center gap-2 text-sm">
          <span className="chip" data-testid="stage-filter">
            Chặng: {stage.label}
          </span>
          <Link href="/kho" className="text-muted underline">
            Bỏ lọc
          </Link>
        </p>
      )}
      {!db ? (
        <div className="mt-4">
          <NoDatabase />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4">
          <Empty>{q ? `Không có máy nào khớp "${q}".` : stage ? `Không có máy nào ở chặng ${stage.label}.` : "Chưa có máy nào tồn ở SG."}</Empty>
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm text-muted">
            {items.length} máy · tổng giá vốn {formatVnd(total)} ₫
          </p>
          <div className="card mt-2 overflow-x-auto">
            <table className="w-full text-sm" aria-label="Danh sách máy">
              <thead className="text-left text-muted">
                <tr>
                  <th className="p-2 font-medium">Máy</th>
                  <th className="p-2 font-medium">Serial / IMEI</th>
                  <th className="p-2 font-medium">Trạng thái</th>
                  <th className="p-2 font-medium">Chuyến</th>
                  <th className="p-2 font-medium text-right">Giá vốn</th>
                  <th className="p-2 font-medium text-right">Tồn</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-t border-border">
                    <td className="p-2">
                      <Link href={`/kho/${i.id}`} className="underline">
                        {i.label}
                      </Link>
                    </td>
                    <td className="p-2 font-mono text-xs">{i.serial_number ?? i.imei1 ?? "—"}</td>
                    <td className="p-2">{ITEM_STATUS_LABEL[i.status] ?? i.status}</td>
                    <td className="p-2">{i.batch_code}</td>
                    <td className="p-2 text-right tabular-nums">{formatVnd(BigInt(i.cost))} ₫</td>
                    <td className={`p-2 text-right tabular-nums ${ageClass(i.days)}`}>{i.days === null ? "—" : `${i.days} ngày`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
