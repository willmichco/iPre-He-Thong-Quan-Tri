import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { BATCH_STATUS_LABEL } from "@/domain/purchasing";
import { listBatches, suggestBatchCode } from "@/server/purchasing/service";
import { ActionForm, Input, Submit } from "../_components/form";
import { catalogDb, Empty, NoDatabase } from "../danh-muc/shared";
import { createBatchAction } from "./actions";
import { BATCH_TONE } from "../_components/tones";

export const metadata = { title: "Chuyến hàng" };

export default async function BatchesPage() {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-5xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const [batches, nextCode] = await Promise.all([listBatches(db), suggestBatchCode(db)]);
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="text-2xl font-bold">Chuyến hàng</h1>
      <p className="mt-1 text-sm text-muted">Mỗi chuyến gồm các đơn mua tại Mỹ và từng máy; giá vốn, lãi lỗ tự tính theo chuyến.</p>

      <section className="card mt-5 p-4" aria-labelledby="tao-chuyen">
        <h2 id="tao-chuyen" className="font-semibold">
          Tạo chuyến mới
        </h2>
        <ActionForm action={createBatchAction} resetOnSuccess label="Tạo chuyến" className="mt-3 field-row">
          <Input label="Mã chuyến" name="code" placeholder={nextCode} autoCapitalize="characters" className="w-36" hint="Để trống: tự cấp" />
          <Input label="Tên / ghi nhớ" name="name" placeholder="vd: Black Friday" className="grow min-w-40" />
          <Input label="Tỷ giá dự kiến" name="plannedFxRate" inputMode="decimal" placeholder="26.400" className="w-32" />
          <Submit>Tạo chuyến</Submit>
        </ActionForm>
      </section>

      <section className="mt-6" aria-label="Danh sách chuyến">
        {batches.length === 0 ? (
          <Empty>Chưa có chuyến nào.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {batches.map((b) => (
              <li key={b.id}>
                <Link href={`/chuyen-hang/${b.id}`} className="card block p-4 transition-transform hover:-translate-y-0.5" aria-label={`Chuyến ${b.code}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <b>{b.code}</b>
                    {b.name && <span className="text-muted">{b.name}</span>}
                    <span className="badge ml-auto" data-tone={BATCH_TONE[b.status] ?? "muted"}>
                      {BATCH_STATUS_LABEL[b.status] ?? b.status}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
                    <Stat label="Máy" value={`${b.itemCount}`} note={`đã bán ${b.soldCount}`} />
                    <Stat label="Tổng vốn" value={`${formatVnd(b.totalLandedCostVnd)} ₫`} />
                    <Stat
                      label="Lãi đã bán"
                      value={`${formatVnd(b.realizedProfitVnd)} ₫`}
                      danger={b.realizedProfitVnd < 0n}
                      note={b.roiOnSoldPct ? `ROI ${b.roiOnSoldPct.replace(".", ",")}%` : undefined}
                    />
                    <Stat label="Vốn đọng" value={`${formatVnd(b.unsoldCostVnd)} ₫`} />
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** Một chỉ số trên thẻ chuyến: nhãn nhỏ ở trên, số ở dưới (không bao giờ chen chung một dòng → không rớt dòng lộn xộn). */
function Stat({ label, value, note, danger = false }: { label: string; value: string; note?: string; danger?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-0.5 whitespace-nowrap font-semibold tabular-nums ${danger ? "text-danger" : ""}`}>{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  );
}
