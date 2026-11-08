import Link from "next/link";
import { GAP_LABEL } from "@/domain/attachments";
import { ITEM_STATUS_LABEL } from "@/domain/purchasing-core";
import { missingDossiers } from "@/server/attachments/service";
import { catalogDb, Empty, NoDatabase } from "../../danh-muc/shared";
import { BackLink } from "../../_components/BackLink";
import { Glyph } from "../../_components/Glyph";

export const metadata = { title: "Máy thiếu chứng từ — Kho máy" };

/** Máy đang trong tay (đi đường / tồn kho / khách cọc) mà hồ sơ nguồn gốc chưa đủ — gom theo chuyến. */
export default async function MissingDocsPage() {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-5xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const rows = await missingDossiers(db);
  const batches = [...new Map(rows.map((r) => [r.batchId, r.batchCode])).entries()];
  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <BackLink href="/kho">Kho máy</BackLink>
      <h1 className="mt-1 text-2xl font-bold">Máy thiếu chứng từ nguồn gốc</h1>
      <p className="mt-1 text-sm text-muted">
        Hàng nhập khẩu lưu thông trên thị trường phải có hoá đơn, chứng từ kèm theo; thiếu có thể bị coi là hàng nhập lậu, bị phạt và tịch thu. Cần: hoá đơn /
        biên nhận của đơn mua, và — khi máy đã đi chặng Mỹ → VN — vận đơn hoặc chứng từ thông quan gắn vào kiện hay chuyến.
      </p>
      <div className="mt-4">
        {rows.length === 0 ? (
          <Empty>Mọi máy đang trong tay đều đủ chứng từ.</Empty>
        ) : (
          <div className="flex flex-col gap-4" data-testid="missing-docs">
            <div className="callout" data-tone="warn">
              <Glyph name="warn" size={17} />
              <p className="font-semibold">{rows.length} máy thiếu chứng từ</p>
            </div>
            {batches.map(([batchId, code]) => {
              const items = rows.filter((r) => r.batchId === batchId);
              return (
                <section key={batchId} className="card p-4" aria-label={`Chuyến ${code}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="font-semibold">Chuyến {code}</h2>
                    <span className="text-sm text-muted">{items.length} máy</span>
                    <Link href={`/chuyen-hang/${batchId}`} className="ml-auto text-sm underline">
                      Thêm chứng từ ở trang chuyến
                    </Link>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {items.map((r) => (
                      <li key={r.itemId} className="flex flex-wrap items-baseline gap-x-2">
                        <Link href={`/kho/${r.itemId}`} className="underline">
                          {r.label}
                        </Link>
                        <span className="font-mono text-xs text-muted">{r.serial ?? ""}</span>
                        <span className="text-xs text-muted">{ITEM_STATUS_LABEL[r.status] ?? r.status}</span>
                        <span className="text-xs text-[var(--warn)]">{r.gaps.map((g) => GAP_LABEL[g]).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
