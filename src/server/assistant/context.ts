/**
 * Trợ lý — ngữ cảnh đọc câu: danh mục cấu hình (để khớp dòng máy), tên tài khoản, ngày hôm nay theo giờ VN.
 */
import type { Sql, TransactionSql } from "postgres";
import type { ParseCtx } from "@/domain/assistant/parse";
import { variantRefs } from "@/server/purchasing/service";

type Db = Sql | TransactionSql;

export const todayVn = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

export async function loadParseCtx(db: Db, today: string): Promise<ParseCtx> {
  const [variants, accounts] = await Promise.all([
    variantRefs(db as Sql),
    db<{ name: string }[]>`SELECT name FROM accounts WHERE is_active ORDER BY name`,
  ]);
  return { today, variants, accountNames: accounts.map((a) => a.name) };
}
