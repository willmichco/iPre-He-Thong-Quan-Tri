import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing";
import { searchItems } from "@/server/sales/service";
import { catalogDb, Empty, NoDatabase } from "../danh-muc/shared";

export const metadata = { title: "Kho máy" };

const ageClass = (d: number | null) =>
  d === null ? "" : d > 60 ? "text-danger font-semibold" : d > 30 ? "text-[var(--warn)]" : d > 15 ? "" : "text-[var(--ok)]";

export default async function StockPage({ searchParams }: PageProps<"/kho">) {
  const db = await catalogDb();
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const items = db ? await searchItems(db, q) : [];
  const total = items.reduce((a, i) => a + BigInt(i.cost), 0n);
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="text-2xl font-bold">Kho máy</h1>
      <form method="get" role="search" className="mt-3 flex gap-2">
        <label className="flex grow flex-col gap-1 text-sm">
          <span className="text-muted">Tìm theo Serial / IMEI / Part No. / tên máy — trống: máy đang tồn ở SG</span>
          <input name="q" defaultValue={q} className="field font-mono" autoCapitalize="characters" autoComplete="off" placeholder="Quét hoặc gõ mã" />
        </label>
        <button type="submit" className="btn-secondary self-end">
          Tìm
        </button>
      </form>
      {!db ? (
        <div className="mt-4">
          <NoDatabase />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4">
          <Empty>{q ? `Không có máy nào khớp "${q}".` : "Chưa có máy nào tồn ở SG."}</Empty>
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
