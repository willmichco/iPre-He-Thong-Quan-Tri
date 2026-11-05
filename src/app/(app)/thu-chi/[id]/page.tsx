import Link from "next/link";
import { notFound } from "next/navigation";
import { formatVnd } from "@/domain/costing";
import { deletableSource, editableSource, formatAmount, SOURCE_LABEL } from "@/domain/ledger";
import { accountOptions, getTransaction, listCategories } from "@/server/ledger/service";
import { ActionForm, Submit } from "../../_components/form";
import { catalogDb, NoDatabase } from "../../danh-muc/shared";
import { todayVn } from "../../van-chuyen/shared";
import { deleteEntryAction } from "../actions";
import { categoryOptions, EntryForm } from "../ui";

export const metadata = { title: "Bút toán — Thu chi" };

export default async function EntryPage({ params }: PageProps<"/thu-chi/[id]">) {
  const db = await catalogDb();
  if (!db) return <NoDatabase />;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTransaction(db, id);
  if (!t) notFound();
  const [cats, accounts] = await Promise.all([listCategories(db), accountOptions(db)]);
  // tài khoản đã ngừng dùng vẫn phải hiện được khi sửa bút toán cũ của nó
  const accs = accounts.some((a) => a.id === t.accountId) ? accounts : [...accounts, { id: t.accountId, name: t.account, currency: t.currency }];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        <Link href="/thu-chi" className="text-muted underline">
          ← Sổ quỹ
        </Link>
      </p>
      <section className="card p-4" aria-label="Bút toán">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <b className={`text-xl tabular-nums ${t.direction === "IN" ? "text-[var(--ok)]" : ""}`}>
            {t.direction === "IN" ? "+" : "−"}
            {formatAmount(t.amountCents, t.currency)}
          </b>
          {t.currency === "USD" && <span className="text-sm text-muted">≈ {formatVnd(t.amountVnd)} ₫</span>}
          <span className="chip">{SOURCE_LABEL[t.source]}</span>
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row k="Ngày" v={t.date.split("-").reverse().join("/")} />
          <Row
            k="Tài khoản"
            v={
              <Link href={`/thu-chi/tai-khoan/${t.accountId}`} className="underline">
                {t.account}
              </Link>
            }
          />
          <Row k="Danh mục" v={`${t.category}${t.isOperating ? " (chi phí vận hành)" : ""}`} />
          {t.counterparty && <Row k="Đối tượng" v={t.counterparty} />}
          {t.note && <Row k="Ghi chú" v={t.note} />}
          {t.link && (
            <Row
              k="Chứng từ gốc"
              v={
                <Link href={t.link.href} className="text-primary">
                  🔗 {t.link.label}
                </Link>
              }
            />
          )}
        </dl>
        {!editableSource(t.source) && (
          <p className="mt-3 text-sm text-muted">
            {t.source === "TRANSFER"
              ? "Chuyển tiền nội bộ: muốn sửa thì xoá (xoá cả hai vế) rồi ghi lại."
              : t.source === "ADJUSTMENT"
                ? "Bút toán điều chỉnh khi đối soát — xoá được nếu ghi nhầm."
                : "Bút toán tự sinh — sửa số tiền, tài khoản hoặc ngày trả ở chứng từ gốc, sổ quỹ tự cập nhật."}
          </p>
        )}
      </section>
      {editableSource(t.source) && (
        <section className="card p-4" aria-labelledby="sua">
          <h2 id="sua" className="font-semibold">
            Sửa bút toán
          </h2>
          <EntryForm accounts={accs} categories={categoryOptions(cats, "ALL")} today={todayVn()} label="Sửa bút toán" entry={t} />
        </section>
      )}
      {deletableSource(t.source) && (
        <ActionForm
          action={deleteEntryAction}
          confirm={t.source === "TRANSFER" ? "Xoá cả hai vế của lần chuyển tiền này?" : "Xoá bút toán này?"}
          label="Xoá bút toán"
        >
          <input type="hidden" name="id" value={t.id} />
          <input type="hidden" name="back" value="1" />
          <Submit variant="danger">{t.source === "TRANSFER" ? "Xoá lần chuyển tiền" : "Xoá bút toán"}</Submit>
        </ActionForm>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
