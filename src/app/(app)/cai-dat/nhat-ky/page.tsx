import Link from "next/link";
import { ACTION_LABEL, changes, ENTITY_LABEL, entityHref, parseAuditFilter } from "@/domain/audit";
import { auditTypes, listAudit, type AuditRow } from "@/server/audit/service";
import { catalogDb, Empty, NoDatabase } from "../../danh-muc/shared";

export const metadata = { title: "Nhật ký thay đổi — Cài đặt" };

const ACTION_CLS: Record<string, string> = {
  CREATE: "text-[var(--ok)]",
  DELETE: "text-danger",
  FINALIZE: "text-primary",
  REOPEN: "text-[var(--warn)]",
};

/** Nhật ký kiểm toán: mọi thao tác ghi (ai sửa gì, lúc nào, trước → sau). Chỉ xem, không sửa / xoá được. */
export default async function AuditPage({ searchParams }: PageProps<"/cai-dat/nhat-ky">) {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-5xl p-4 md:p-8">
        <NoDatabase />
      </main>
    );
  const f = parseAuditFilter(await searchParams);
  const [{ rows, next }, types] = await Promise.all([listAudit(db, f), auditTypes(db)]);
  const qs = (over: Partial<Record<string, string | null>>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | null> = {
      loai: f.entityType,
      "thao-tac": f.action,
      tu: f.from,
      den: f.to,
      q: f.q,
      id: f.entityId,
      ...over,
    };
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const filtered = Boolean(f.entityType || f.action || f.from || f.to || f.q || f.entityId);

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <Link href="/cai-dat" className="text-sm text-muted hover:text-text">
        ← Cài đặt
      </Link>
      <h1 className="mt-1 text-2xl font-bold">Nhật ký thay đổi</h1>
      <p className="mt-1 text-sm text-muted">
        Mọi thao tác ghi dữ liệu — tạo, sửa, xoá, chốt / mở lại chuyến, nhận kiện, bán, thu chi… — kèm giá trị trước và sau. Nhật ký chỉ được thêm: cơ sở dữ
        liệu từ chối mọi lệnh sửa / xoá dòng nhật ký. Không ghi tên, số điện thoại khách (chỉ mã khách) để ẩn danh hoá khách vẫn trọn vẹn.
      </p>

      <form method="get" className="card mt-4 grid grid-cols-2 gap-3 p-4 md:flex md:flex-wrap md:items-end" aria-label="Lọc nhật ký">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Đối tượng</span>
          <select name="loai" aria-label="Đối tượng" defaultValue={f.entityType ?? ""} className="field w-full md:min-w-44">
            <option value="">— tất cả —</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {ENTITY_LABEL[t] ?? t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Thao tác</span>
          <select name="thao-tac" aria-label="Thao tác" defaultValue={f.action ?? ""} className="field w-full">
            <option value="">— tất cả —</option>
            {Object.entries(ACTION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Từ ngày</span>
          <input type="date" name="tu" defaultValue={f.from ?? ""} className="field w-full" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Đến ngày</span>
          <input type="date" name="den" defaultValue={f.to ?? ""} className="field w-full" />
        </label>
        <label className="col-span-2 flex grow flex-col gap-1 text-sm">
          <span className="text-muted">Tìm (Serial, IMEI, mã chuyến, mã đối tượng…)</span>
          <input type="search" name="q" defaultValue={f.q ?? ""} className="field w-full md:min-w-48" autoCapitalize="characters" spellCheck={false} />
        </label>
        {f.entityId && <input type="hidden" name="id" value={f.entityId} />}
        <button type="submit" className="btn-primary md:self-end">
          Lọc
        </button>
        {filtered && (
          <Link href="/cai-dat/nhat-ky" className="btn-secondary text-center md:self-end">
            Bỏ lọc
          </Link>
        )}
      </form>
      {f.entityId && (
        <p className="mt-2 text-sm">
          Đang xem lịch sử của một đối tượng · <span className="font-mono text-xs">{f.entityId}</span>{" "}
          <Link href={`/cai-dat/nhat-ky${qs({ id: null })}`} className="underline">
            xem tất cả
          </Link>
        </p>
      )}

      <div className="mt-4">
        {rows.length === 0 ? (
          <Empty>{filtered ? "Không có dòng nào khớp bộ lọc." : "Chưa có thao tác nào."}</Empty>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Nhật ký">
            {rows.map((r) => (
              <Entry key={r.id} r={r} />
            ))}
          </ol>
        )}
      </div>

      {(f.beforeId || next) && (
        <nav className="mt-4 flex gap-3 text-sm" aria-label="Trang">
          {f.beforeId && (
            <Link href={`/cai-dat/nhat-ky${qs({})}`} className="btn-secondary">
              ← Mới nhất
            </Link>
          )}
          {next && (
            <Link href={`/cai-dat/nhat-ky${qs({ truoc: String(next) })}`} className="btn-secondary">
              Cũ hơn →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}

function Entry({ r }: { r: AuditRow }) {
  const diff = changes(r.before, r.after);
  const href = entityHref(r.entityType, r.entityId);
  const label = ENTITY_LABEL[r.entityType] ?? r.entityType;
  return (
    <li className="card p-3 text-sm" data-testid="audit-row">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tabular-nums text-muted">{r.at}</span>
        <span className={`font-semibold ${ACTION_CLS[r.action] ?? ""}`}>{ACTION_LABEL[r.action] ?? r.action}</span>
        <span>
          {href ? (
            <Link href={href} className="underline">
              {label}
            </Link>
          ) : (
            label
          )}
        </span>
        {r.entityId && (
          <Link href={`/cai-dat/nhat-ky?id=${r.entityId}`} className="font-mono text-xs text-muted hover:text-text" title="Lịch sử của đối tượng này">
            {r.entityId.slice(0, 8)}
          </Link>
        )}
        {r.ip && <span className="text-xs text-muted">· IP {r.ip}</span>}
      </div>
      {diff.length > 0 && (
        <table className="mt-2 w-full text-xs" aria-label="Thay đổi">
          <tbody>
            {diff.map((c) => (
              <tr key={c.key} className="border-t border-border align-top">
                <th scope="row" className="w-40 py-1 pr-2 text-left font-normal text-muted">
                  {c.key}
                </th>
                <td className="break-all py-1 font-mono">
                  {c.before !== null && <del className="text-danger no-underline line-through decoration-1">{c.before}</del>}
                  {c.before !== null && c.after !== null && <span className="px-1 text-muted">→</span>}
                  {c.after !== null && <ins className="text-[var(--ok)] no-underline">{c.after}</ins>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}
