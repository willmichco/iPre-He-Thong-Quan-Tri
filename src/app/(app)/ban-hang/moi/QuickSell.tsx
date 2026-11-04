"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { formatBp, formatVnd } from "@/domain/costing";
import { CHANNEL_LABEL, CHANNELS, parseVndInput, previewSale, type Channel } from "@/domain/sales";
import { createSaleAction, lookupForSaleAction, type SellableDto } from "../actions";

interface Line {
  item: SellableDto;
  price: string;
}
type Payment = "TRANSFER" | "CASH" | "DEPOSIT" | "UNPAID";
const PAYMENTS: [Payment, string][] = [
  ["TRANSFER", "Chuyển khoản"],
  ["CASH", "Tiền mặt"],
  ["DEPOSIT", "Cọc"],
  ["UNPAID", "Ghi nợ"],
];

const vnd = (n: bigint) => `${formatVnd(n)} ₫`;

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="text-muted mb-1">{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={`min-h-10 rounded-full border px-3 ${value === v ? "border-primary bg-primary text-[var(--primary-text)]" : "border-border"}`}
          >
            {l}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function MoneyInput({ label, value, onChange, error, hint }: { label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string }) {
  const parsed = value.trim() ? parseVndInput(value) : null;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted">{label}</span>
      <input
        className="field"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error || (value.trim() && parsed === null) ? true : undefined}
      />
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : value.trim() ? (
        <span className={`text-xs ${parsed === null ? "text-danger" : "text-muted"}`}>
          {parsed === null ? "Không hiểu số tiền (vd 34,5tr · 30k)" : `= ${vnd(parsed)}`}
        </span>
      ) : (
        hint && <span className="text-xs text-muted">{hint}</span>
      )}
    </label>
  );
}

export function QuickSell({ accounts, initialCode }: { accounts: { id: string; name: string }[]; initialCode?: string }) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([]);
  const [code, setCode] = useState("");
  const [scanMsg, setScanMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<Channel>("FACEBOOK");
  const [discount, setDiscount] = useState("");
  const [shipping, setShipping] = useState("");
  const [other, setOther] = useState("");
  const [payment, setPayment] = useState<Payment>("TRANSFER");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [paid, setPaid] = useState("");
  const [warranty, setWarranty] = useState("6");
  const [directShip, setDirectShip] = useState(false);
  const [confirmBelow, setConfirmBelow] = useState(false);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ error?: string; fieldErrors?: Record<string, string> }>({});
  const [pending, start] = useTransition();
  const scanRef = useRef<HTMLInputElement>(null);

  async function add(raw: string) {
    const c = raw.trim();
    if (!c) return;
    const it = await lookupForSaleAction(c);
    if (!it) return setScanMsg({ ok: false, text: `Không tìm thấy máy có Serial / IMEI "${c}"` });
    if (it.sellable === "NO") return setScanMsg({ ok: false, text: `${it.label}: ${it.reason}` });
    setLines((prev) => {
      if (prev.some((l) => l.item.id === it.id)) return prev;
      return [...prev, { item: it, price: it.targetPriceVnd ? formatVnd(BigInt(it.targetPriceVnd)) : "" }];
    });
    setScanMsg({ ok: true, text: `✓ ${it.label}${it.reason ? ` — ${it.reason}` : ""}` });
    setCode("");
    if (it.sellable === "DEPOSIT_ONLY") setPayment((p) => (p === "UNPAID" ? p : "DEPOSIT"));
  }

  // mở từ hồ sơ máy ("Bán máy này") → tự thêm máy
  const initial = useRef(initialCode);
  useEffect(() => {
    const c = initial.current;
    initial.current = undefined;
    if (c) void add(c);
    else scanRef.current?.focus();
  }, []);

  const preview = useMemo(() => {
    const parsed = lines.map((l) => ({ itemId: l.item.id, priceVnd: parseVndInput(l.price), costVnd: BigInt(l.item.costVnd) }));
    if (!parsed.length || parsed.some((p) => p.priceVnd === null)) return null;
    const exp = [parseVndInput(shipping) ?? 0n, parseVndInput(other) ?? 0n];
    return previewSale(
      parsed.map((p) => ({ ...p, priceVnd: p.priceVnd! })),
      parseVndInput(discount) ?? 0n,
      exp,
    );
  }, [lines, discount, shipping, other]);
  const needsDirect = payment !== "DEPOSIT" && lines.some((l) => !l.item.arrivedSg);
  const below = !!preview?.belowCost.length && payment !== "DEPOSIT";

  function submit() {
    setErrors({});
    start(async () => {
      const r = await createSaleAction({
        lines: lines.map((l) => ({ itemId: l.item.id, price: l.price })),
        customerPhone: phone,
        customerName: name,
        channel,
        discount,
        shippingFee: shipping,
        otherFee: other,
        payment,
        accountId,
        paidAmount: paid,
        warrantyMonths: warranty,
        directShip: directShip ? "on" : "",
        confirmBelowCost: confirmBelow ? "on" : "",
        note,
      });
      if (r.ok && r.id) router.push(`/ban-hang/${r.id}`);
      else setErrors({ error: r.error, fieldErrors: r.fieldErrors });
    });
  }
  const fe = errors.fieldErrors ?? {};

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-4" aria-label="Quét máy">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add(code);
          }}
          className="flex gap-2"
        >
          <label className="flex flex-col gap-1 text-sm grow">
            <span className="text-muted">Quét / gõ IMEI hoặc Serial</span>
            <input
              ref={scanRef}
              className="field font-mono uppercase"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="Quét hoặc gõ mã"
            />
          </label>
          <button type="submit" className="btn-secondary self-end">
            Thêm
          </button>
        </form>
        {scanMsg && (
          <p role={scanMsg.ok ? "status" : "alert"} className={`mt-2 text-sm ${scanMsg.ok ? "text-[var(--ok)]" : "text-danger"}`}>
            {scanMsg.text}
          </p>
        )}
        {fe.lines && <p className="mt-2 text-sm text-danger">{fe.lines}</p>}
      </section>

      {lines.map((l, k) => {
        const p = preview?.lines[k];
        return (
          <article key={l.item.id} className="card p-4" aria-label={`Máy ${l.item.serial ?? l.item.imei1}`}>
            <div className="flex items-start gap-2">
              <div className="grow">
                <div className="font-semibold">{l.item.label}</div>
                <div className="text-xs text-muted font-mono">
                  {l.item.serial ? `SN ${l.item.serial}` : ""} {l.item.imei1 ? `· IMEI ${l.item.imei1}` : ""}
                </div>
                <div className="text-xs text-muted">
                  {l.item.batchCode}
                  {l.item.daysInStock !== null ? ` · tồn ${l.item.daysInStock} ngày` : " · chưa về SG"}
                </div>
              </div>
              <button
                type="button"
                className="btn-danger !min-h-9 !px-2"
                aria-label="Bỏ máy khỏi đơn"
                onClick={() => setLines((x) => x.filter((_, i) => i !== k))}
              >
                ✕
              </button>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
              <dt className="text-muted">Giá vốn</dt>
              <dd className="text-right tabular-nums">
                {vnd(BigInt(l.item.costVnd))}
                {l.item.hasEstimate ? " (tạm tính)" : ""}
              </dd>
              {l.item.targetPriceVnd && (
                <>
                  <dt className="text-muted">Giá mục tiêu</dt>
                  <dd className="text-right tabular-nums">{vnd(BigInt(l.item.targetPriceVnd))}</dd>
                </>
              )}
            </dl>
            <div className="mt-2">
              <MoneyInput
                label="Giá bán *"
                value={l.price}
                onChange={(v) => setLines((x) => x.map((y, i) => (i === k ? { ...y, price: v } : y)))}
                hint="vd 34,5tr"
              />
            </div>
            {p && (
              <p className={`mt-2 text-sm font-semibold ${p.grossProfitVnd < 0n ? "text-danger" : "text-[var(--ok)]"}`} data-testid="line-profit">
                Lãi máy {p.profitVnd >= 0n ? "+" : ""}
                {vnd(p.profitVnd)} · biên {formatBp(p.marginBp)}
                {p.grossProfitVnd < 0n ? " · ⚠ dưới giá vốn" : ""}
              </p>
            )}
          </article>
        );
      })}

      <section className="card p-4 flex flex-col gap-3" aria-label="Thông tin bán">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">SĐT khách</span>
            <input
              className="field"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-invalid={fe.customerPhone ? true : undefined}
            />
            {fe.customerPhone && <span className="text-xs text-danger">{fe.customerPhone}</span>}
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Tên khách</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <Chips label="Kênh" value={channel} options={CHANNELS.map((c) => [c, CHANNEL_LABEL[c]])} onChange={setChannel} />
        <div className="grid grid-cols-3 gap-3">
          <MoneyInput label="Ship khách" value={shipping} onChange={setShipping} error={fe.shippingFee} />
          <MoneyInput label="Phí khác (COD…)" value={other} onChange={setOther} error={fe.otherFee} />
          <MoneyInput label="Giảm giá" value={discount} onChange={setDiscount} error={fe.discount} />
        </div>
        <Chips label="Thanh toán" value={payment} options={PAYMENTS} onChange={setPayment} />
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Tài khoản nhận tiền</span>
            <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-invalid={fe.accountId ? true : undefined}>
              <option value="">— chọn —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {fe.accountId && <span className="text-xs text-danger">{fe.accountId}</span>}
          </label>
          <MoneyInput
            label={payment === "DEPOSIT" ? "Tiền cọc *" : "Số tiền đã nhận"}
            value={paid}
            onChange={setPaid}
            error={fe.paidAmount}
            hint={payment === "DEPOSIT" ? undefined : payment === "UNPAID" ? "Trống = khách nợ toàn bộ" : "Trống = nhận đủ"}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Bảo hành shop (tháng)</span>
            <input className="field" inputMode="numeric" value={warranty} onChange={(e) => setWarranty(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Ghi chú</span>
            <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {needsDirect && (
          <label className="flex items-center gap-2 text-sm text-[var(--warn)]">
            <input type="checkbox" className="size-5" checked={directShip} onChange={(e) => setDirectShip(e.target.checked)} />
            Máy chưa về SG — bán giao thẳng (không qua kho)
          </label>
        )}
        {below && (
          <label className="flex items-center gap-2 text-sm text-danger">
            <input type="checkbox" className="size-5" checked={confirmBelow} onChange={(e) => setConfirmBelow(e.target.checked)} />
            Xác nhận bán dưới giá vốn
          </label>
        )}
      </section>

      <section className="card p-4 md:sticky md:bottom-4" aria-label="Kết quả">
        {preview ? (
          <dl className="grid grid-cols-2 gap-1 text-sm">
            <dt className="text-muted">Doanh thu</dt>
            <dd className="text-right tabular-nums">{vnd(preview.revenueVnd)}</dd>
            <dt className="text-muted">Giá vốn</dt>
            <dd className="text-right tabular-nums">{vnd(preview.costVnd)}</dd>
            <dt className="font-semibold">LÃI {lines.length > 1 ? "ĐƠN" : "MÁY"}</dt>
            <dd
              className={`text-right text-lg font-bold tabular-nums ${preview.profitVnd < 0n ? "text-danger" : "text-[var(--ok)]"}`}
              data-testid="sale-profit"
            >
              {preview.profitVnd >= 0n ? "+" : ""}
              {vnd(preview.profitVnd)}
            </dd>
            <dt className="text-muted">Biên lãi</dt>
            <dd className="text-right">{formatBp(preview.marginBp)}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted">{lines.length ? "Nhập giá bán để xem lãi" : "Quét máy để bắt đầu"}</p>
        )}
        {errors.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {errors.error}
          </p>
        )}
        <button type="button" className="btn-primary mt-3 w-full" disabled={pending || !lines.length} onClick={submit}>
          {pending ? "Đang lưu…" : payment === "DEPOSIT" ? "XÁC NHẬN NHẬN CỌC" : "XÁC NHẬN BÁN"}
        </button>
      </section>
    </div>
  );
}
