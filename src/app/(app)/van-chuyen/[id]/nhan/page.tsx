import Link from "next/link";
import { notFound } from "next/navigation";
import { LEG_LABEL, type LegType } from "@/domain/catalog";
import { isMainLeg, isoToVnLocal, LEG_RULES } from "@/domain/shipping";
import { getShipment } from "@/server/shipping/service";
import { Glyph } from "../../../_components/Glyph";
import { catalogDb, NoDatabase } from "../../../danh-muc/shared";
import { ClearReceiveSession, ReceiveClient } from "./ReceiveClient";

export const metadata = { title: "Nhận kiện — quét đối chiếu" };

/** Nhận kiện tại nơi đến bằng quét từng hộp, đối chiếu với danh sách máy đã gửi (tài liệu 07 mục 5.1). */
export default async function ReceivePage({ params }: PageProps<"/van-chuyen/[id]/nhan">) {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const s = await getShipment(db, id);
  if (!s) notFound();
  const title = s.trackingNumber ?? s.referenceCode ?? "Kiện chưa có mã";
  const rule = isMainLeg(s.legType) ? LEG_RULES[s.legType] : null;
  const open = s.status === "IN_TRANSIT" || s.status === "HOLD";

  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <Link href={`/van-chuyen/${s.id}`} className="text-sm text-muted hover:text-text">
        ← Kiện {title}
      </Link>
      <h1 className="mt-1 text-2xl font-bold">
        Nhận kiện <span className="font-mono tracking-tight">{title}</span>
      </h1>
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
        <span className="badge" data-tone="info">
          {LEG_LABEL[s.legType as LegType]}
        </span>
        <span className="text-muted">{s.items.length} máy trong kiện</span>
      </p>
      <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-3" aria-label="Các bước nhận kiện">
        {[
          ["Quét từng hộp", "Serial / IMEI bằng camera, máy quét hoặc gõ / dán."],
          ["Đối chiếu tự động", "Khớp với danh sách máy đã gửi, báo mã lạ."],
          ["Xác nhận", "Đủ máy → nhận; thiếu → nhận phần đã quét và ghi sự cố, máy thiếu giữ trạng thái đang vận chuyển."],
        ].map(([t, d], k) => (
          <li key={t} className="flex gap-2.5 rounded-2xl bg-[var(--fill)] p-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--primary-tint)] text-xs font-bold text-primary">{k + 1}</span>
            <span>
              <span className="block font-medium">{t}</span>
              <span className="text-xs text-muted">{d}</span>
            </span>
          </li>
        ))}
      </ol>
      {open ? (
        <ReceiveClient
          shipmentId={s.id}
          items={s.items.map((i) => ({ id: i.id, label: i.label, serial: i.serial, imei1: i.imei1, imei2: i.imei2, batchCode: i.batchCode }))}
          defaultAt={isoToVnLocal(s.trackDeliveredAt ? new Date(s.trackDeliveredAt) : new Date())}
          arriveLabel={rule?.arriveLabel ?? "Đã nhận"}
        />
      ) : (
        <div className="callout mt-4" data-tone={s.status === "ARRIVED" ? "ok" : "info"}>
          <Glyph name={s.status === "ARRIVED" ? "checkCircle" : "info"} size={17} />
          <p>
            {s.status === "ARRIVED" ? "Kiện đã nhận." : "Kiện chưa gửi đi — bấm “Gửi đi” ở trang kiện trước."}{" "}
            <Link href={`/van-chuyen/${s.id}`} className="font-medium underline">
              Về trang kiện
            </Link>
          </p>
          {s.status === "ARRIVED" && <ClearReceiveSession shipmentId={s.id} />}
        </div>
      )}
    </main>
  );
}
