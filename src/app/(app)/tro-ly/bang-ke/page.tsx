import Link from "next/link";
import { dmy } from "@/domain/assistant/dates";
import { CHANNEL_LABEL, CHANNELS } from "@/domain/sales-core";
import { BANG_KE_KIND_LABEL, BANG_KE_KINDS, listBangKe, type BangKeRow } from "@/server/assistant/bang-ke";
import { catalogDb, Empty, NoDatabase } from "../../danh-muc/shared";
import { saveBangKeAction } from "../actions";

export const metadata = { title: "Bảng kê nháp" };

const TABS = [
  { key: "DRAFT", label: "Chờ bổ sung" },
  { key: "PROMOTED", label: "Đã ghi thật" },
  { key: "DISCARDED", label: "Đã bỏ" },
] as const;
const PAYMENTS = [
  ["", "—"],
  ["TRANSFER", "Chuyển khoản"],
  ["CASH", "Tiền mặt"],
  ["UNPAID", "Ghi nợ"],
] as const;

export default async function BangKePage({ searchParams }: PageProps<"/tro-ly/bang-ke">) {
  const db = await catalogDb();
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.tt)?.key ?? "DRAFT";
  const err = typeof sp.loi === "string" ? sp.loi : null;
  if (!db)
    return (
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        <h1 className="mb-4 text-2xl font-bold">Bảng kê nháp</h1>
        <NoDatabase />
      </main>
    );
  const rows = await listBangKe(db, { status: tab });
  return (
    <main className="mx-auto max-w-6xl p-4 md:p-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/tro-ly" className="text-sm text-primary hover:underline">
            ← Trợ lý
          </Link>
          <h1 className="text-2xl font-bold">Bảng kê nháp</h1>
          <p className="max-w-2xl text-sm text-muted">
            Tin nhắn chưa đủ thông tin (máy chưa có trong hệ thống, chưa khớp dòng máy, thiếu đơn mua…) nằm ở đây. Bổ sung từng ô rồi bấm <b>Ghi thật</b> —
            trợ lý lập phiếu để bạn xác nhận như mọi phiếu khác. Chưa ghi thật thì chưa vào sổ, chưa tính doanh thu / giá vốn.
          </p>
        </div>
        <a href="/tro-ly/xuat?ky=thang" className="btn-secondary text-sm">
          Xuất Excel tháng này
        </a>
      </div>

      <nav className="segmented mb-4" aria-label="Lọc bảng kê">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key === "DRAFT" ? "/tro-ly/bang-ke" : `/tro-ly/bang-ke?tt=${t.key}`} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>

      {err && (
        <p className="mb-3 rounded-2xl bg-[var(--warn-bg)] px-4 py-2 text-sm text-[var(--warn)]" role="alert">
          {err}
        </p>
      )}

      {!rows.length ? (
        <Empty>{tab === "DRAFT" ? "Không có dòng nào chờ bổ sung." : "Chưa có dòng nào."}</Empty>
      ) : tab === "DRAFT" ? (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <DraftRow key={r.id} r={r} />
          ))}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                {["Ngày", "Loại", "Dòng máy", "IMEI / Serial", "Số tiền", "Khách", "Kết quả"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5">{r.occurredOn ? dmy(r.occurredOn) : "—"}</td>
                  <td className="px-3 py-1.5">{BANG_KE_KIND_LABEL[r.kind]}</td>
                  <td className="px-3 py-1.5">{r.modelText ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.code ?? "—"}</td>
                  <td className="px-3 py-1.5">{r.priceText ?? "—"}</td>
                  <td className="px-3 py-1.5">{r.customerText ?? "—"}</td>
                  <td className="px-3 py-1.5">
                    {r.promotedHref ? (
                      <Link href={r.promotedHref} className="text-primary hover:underline">
                        Mở bản ghi →
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function L({ t, children, className = "" }: { t: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 text-xs text-muted ${className}`}>
      {t}
      {children}
    </label>
  );
}

function DraftRow({ r }: { r: BangKeRow }) {
  const cell = "field w-full !min-h-10 !py-1.5 text-[15px]";
  return (
    <form action={saveBangKeAction} id={`d-${r.id}`} className="card p-4" data-testid="bang-ke-row">
      <input type="hidden" name="id" value={r.id} />
      {r.reason && <p className="mb-2 text-sm text-[var(--warn)]">⚠ {r.reason}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <L t="Loại">
          <select name="kind" defaultValue={r.kind} className={cell}>
            {BANG_KE_KINDS.map((k) => (
              <option key={k} value={k}>
                {BANG_KE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </L>
        <L t="Ngày">
          <input type="date" name="occurredOn" defaultValue={r.occurredOn ?? ""} className={cell} />
        </L>
        <L t="Dòng máy" className="col-span-2">
          <input name="modelText" defaultValue={r.modelText ?? ""} className={cell} placeholder="vd: pro max 256 silver" />
        </L>
        <L t="IMEI / Serial" className="col-span-2">
          <input name="code" defaultValue={r.code ?? ""} className={`${cell} font-mono`} placeholder="IMEI / Serial (cách nhau dấu cách)" />
        </L>
        <L t="Số tiền">
          <input name="priceText" defaultValue={r.priceText ?? ""} className={cell} placeholder="25tr5 · $999" data-testid="bk-price" />
        </L>
        <L t="Khách / đối tượng">
          <input name="customerText" defaultValue={r.customerText ?? ""} className={cell} />
        </L>
        <L t="SĐT">
          <input name="customerPhone" defaultValue={r.customerPhone ?? ""} className={cell} inputMode="tel" />
        </L>
        <L t="Kênh">
          <select name="channel" defaultValue={r.channel ?? ""} className={cell}>
            <option value="">—</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </L>
        <L t="Thanh toán">
          <select name="payment" defaultValue={PAYMENTS.some(([v]) => v === r.payment) ? (r.payment ?? "") : ""} className={cell}>
            {PAYMENTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </L>
        <L t="Mã chuyến / đơn / vận đơn">
          <input name="refText" defaultValue={r.refText ?? ""} className={`${cell} font-mono`} placeholder="CH-… · BH-… · 1Z…" />
        </L>
        <L t="Ghi chú" className="col-span-2 sm:col-span-4 lg:col-span-6">
          <input name="note" defaultValue={r.note ?? ""} className={cell} />
        </L>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" name="intent" value="promote" className="btn-primary" data-testid="bk-promote">
          Ghi thật
        </button>
        <button type="submit" name="intent" value="save" className="btn-secondary">
          Lưu
        </button>
        <button type="submit" name="intent" value="discard" className="btn-danger">
          Bỏ dòng
        </button>
        <span className="ml-auto text-xs text-muted">Thêm lúc {dmy(r.createdAt.slice(0, 10))}</span>
      </div>
    </form>
  );
}
