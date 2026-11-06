import Link from "next/link";
import { ACTION_LABEL, changes, ENTITY_LABEL, entityHref, parseAuditFilter, type FieldChange } from "@/domain/audit";
import { auditTypes, listAudit, type AuditRow } from "@/server/audit/service";
import { Glyph, type GlyphName } from "../../_components/Glyph";
import { catalogDb, Empty, NoDatabase } from "../../danh-muc/shared";
import { todayVn } from "../../van-chuyen/shared";

export const metadata = { title: "Nhật ký thay đổi — Cài đặt" };

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

  // nhóm theo ngày (giờ VN, chuỗi "DD/MM/YYYY HH:MM:SS") — đọc lướt theo ngày dễ hơn một danh sách dài
  const days: { day: string; rows: AuditRow[] }[] = [];
  for (const r of rows) {
    const day = r.at.slice(0, 10);
    const last = days.at(-1);
    if (last?.day === day) last.rows.push(r);
    else days.push({ day, rows: [r] });
  }
  const isoToday = todayVn();
  const today = isoToday.split("-").reverse().join("/");
  const yesterday = new Date(Date.parse(`${isoToday}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10).split("-").reverse().join("/");

  return (
    <main className="mx-auto max-w-5xl p-4 md:p-8">
      <Link href="/cai-dat" className="text-sm text-muted hover:text-text">
        ← Cài đặt
      </Link>
      <h1 className="mt-1 text-2xl font-bold">Nhật ký thay đổi</h1>
      <p className="mt-1 text-sm text-muted">
        Mọi thao tác ghi dữ liệu — tạo, sửa, xoá, chốt / mở lại chuyến, nhận kiện, bán, thu chi… — kèm giá trị trước và sau.
      </p>
      <div className="callout mt-3" data-tone="info">
        <Glyph name="lock" size={16} />
        <p>
          Nhật ký chỉ được thêm: cơ sở dữ liệu từ chối mọi lệnh sửa / xoá dòng nhật ký. Không ghi tên, số điện thoại khách (chỉ mã khách) để ẩn danh hoá khách
          vẫn trọn vẹn.
        </p>
      </div>

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
          <Glyph name="search" size={17} />
          Lọc
        </button>
        {filtered && (
          <Link href="/cai-dat/nhat-ky" className="btn-secondary text-center md:self-end">
            Bỏ lọc
          </Link>
        )}
      </form>
      {f.entityId && (
        <div className="callout mt-3" data-tone="info">
          <Glyph name="history" size={16} />
          <p>
            Đang xem lịch sử của một đối tượng · <span className="chip">{f.entityId}</span>{" "}
            <Link href={`/cai-dat/nhat-ky${qs({ id: null })}`} className="font-medium underline">
              xem tất cả
            </Link>
          </p>
        </div>
      )}

      <div className="mt-5">
        {rows.length === 0 ? (
          <Empty>{filtered ? "Không có dòng nào khớp bộ lọc." : "Chưa có thao tác nào."}</Empty>
        ) : (
          <div className="flex flex-col gap-5">
            {days.map((g) => (
              <section key={g.day} aria-label={`Ngày ${g.day}`}>
                <h2 className="mb-2 flex items-baseline gap-2 px-1 text-sm font-semibold">
                  {g.day === today ? "Hôm nay" : g.day === yesterday ? "Hôm qua" : g.day}
                  {(g.day === today || g.day === yesterday) && <span className="text-xs font-normal text-muted">{g.day}</span>}
                </h2>
                <ol className="flex flex-col gap-2">
                  {g.rows.map((r) => (
                    <Entry key={r.id} r={r} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>

      {(f.beforeId || next) && (
        <nav className="mt-5 flex justify-between gap-3 text-sm" aria-label="Trang">
          {f.beforeId ? (
            <Link href={`/cai-dat/nhat-ky${qs({})}`} className="btn-secondary">
              ← Mới nhất
            </Link>
          ) : (
            <span />
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

const ACTION_STYLE: Record<string, { tone: string; icon: GlyphName }> = {
  CREATE: { tone: "ok", icon: "plus" },
  UPDATE: { tone: "info", icon: "pencil" },
  DELETE: { tone: "danger", icon: "trash" },
  RESTORE: { tone: "ok", icon: "refresh" },
  FINALIZE: { tone: "info", icon: "lock" },
  REOPEN: { tone: "warn", icon: "unlock" },
  LOGIN: { tone: "muted", icon: "login" },
};

/** Tạo / xoá ghi lại cả bản ghi → nhiều trường: quá ngưỡng này thì thu gọn, bấm mới mở. */
const FOLD_AT = 4;

function Entry({ r }: { r: AuditRow }) {
  const diff = changes(r.before, r.after);
  const href = entityHref(r.entityType, r.entityId);
  const label = ENTITY_LABEL[r.entityType] ?? r.entityType;
  const st = ACTION_STYLE[r.action] ?? { tone: "muted", icon: "info" as const };
  const isEdit = diff.some((c) => c.before !== null && c.after !== null);
  const fold = !isEdit && diff.length > FOLD_AT;
  return (
    <li className="card p-3.5 text-sm" data-testid="audit-row">
      <div className="flex items-start gap-3">
        <span className="icon-tile h-8 w-8 rounded-[10px]" data-tone={st.tone}>
          <Glyph name={st.icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{ACTION_LABEL[r.action] ?? r.action}</span>
            <span>
              {href ? (
                <Link href={href} className="font-medium text-primary hover:underline">
                  {label}
                </Link>
              ) : (
                label
              )}
            </span>
            {r.entityId && (
              <Link href={`/cai-dat/nhat-ky?id=${r.entityId}`} className="chip hover:bg-[var(--fill-strong)]" title="Lịch sử của đối tượng này">
                {r.entityId.slice(0, 8)}
              </Link>
            )}
            <span className="ml-auto text-xs tabular-nums text-muted">
              {r.at.slice(11)}
              {r.ip && ` · IP ${r.ip}`}
            </span>
          </div>
          {diff.length > 0 &&
            (fold ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-muted">Xem {diff.length} trường</summary>
                <Changes diff={diff} />
              </details>
            ) : (
              <Changes diff={diff} />
            ))}
        </div>
      </div>
    </li>
  );
}

function Changes({ diff }: { diff: FieldChange[] }) {
  return (
    <dl className="mt-2 grid gap-x-3 gap-y-1.5 rounded-xl bg-[var(--fill)] p-2.5 text-xs sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]" aria-label="Thay đổi">
      {diff.map((c) => (
        <div key={c.key} className="contents">
          <dt className="truncate pt-0.5 text-muted" title={c.key}>
            {c.key}
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1 font-mono">
            {c.before !== null && <del className="break-all rounded-md bg-[var(--danger-bg)] px-1.5 py-0.5 text-danger decoration-1">{c.before}</del>}
            {c.before !== null && c.after !== null && <Glyph name="arrow" size={12} className="shrink-0 text-muted" />}
            {c.after !== null && <ins className="break-all rounded-md bg-[var(--ok-bg)] px-1.5 py-0.5 text-[var(--ok)] no-underline">{c.after}</ins>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
