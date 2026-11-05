import type { CostKind } from "@/domain/costing";
import { COST_KIND_LABEL, COST_KINDS, DEFAULT_METHOD, METHOD_LABEL, METHODS } from "@/domain/costs";
import type { CostRow } from "@/server/costs/service";
import { deleteCostAction, saveCostAction } from "./cost-actions";
import { ActionForm, Checkbox, Input, Select, Submit, Textarea } from "./form";

type Opt = readonly (readonly [string, string])[];

const vnd = (n: bigint) => `${n < 0n ? "−" : ""}${(n < 0n ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`;
const todayVn = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
const num = (s: string) => Number(s).toLocaleString("vi-VN", { maximumFractionDigits: 4 });

function CostFields({ targets, kinds, accounts, c, defaultTarget }: { targets: Opt; kinds: CostKind[]; accounts: Opt; c?: CostRow; defaultTarget?: string }) {
  const kindOptions = kinds.map((k) => [k, COST_KIND_LABEL[k]] as const);
  const methodOptions = [["", "Mặc định theo loại"] as const, ...METHODS.map((m) => [m, METHOD_LABEL[m]] as const)];
  return (
    <>
      <Select label="Loại chi phí *" name="kind" options={kindOptions} defaultValue={c?.kind ?? kinds[0]} className="min-w-52" />
      <Select label="Gắn vào *" name="target" options={targets} defaultValue={c ? `${c.targetType}:${c.targetId}` : defaultTarget} className="min-w-52" />
      <Select
        label="Tiền tệ"
        name="currency"
        options={[
          ["VND", "VND"],
          ["USD", "USD"],
        ]}
        defaultValue={c?.currency ?? "VND"}
      />
      <Input
        label="Số tiền *"
        name="amount"
        inputMode="decimal"
        defaultValue={c ? num(c.amount) : ""}
        placeholder="684.000"
        hint="âm = hoàn phí"
        className="w-36"
      />
      <Input
        label="Tỷ giá (nếu USD)"
        name="fxRate"
        inputMode="decimal"
        defaultValue={c && c.currency === "USD" ? num(c.fxRate) : ""}
        placeholder="26.400"
        className="w-32"
      />
      <Select label="Cách chia" name="method" options={methodOptions} defaultValue={c?.method ?? ""} className="min-w-44" />
      <Input label="Ngày phát sinh *" name="incurredAt" type="date" defaultValue={c?.incurredAt ?? todayVn()} className="w-40" />
      <Input label="Mô tả" name="description" defaultValue={c?.description ?? ""} placeholder="vd: Cước 1,8 kg × 380.000đ" className="grow min-w-56" />
      <Checkbox label="Dự toán (chưa có hoá đơn)" name="isEstimate" defaultChecked={c?.isEstimate} />
      <Checkbox label="Có chứng từ hợp lệ" name="hasValidInvoice" defaultChecked={c?.hasValidInvoice} />
      <Select label="Trả từ tài khoản" name="accountId" options={accounts} defaultValue={c?.accountId ?? ""} className="min-w-44" />
      <Input label="Ngày trả" name="paidAt" type="date" defaultValue={c?.paidAt ?? ""} className="w-40" hint="Trống = chưa trả (công nợ)" />
      <Textarea
        label="Chia tay từng máy (khi chọn “Nhập tay từng máy”)"
        name="manualShares"
        rows={2}
        defaultValue={c?.manualShares ?? ""}
        placeholder={"F2LXQ7Y9KD: 250.000\n350000000000006: 434.000"}
        className="basis-full font-mono"
      />
      <Input label="Ghi chú" name="note" defaultValue={c?.note ?? ""} className="basis-full" />
    </>
  );
}

/** Danh sách + form thêm / sửa / xoá chi phí. Dùng ở trang chuyến và trang kiện. */
export function CostSection({
  costs,
  targets,
  accounts,
  kinds = COST_KINDS,
  defaultTarget,
  title = "Chi phí",
}: {
  costs: CostRow[];
  targets: Opt;
  accounts: Opt;
  kinds?: CostKind[];
  defaultTarget?: string;
  title?: string;
}) {
  const ordered = [...kinds, ...COST_KINDS.filter((k) => !kinds.includes(k))];
  const total = costs.reduce((a, c) => a + c.amountVnd, 0n);
  return (
    <section className="mt-8" aria-labelledby="chi-phi">
      <h2 id="chi-phi" className="text-lg font-semibold">
        {title}{" "}
        <span className="text-sm font-normal text-muted">
          · {costs.length} khoản · {vnd(total)}
        </span>
      </h2>
      {costs.length > 0 && (
        <div className="card mt-2 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Danh sách chi phí">
            <thead className="text-left text-muted">
              <tr>
                <th className="p-2 font-medium">Loại · mô tả</th>
                <th className="p-2 font-medium">Gắn vào</th>
                <th className="p-2 font-medium text-right">Số tiền</th>
                <th className="p-2 font-medium">Cách chia</th>
                <th className="p-2 font-medium">Đã phân bổ</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => (
                <tr key={c.id} className="border-t border-border align-top" aria-label={`${COST_KIND_LABEL[c.kind]} ${c.description ?? ""}`.trim()}>
                  <td className="p-2">
                    <div>{COST_KIND_LABEL[c.kind]}</div>
                    {c.description && <div className="text-xs text-muted">{c.description}</div>}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.isEstimate && <span className="chip !font-sans border-[var(--warn)] text-[var(--warn)]">dự toán</span>}
                      {!c.paidAt && <span className="chip !font-sans">chưa trả</span>}
                      {c.hasValidInvoice && <span className="chip !font-sans">có chứng từ</span>}
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted">Sửa / xoá</summary>
                      <ActionForm action={saveCostAction} label={`Sửa chi phí ${COST_KIND_LABEL[c.kind]}`} className="mt-2 field-row">
                        <input type="hidden" name="id" value={c.id} />
                        <CostFields targets={targets} kinds={ordered} accounts={accounts} c={c} />
                        <Submit variant="secondary">Lưu chi phí</Submit>
                      </ActionForm>
                      <ActionForm
                        action={deleteCostAction}
                        confirm="Xoá khoản chi phí này? Giá vốn sẽ tính lại."
                        label={`Xoá chi phí ${COST_KIND_LABEL[c.kind]}`}
                      >
                        <input type="hidden" name="id" value={c.id} />
                        <Submit variant="danger">Xoá chi phí</Submit>
                      </ActionForm>
                    </details>
                  </td>
                  <td className="p-2">{c.targetLabel}</td>
                  <td className="p-2 text-right tabular-nums whitespace-nowrap">
                    {vnd(c.amountVnd)}
                    {c.currency === "USD" && (
                      <div className="text-xs text-muted">
                        ${num(c.amount)} × {num(c.fxRate)}
                      </div>
                    )}
                  </td>
                  <td className="p-2">{METHOD_LABEL[c.method]}</td>
                  <td className="p-2 whitespace-nowrap">
                    {c.allocatedVnd === c.amountVnd ? (
                      <span className="text-[var(--ok)]">✓ {c.allocatedItems} máy</span>
                    ) : (
                      <span className="text-danger">lệch {vnd(c.amountVnd - c.allocatedVnd)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="card mt-3 p-4">
        <summary className="cursor-pointer font-semibold">+ Thêm chi phí</summary>
        <p className="mt-1 text-xs text-muted">
          Cách chia mặc định: ship nội địa, HN→SG: {METHOD_LABEL[DEFAULT_METHOD.DOMESTIC_SHIPPING].toLowerCase()} · cước Mỹ→VN:{" "}
          {METHOD_LABEL[DEFAULT_METHOD.INTL_SHIPPING].toLowerCase()} · bảo hiểm, thuế: {METHOD_LABEL[DEFAULT_METHOD.INSURANCE].toLowerCase()}. Lưu xong giá vốn
          tự tính lại.
        </p>
        <ActionForm action={saveCostAction} resetOnSuccess label="Thêm chi phí" className="mt-3 field-row">
          <CostFields targets={targets} kinds={ordered} accounts={accounts} defaultTarget={defaultTarget} />
          <Submit>Thêm chi phí</Submit>
        </ActionForm>
      </details>
    </section>
  );
}
