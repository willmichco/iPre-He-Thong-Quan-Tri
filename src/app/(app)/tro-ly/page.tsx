import Link from "next/link";
import { QUICK_CHIPS } from "@/domain/assistant/examples";
import { getOrCreateConversation, listMessages } from "@/server/assistant/store";
import { catalogDb, NoDatabase } from "../danh-muc/shared";
import { Chat } from "./Chat";

export const metadata = { title: "Trợ lý" };

export default async function AssistantPage() {
  const db = await catalogDb();
  if (!db)
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-8">
        <h1 className="mb-4 text-2xl font-bold">Trợ lý</h1>
        <NoDatabase />
      </main>
    );
  const conv = await getOrCreateConversation(db);
  const [messages, [drafts]] = await Promise.all([
    listMessages(db, conv.id),
    db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM bang_ke_nhap WHERE status = 'DRAFT'`,
  ]);
  return (
    <main className="mx-auto flex max-w-3xl flex-col p-4 md:p-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Trợ lý</h1>
          <p className="text-sm text-muted">Nhắn tự nhiên để ghi bán, nhập máy, thu chi, hoặc hỏi tồn kho, doanh thu, công nợ. Không có gì được ghi khi chưa bấm Xác nhận.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/tro-ly/bang-ke" className="btn-secondary text-sm" data-testid="link-bang-ke">
            Bảng kê nháp{drafts.n ? ` (${drafts.n})` : ""}
          </Link>
          <a href="/tro-ly/xuat?ky=thang" className="btn-secondary text-sm" data-testid="export-month">
            Excel tháng này
          </a>
        </div>
      </div>
      <Chat initial={messages} quick={QUICK_CHIPS} />
    </main>
  );
}
