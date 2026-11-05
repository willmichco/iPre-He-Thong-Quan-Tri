/**
 * Đọc nhật ký kiểm toán (audit_logs). Chỉ đọc — bảng chỉ được thêm dòng, không sửa / xoá.
 */
import type { Sql, TransactionSql } from "postgres";
import type { AuditFilter } from "@/domain/audit";

type Db = Sql | TransactionSql;

export interface AuditRow {
  id: number;
  /** "dd/mm/yyyy hh:mi:ss" giờ VN */
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
}

export const PAGE_SIZE = 50;

/** Mới → cũ, mỗi trang PAGE_SIZE dòng; `next` = id để xem trang tiếp (cũ hơn), null = hết. */
export async function listAudit(db: Db, f: AuditFilter): Promise<{ rows: AuditRow[]; next: number | null }> {
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db<
    {
      id: string;
      at: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      before: unknown;
      after: unknown;
      ip: string | null;
      user_agent: string | null;
    }[]
  >`
    SELECT a.id::text, to_char(a.occurred_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI:SS') AS at, a.action, a.entity_type,
           a.entity_id::text, a.before, a.after, host(a.ip) AS ip, a.user_agent
      FROM audit_logs a
     WHERE (${f.entityType}::text IS NULL OR a.entity_type = ${f.entityType})
       AND (${f.action}::text IS NULL OR a.action = ${f.action})
       AND (${f.entityId}::uuid IS NULL OR a.entity_id = ${f.entityId}::uuid)
       AND (${f.from}::date IS NULL OR a.occurred_at >= (${f.from}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND (${f.to}::date IS NULL OR a.occurred_at < (${f.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
       AND (${like}::text IS NULL OR a.entity_id::text ILIKE ${like} OR a.before::text ILIKE ${like} OR a.after::text ILIKE ${like})
       AND (${f.beforeId}::bigint IS NULL OR a.id < ${f.beforeId})
     ORDER BY a.id DESC
     LIMIT ${PAGE_SIZE + 1}`;
  const page = rows.slice(0, PAGE_SIZE).map((r) => ({
    id: Number(r.id),
    at: r.at,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    before: r.before,
    after: r.after,
    ip: r.ip,
    userAgent: r.user_agent,
  }));
  return { rows: page, next: rows.length > PAGE_SIZE ? page[page.length - 1].id : null };
}

/** Các loại đối tượng đã có trong nhật ký (cho ô lọc). */
export async function auditTypes(db: Db): Promise<string[]> {
  return (await db<{ t: string }[]>`SELECT DISTINCT entity_type AS t FROM audit_logs ORDER BY 1`).map((r) => r.t);
}
