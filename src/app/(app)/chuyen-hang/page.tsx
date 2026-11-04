import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { BATCH_STATUS_LABEL } from "@/domain/purchasing";
import { listBatches, suggestBatchCode } from "@/server/purchasing/service";
import { ActionForm, Input, Submit } from "../_components/form";
import { catalogDb, Empty, NoDatabase } from "../danh-muc/shared";
import { createBatchAction } from "./actions";

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
        <ActionForm action={createBatchAction} resetOnSuccess label="Tạo chuyến" className="mt-3 flex flex-wrap items-end gap-3">
          <Input label="Mã chuyến" name="code" placeholder={nextCode} autoCapitalize="characters" className="w-40" hint="Để trống: tự cấp" />
          <Input label="Tên / ghi nhớ" name="name" placeholder="vd: Black Friday" className="grow min-w-48" />
          <Input label="Tỷ giá dự kiến" name="plannedFxRate" inputMode="decimal" placeholder="26.400" className="w-36" />
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
                <Link href={`/chuyen-hang/${b.id}`} className="card block p-4 hover:border-primary" aria-label={`Chuyến ${b.code}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <b>{b.code}</b>
                    {b.name && <span className="text-muted">{b.name}</span>}
                    <span className="ml-auto text-xs rounded-full border border-border px-2 py-0.5">{BATCH_STATUS_LABEL[b.status] ?? b.status}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                    <span>
                      <span className="text-muted">Máy </span>
                      {b.itemCount} · đã bán {b.soldCount}
                    </span>
                    <span>
                      <span className="text-muted">Tổng vốn </span>
                      {formatVnd(b.totalLandedCostVnd)} ₫
                    </span>
                    <span>
                      <span className="text-muted">Lãi đã bán </span>
                      <span className={b.realizedProfitVnd < 0n ? "text-danger" : ""}>{formatVnd(b.realizedProfitVnd)} ₫</span>
                      {b.roiOnSoldPct && <span className="text-muted"> · ROI {b.roiOnSoldPct.replace(".", ",")}%</span>}
                    </span>
                    <span>
                      <span className="text-muted">Vốn đọng </span>
                      {formatVnd(b.unsoldCostVnd)} ₫
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
