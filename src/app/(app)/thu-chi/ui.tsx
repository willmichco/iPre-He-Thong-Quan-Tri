/**
 * Thành phần dùng chung của Thu chi: form bút toán nhập tay, chuyển tiền, biểu đồ dòng tiền tuần, bảng sổ quỹ.
 * Chạy phía máy chủ; form là ActionForm (thành phần trình duyệt) → lỗi hiện ngay dưới từng ô.
 */
import Link from "next/link";
import { formatVnd } from "@/domain/costing";
import { formatAmount, SOURCE_LABEL, type WeekFlow } from "@/domain/ledger";
import { shortVnd } from "@/domain/overview";
import type { CategoryRow, LedgerRow } from "@/server/ledger/service";
import { ActionForm, Input, Select, Submit } from "../_components/form";
import { saveEntryAction, transferAction } from "./actions";
import { Glyph } from "../_components/Glyph";

export type AccountOpt = { id: string; name: string; currency: "VND" | "USD" };

const accountOptions = (accounts: readonly AccountOpt[]) => accounts.map((a) => [a.id, `${a.name}${a.currency === "USD" ? " (USD)" : ""}`] as const);

/** Danh mục cho nhập tay; `group` lọc nhóm: vận hành & thu khác / vốn & thuế. */
export function categoryOptions(cats: readonly CategoryRow[], group: "OPERATING" | "CAPITAL" | "ALL") {
  const capital = (c: CategoryRow) => c.code === "CAPITAL_IN" || c.code === "CAPITAL_OUT" || c.code === "TAX";
  return cats
    .filter((c) => c.manual && (group === "ALL" || (group === "CAPITAL" ? capital(c) : !capital(c))))
    .sort((a, b) => (a.direction === b.direction ? a.name.localeCompare(b.name, "vi") : a.direction === "OUT" ? -1 : 1))
    .map((c) => [c.code, `${c.direction === "IN" ? "Thu" : "Chi"} · ${c.name}`] as const);
}

export function EntryForm({
  accounts,
  categories,
  today,
  label,
  entry,
}: {
  accounts: readonly AccountOpt[];
  categories: readonly (readonly [string, string])[];
  today: string;
  label: string;
  entry?: LedgerRow;
}) {
  const hasUsd = accounts.some((a) => a.currency === "USD");
  return (
    <ActionForm action={saveEntryAction} resetOnSuccess={!entry} label={label} className="field-row mt-3">
      {entry && <input type="hidden" name="id" value={entry.id} />}
      <Select label="Danh mục *" name="categoryCode" options={categories} defaultValue={entry?.categoryCode} className="grow min-w-48" />
      <Select label="Tài khoản *" name="accountId" options={accountOptions(accounts)} defaultValue={entry?.accountId} className="min-w-40" />
      <Input
        label="Số tiền *"
        name="amount"
        inputMode="decimal"
        placeholder="2tr · 500k"
        defaultValue={entry ? (entry.currency === "VND" ? (entry.amountCents / 100n).toString() : (Number(entry.amountCents) / 100).toFixed(2)) : ""}
        className="w-36"
      />
      <Input label="Ngày *" name="occurredAt" type="date" defaultValue={entry?.date ?? today} className="w-40" />
      {hasUsd && <Input label="Tỷ giá (TK USD)" name="fxRate" inputMode="decimal" placeholder="26.350" className="w-32" />}
      <Input label="Đối tượng" name="counterparty" defaultValue={entry?.counterparty ?? ""} placeholder="Facebook, chủ nhà…" className="min-w-40" />
      <Input label="Ghi chú" name="note" defaultValue={entry?.note ?? ""} className="grow min-w-48" />
      <Submit>{entry ? "Lưu" : "Ghi sổ"}</Submit>
    </ActionForm>
  );
}

export function TransferForm({ accounts, today }: { accounts: readonly AccountOpt[]; today: string }) {
  const opts = accountOptions(accounts);
  const hasUsd = accounts.some((a) => a.currency === "USD");
  return (
    <ActionForm action={transferAction} resetOnSuccess label="Chuyển tiền" className="field-row mt-3">
      <Select label="Từ tài khoản *" name="fromAccountId" options={opts} className="min-w-40" />
      <Select label="Sang tài khoản *" name="toAccountId" options={opts} defaultValue={opts[1]?.[0]} className="min-w-40" />
      <Input label="Số chuyển *" name="amountFrom" inputMode="decimal" placeholder="10tr" className="w-36" />
      {hasUsd && <Input label="Số nhận (đổi ngoại tệ)" name="amountTo" inputMode="decimal" hint="Khi khác tiền tệ" className="w-40" />}
      {hasUsd && <Input label="Tỷ giá (USD ↔ USD)" name="fxRate" inputMode="decimal" className="w-32" />}
      <Input label="Ngày *" name="occurredAt" type="date" defaultValue={today} className="w-40" />
      <Input label="Ghi chú" name="note" className="grow min-w-40" />
      <Submit>Chuyển</Submit>
    </ActionForm>
  );
}

/** Cột đôi thu (xanh) / chi (cam) theo tuần — có bảng số đi kèm. */
export function CashflowBars({ weeks }: { weeks: readonly WeekFlow[] }) {
  const W = 360;
  const H = 150;
  const top = 14;
  const bottom = 22;
  const plotH = H - top - bottom;
  const max = weeks.reduce((m, w) => (w.inVnd > m ? w.inVnd : w.outVnd > m ? w.outVnd : m), 0n);
  const slot = W / weeks.length;
  const barW = Math.max(4, (slot - 6) / 2);
  const h = (v: bigint) => (max === 0n ? 0 : (Number(v) / Number(max)) * plotH);
  const totIn = weeks.reduce((s, w) => s + w.inVnd, 0n);
  const totOut = weeks.reduce((s, w) => s + w.outVnd, 0n);
  return (
    <figure className="card p-4" data-testid="cashflow-chart">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">Dòng tiền {weeks.length} tuần</span>
        <span className="flex gap-3 text-xs text-muted">
          <span>
            <span className="inline-block size-2.5 rounded-sm bg-[var(--ok)] align-middle" /> Thu {shortVnd(totIn)}
          </span>
          <span>
            <span className="inline-block size-2.5 rounded-sm bg-[var(--warn)] align-middle" /> Chi {shortVnd(totOut)}
          </span>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full h-auto" role="img" aria-label={`Dòng tiền vào và ra ${weeks.length} tuần gần nhất`}>
        <line x1={0} x2={W} y1={top + plotH} y2={top + plotH} stroke="var(--border)" strokeWidth={1} />
        {weeks.map((w, k) => {
          const x = k * slot + (slot - barW * 2 - 2) / 2;
          return (
            <g key={w.week}>
              <title>{`Tuần ${w.label}: thu ${formatVnd(w.inVnd)} ₫ · chi ${formatVnd(w.outVnd)} ₫`}</title>
              <rect x={k * slot} y={0} width={slot} height={H - bottom + 4} fill="transparent" />
              {w.inVnd > 0n && <rect x={x} y={top + plotH - h(w.inVnd)} width={barW} height={Math.max(h(w.inVnd), 1)} rx={2} fill="var(--ok)" />}
              {w.outVnd > 0n && (
                <rect x={x + barW + 2} y={top + plotH - h(w.outVnd)} width={barW} height={Math.max(h(w.outVnd), 1)} rx={2} fill="var(--warn)" />
              )}
              {(weeks.length - 1 - k) % 3 === 0 && (
                <text x={k * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {w.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted">Xem bảng số</summary>
        <table className="mt-1 w-full tabular-nums" aria-label="Dòng tiền theo tuần">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 font-normal">Tuần từ</th>
              <th className="py-1 text-right font-normal">Thu</th>
              <th className="py-1 text-right font-normal">Chi</th>
              <th className="py-1 text-right font-normal">Ròng</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week} className="border-t border-border">
                <td className="py-1">{w.label}</td>
                <td className="py-1 text-right">{formatVnd(w.inVnd)}</td>
                <td className="py-1 text-right">{formatVnd(w.outVnd)}</td>
                <td className={`py-1 text-right ${w.inVnd < w.outVnd ? "text-danger" : ""}`}>{formatVnd(w.inVnd - w.outVnd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** Bảng sổ quỹ. `balances` (tuỳ chọn) = số dư sau từng dòng, dùng cho sổ của một tài khoản. */
export function LedgerTable({
  rows,
  showAccount = true,
  balances,
}: {
  rows: readonly (LedgerRow & { balanceCents?: bigint })[];
  showAccount?: boolean;
  balances?: boolean;
}) {
  return (
    <>
      {/* điện thoại: thẻ xếp dọc — không cuộn ngang */}
      <ul className="flex flex-col gap-2 md:hidden" aria-label="Sổ quỹ (dạng thẻ)">
        {rows.map((r) => (
          <li key={r.id}>
            <Link href={`/thu-chi/${r.id}`} className="card block p-3" data-source={r.source}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{r.category}</span>
                <span className={`whitespace-nowrap font-semibold tabular-nums ${r.direction === "IN" ? "text-[var(--ok)]" : ""}`}>
                  {r.direction === "IN" ? "+" : "−"}
                  {formatAmount(r.amountCents, r.currency)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {dmy(r.date)}
                {showAccount && ` · ${r.account}`}
                {r.link && ` · ${r.link.label}`}
                {balances && ` · số dư ${formatAmount(r.balanceCents ?? 0n, r.currency)}`}
              </p>
              {(r.counterparty || r.note) && <p className="mt-0.5 truncate text-xs text-muted">{[r.counterparty, r.note].filter(Boolean).join(" · ")}</p>}
            </Link>
          </li>
        ))}
      </ul>
      <div className="card hidden overflow-x-auto md:block">
        <table className="w-full text-sm" aria-label="Sổ quỹ">
          <thead className="text-left text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Ngày</th>
              {showAccount && <th className="px-3 py-2 font-normal">Tài khoản</th>}
              <th className="px-3 py-2 font-normal">Danh mục</th>
              <th className="px-3 py-2 font-normal">Nội dung</th>
              <th className="px-3 py-2 text-right font-normal">Thu</th>
              <th className="px-3 py-2 text-right font-normal">Chi</th>
              {balances && <th className="px-3 py-2 text-right font-normal">Số dư</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const amt = formatAmount(r.amountCents, r.currency);
              return (
                <tr key={r.id} className="border-t border-border align-top" data-source={r.source}>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    <Link href={`/thu-chi/${r.id}`} className="underline decoration-dotted underline-offset-2">
                      {dmy(r.date)}
                    </Link>
                  </td>
                  {showAccount && <td className="whitespace-nowrap px-3 py-2">{r.account}</td>}
                  <td className="px-3 py-2">
                    {r.category}
                    {r.isOperating && <span className="ml-1 text-xs text-muted">(vận hành)</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.link ? (
                      <Link
                        href={r.link.href}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        title={`Tự sinh từ ${SOURCE_LABEL[r.source]}`}
                      >
                        <Glyph name="link" size={14} className="shrink-0" />
                        {r.link.label}
                      </Link>
                    ) : (
                      r.source !== "MANUAL" && <span className="text-xs text-muted">{SOURCE_LABEL[r.source]}</span>
                    )}
                    {(r.counterparty || r.note) && <span className="block text-xs text-muted">{[r.counterparty, r.note].filter(Boolean).join(" · ")}</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[var(--ok)]">{r.direction === "IN" ? amt : ""}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{r.direction === "OUT" ? amt : ""}</td>
                  {balances && (
                    <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${(r.balanceCents ?? 0n) < 0n ? "text-danger" : ""}`}>
                      {formatAmount(r.balanceCents ?? 0n, r.currency)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
