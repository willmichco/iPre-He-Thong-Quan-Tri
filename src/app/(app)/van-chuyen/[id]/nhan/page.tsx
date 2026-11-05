import Link from "next/link";
import { notFound } from "next/navigation";
import { LEG_LABEL, type LegType } from "@/domain/catalog";
import { isMainLeg, isoToVnLocal, LEG_RULES } from "@/domain/shipping";
import { getShipment } from "@/server/shipping/service";
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
        Nhận kiện <span className="font-mono">{title}</span>
      </h1>
      <p className="mt-1 text-sm text-muted">
        {LEG_LABEL[s.legType as LegType]} · {s.items.length} máy. Quét Serial / IMEI từng hộp (camera, máy quét, hoặc gõ / dán). Đủ máy → xác nhận; thiếu → nhận
        phần đã quét và ghi sự cố, máy thiếu giữ trạng thái đang vận chuyển cho tới khi tìm thấy.
      </p>
      {open ? (
        <ReceiveClient
          shipmentId={s.id}
          items={s.items.map((i) => ({ id: i.id, label: i.label, serial: i.serial, imei1: i.imei1, imei2: i.imei2, batchCode: i.batchCode }))}
          defaultAt={isoToVnLocal(new Date())}
          arriveLabel={rule?.arriveLabel ?? "Đã nhận"}
        />
      ) : (
        <p className="card mt-4 p-4 text-sm">
          {s.status === "ARRIVED" ? "Kiện đã nhận." : "Kiện chưa gửi đi — bấm “Gửi đi” ở trang kiện trước."}{" "}
          <Link href={`/van-chuyen/${s.id}`} className="underline">
            Về trang kiện
          </Link>
          {s.status === "ARRIVED" && <ClearReceiveSession shipmentId={s.id} />}
        </p>
      )}
    </main>
  );
}
