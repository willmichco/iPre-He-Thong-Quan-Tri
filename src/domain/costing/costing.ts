/**
 * Bộ máy tính giá vốn (costing engine) — tài liệu 01 mục 5–6, tài liệu 04 mục 3.
 *
 * Hàm thuần: nhận dữ liệu của một (hoặc nhiều) chuyến, trả về các dòng phân bổ — đúng dạng bảng
 * `item_cost_allocations` (mỗi dòng = 1 thành phần giá vốn của 1 máy). Service ghi lại toàn bộ trong cùng
 * transaction mỗi khi đơn mua, máy, kiện, chi phí hoặc tỷ giá thay đổi.
 *
 * Nguyên tắc tiền tệ: mọi số tiền VND là bigint; quy đổi bằng tỷ giá THỰC TẾ của từng đơn mua / từng khoản
 * chi phí; làm tròn như PostgreSQL. Tổng phân bổ luôn khớp tuyệt đối với tổng chi phí.
 */
import { allocate } from "./allocation";
import { CostingError } from "./errors";
import { divRound, parseScaled, type Vnd } from "./money";

/** Thành phần giá vốn sinh từ đơn mua. */
export type PurchaseComponent = "PRICE" | "SALES_TAX" | "SELLER_SHIPPING" | "DISCOUNT" | "PO_FX_FEE";
/** Loại chi phí trong bảng `costs` (enum cost_kind) — cũng là tên thành phần giá vốn. */
export type CostKind =
  | "US_DOMESTIC_SHIPPING"
  | "INTL_SHIPPING"
  | "DOMESTIC_SHIPPING"
  | "INSURANCE"
  | "CUSTOMS_TAX"
  | "FX_FEE"
  | "HANDLING"
  | "OTHER_LANDED";
export type Component = PurchaseComponent | CostKind;
export type AllocationMethod = "BY_QUANTITY" | "BY_VALUE" | "BY_WEIGHT" | "MANUAL";

export interface PurchaseOrderInput {
  id: string;
  /** tỷ giá THỰC TẾ đã trả (numeric 12,4) */
  fxRate: string | number;
  salesTax?: string | number;
  sellerShipping?: string | number;
  /** coupon, gift card, cashback — số dương, engine ghi thành phần DISCOUNT mang giá trị âm */
  discount?: string | number;
  /** phí chuyển đổi ngoại tệ của ngân hàng (VND) */
  fxFeeVnd?: Vnd;
}

export interface ItemInput {
  id: string;
  batchId: string;
  purchaseOrderId: string;
  /** đơn giá theo tiền tệ của đơn mua (numeric 14,2) */
  unitPrice: string | number;
  /** cân nặng (kg) — đã lấy mặc định của cấu hình máy nếu máy chưa có; chỉ bắt buộc khi có chi phí theo cân nặng */
  weightKg?: string | number | null;
  /**
   * Máy KHÔNG nhận chi phí chung (B–E) gắn vào chuyến/đơn mua/kiện — vd. đã trả người bán. Vẫn giữ các thành
   * phần của đơn mua và chi phí gắn thẳng vào chính máy đó; khoản hoàn tiền ghi bằng chi phí âm hoặc giảm giá.
   */
  excludedFromCosts?: boolean;
}

export interface ShipmentInput {
  id: string;
  itemIds: string[];
}

export type CostTarget =
  | { type: "BATCH"; id: string }
  | { type: "PURCHASE_ORDER"; id: string }
  | { type: "SHIPMENT"; id: string }
  | { type: "ITEM"; id: string };

export interface CostInput {
  id: string;
  kind: CostKind;
  target: CostTarget;
  /** round(amount × fx_rate) — dùng toVnd(); âm = hoàn phí / điều chỉnh giảm */
  amountVnd: Vnd;
  method: AllocationMethod;
  /** dự toán (chưa có hoá đơn) → lãi của máy hiển thị "Tạm tính" */
  isEstimate?: boolean;
  /** bắt buộc khi method = MANUAL: số tiền từng máy, cộng đúng bằng amountVnd */
  manualShares?: { itemId: string; amountVnd: Vnd }[];
}

export interface CostingInput {
  purchaseOrders: PurchaseOrderInput[];
  items: ItemInput[];
  shipments?: ShipmentInput[];
  costs?: CostInput[];
}

export interface Allocation {
  itemId: string;
  component: Component;
  /** null với thành phần từ đơn mua */
  costId: string | null;
  amountVnd: Vnd;
  isEstimate: boolean;
}

export interface CostingWarning {
  code: "PO_WITHOUT_ITEMS";
  message: string;
  refs: string[];
}

export interface CostingResult {
  allocations: Allocation[];
  warnings: CostingWarning[];
}

const sum = (xs: readonly bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** round(cents × fxRate) với cents ở scale 2, fxRate ở scale 4. */
function centsToVnd(cents: bigint, fx4: bigint): Vnd {
  return divRound(cents * fx4, 10n ** 6n);
}

export function computeAllocations(input: CostingInput): CostingResult {
  const out: Allocation[] = [];
  const warnings: CostingWarning[] = [];
  const itemsById = new Map(input.items.map((i) => [i.id, i]));
  /** giá mua quy đổi (VND) của từng máy = Σ thành phần từ đơn mua — trọng số "theo giá trị" */
  const purchaseVnd = new Map<string, Vnd>(input.items.map((i) => [i.id, 0n]));
  const push = (itemId: string, component: Component, amountVnd: Vnd, costId: string | null = null, isEstimate = false) => {
    if (amountVnd === 0n) return;
    out.push({ itemId, component, costId, amountVnd, isEstimate });
  };

  // ---- 1. Đơn mua → PRICE, SALES_TAX, SELLER_SHIPPING, DISCOUNT, PO_FX_FEE ---------------------------
  const poIds = new Set(input.purchaseOrders.map((p) => p.id));
  for (const it of input.items) {
    if (!poIds.has(it.purchaseOrderId))
      throw new CostingError("UNKNOWN_PURCHASE_ORDER", `Máy ${it.id} thuộc đơn mua không có trong dữ liệu tính`, [it.id]);
  }
  for (const po of input.purchaseOrders) {
    const items = input.items.filter((i) => i.purchaseOrderId === po.id);
    const fx = parseScaled(po.fxRate, 4);
    const tax = parseScaled(po.salesTax ?? 0, 2);
    const ship = parseScaled(po.sellerShipping ?? 0, 2);
    const disc = parseScaled(po.discount ?? 0, 2);
    const fee = po.fxFeeVnd ?? 0n;
    if (!items.length) {
      if (tax || ship || disc || fee)
        warnings.push({
          code: "PO_WITHOUT_ITEMS",
          message: `Đơn mua ${po.id} có thuế/phí/giảm giá nhưng chưa có máy nào — chưa phân bổ được`,
          refs: [po.id],
        });
      continue;
    }
    const prices = items.map((i) => parseScaled(i.unitPrice, 2));
    const goods = sum(prices);
    // Làm tròn LUỸ KẾ: mỗi thành phần = round(luỹ kế đến nó) − round(luỹ kế trước nó) → tổng các thành phần
    // bằng đúng round((Σ đơn giá + thuế + ship − giảm giá) × tỷ giá) như cột total_vnd của CSDL.
    const c0 = centsToVnd(goods, fx);
    const c1 = centsToVnd(goods + tax, fx);
    const c2 = centsToVnd(goods + tax + ship, fx);
    const c3 = centsToVnd(goods + tax + ship - disc, fx);
    const priceShares = goods > 0n ? allocate(c0, prices) : items.map(() => 0n);
    // thuế, ship người bán, giảm giá, phí ngoại tệ: theo giá trị (giá mua VND). Giá VND làm tròn về 0 (giá cực
    // nhỏ) → theo đơn giá gốc; đơn toàn máy 0 đồng (quà tặng kèm) → theo số lượng.
    const valueW = sum(priceShares) > 0n ? priceShares : goods > 0n ? prices : items.map(() => 1n);
    const parts: [PurchaseComponent, Vnd[]][] = [
      ["PRICE", priceShares],
      ["SALES_TAX", allocate(c1 - c0, valueW)],
      ["SELLER_SHIPPING", allocate(c2 - c1, valueW)],
      ["DISCOUNT", allocate(c3 - c2, valueW)],
      ["PO_FX_FEE", allocate(fee, valueW)],
    ];
    for (const [component, shares] of parts) {
      items.forEach((it, k) => {
        push(it.id, component, shares[k]);
        purchaseVnd.set(it.id, purchaseVnd.get(it.id)! + shares[k]);
      });
    }
  }

  // ---- 2. Chi phí (bảng costs) → phân bổ cho các máy thuộc đối tượng được gắn ------------------------
  const shipments = new Map((input.shipments ?? []).map((s) => [s.id, s]));
  for (const cost of input.costs ?? []) {
    // máy bị loại (trả người bán…) không gánh chi phí chung; chi phí gắn THẲNG vào máy đó thì vẫn tính cho nó
    const resolved = resolveTargets(cost, input.items, itemsById, shipments);
    const targets = cost.target.type === "ITEM" ? resolved : resolved.filter((i) => !i.excludedFromCosts);
    if (!targets.length)
      throw new CostingError("NO_TARGET_ITEMS", `Chi phí ${cost.id} gắn vào đối tượng chưa có máy nào để phân bổ`, [cost.id]);
    const shares = cost.method === "MANUAL" ? manualShares(cost, targets) : allocate(cost.amountVnd, weightsFor(cost, targets, purchaseVnd));
    targets.forEach((it, k) => push(it.id, cost.kind, shares[k], cost.id, cost.isEstimate ?? false));
  }

  return { allocations: out, warnings };
}

function resolveTargets(
  cost: CostInput,
  items: ItemInput[],
  itemsById: Map<string, ItemInput>,
  shipments: Map<string, ShipmentInput>,
): ItemInput[] {
  const t = cost.target;
  switch (t.type) {
    case "BATCH":
      return items.filter((i) => i.batchId === t.id);
    case "PURCHASE_ORDER":
      return items.filter((i) => i.purchaseOrderId === t.id);
    case "ITEM": {
      const it = itemsById.get(t.id);
      if (!it) throw new CostingError("UNKNOWN_ITEM", `Chi phí ${cost.id} gắn vào máy không có trong dữ liệu tính`, [cost.id, t.id]);
      return [it];
    }
    case "SHIPMENT": {
      const s = shipments.get(t.id);
      if (!s) throw new CostingError("UNKNOWN_SHIPMENT", `Chi phí ${cost.id} gắn vào kiện không có trong dữ liệu tính`, [cost.id, t.id]);
      const missing = s.itemIds.filter((id) => !itemsById.has(id));
      if (missing.length)
        throw new CostingError(
          "UNKNOWN_ITEM",
          `Kiện ${s.id} có máy không nằm trong dữ liệu tính (kiện gom nhiều chuyến phải tính cùng lúc các chuyến đó)`,
          [s.id, ...missing],
        );
      return s.itemIds.map((id) => itemsById.get(id)!);
    }
  }
}

function weightsFor(cost: CostInput, targets: ItemInput[], purchaseVnd: Map<string, Vnd>): bigint[] {
  switch (cost.method) {
    case "BY_QUANTITY":
      return targets.map(() => 1n);
    case "BY_VALUE": {
      const w = targets.map((i) => purchaseVnd.get(i.id) ?? 0n);
      if (w.some((x) => x < 0n) || sum(w) === 0n)
        throw new CostingError(
          "ZERO_WEIGHT",
          `Chi phí ${cost.id} phân bổ theo giá trị nhưng các máy chưa có giá mua — chọn "theo số lượng" hoặc nhập giá mua`,
          [cost.id],
        );
      return w;
    }
    case "BY_WEIGHT": {
      const missing = targets.filter((i) => i.weightKg === null || i.weightKg === undefined || i.weightKg === "");
      if (missing.length)
        throw new CostingError(
          "MISSING_WEIGHT",
          `Chi phí ${cost.id} phân bổ theo cân nặng nhưng ${missing.length} máy chưa có cân nặng — nhập cân nặng máy hoặc mặc định của cấu hình`,
          [cost.id, ...missing.map((i) => i.id)],
        );
      return targets.map((i) => parseScaled(i.weightKg!, 3));
    }
    case "MANUAL":
      throw new Error("unreachable");
  }
}

function manualShares(cost: CostInput, targets: ItemInput[]): bigint[] {
  const given = new Map((cost.manualShares ?? []).map((s) => [s.itemId, s.amountVnd]));
  const outside = [...given.keys()].filter((id) => !targets.some((t) => t.id === id));
  if (outside.length)
    throw new CostingError("MANUAL_SHARE_OUTSIDE_TARGET", `Chi phí ${cost.id}: có số tiền nhập tay cho máy không thuộc đối tượng được gắn`, [
      cost.id,
      ...outside,
    ]);
  const shares = targets.map((t) => given.get(t.id) ?? 0n);
  const total = sum(shares);
  if (total !== cost.amountVnd)
    throw new CostingError(
      "MANUAL_SHARES_MISMATCH",
      `Chi phí ${cost.id}: tổng nhập tay ${total} đ khác số tiền chi phí ${cost.amountVnd} đ (lệch ${cost.amountVnd - total} đ)`,
      [cost.id],
    );
  return shares;
}

// ---- Tổng hợp giá vốn từng máy — cùng cách nhóm với view v_item_landed_cost ---------------------------

export interface ItemCost {
  itemId: string;
  /** A. Giá mua quy đổi (đơn giá, thuế, ship người bán, giảm giá, phí ngoại tệ của đơn) */
  purchaseVnd: Vnd;
  /** B. Nội địa Mỹ */
  usDomesticVnd: Vnd;
  /** C. Mỹ → VN (cước, bảo hiểm/phụ thu, thuế thông quan) */
  internationalVnd: Vnd;
  /** D. HN → SG */
  hnSgVnd: Vnd;
  /** E. Khác (phí ngoại tệ riêng, kiểm hàng, lưu kho…) */
  otherVnd: Vnd;
  /** Giá vốn về tay */
  landedCostVnd: Vnd;
  /** còn khoản dự toán → lãi chỉ là "Tạm tính" */
  hasEstimate: boolean;
}

const GROUP: Record<Component, keyof Omit<ItemCost, "itemId" | "landedCostVnd" | "hasEstimate">> = {
  PRICE: "purchaseVnd",
  SALES_TAX: "purchaseVnd",
  SELLER_SHIPPING: "purchaseVnd",
  DISCOUNT: "purchaseVnd",
  PO_FX_FEE: "purchaseVnd",
  US_DOMESTIC_SHIPPING: "usDomesticVnd",
  INTL_SHIPPING: "internationalVnd",
  INSURANCE: "internationalVnd",
  CUSTOMS_TAX: "internationalVnd",
  DOMESTIC_SHIPPING: "hnSgVnd",
  FX_FEE: "otherVnd",
  HANDLING: "otherVnd",
  OTHER_LANDED: "otherVnd",
};

/** Giá vốn từng máy (kể cả máy chưa có dòng phân bổ nào → 0) theo thứ tự `itemIds`. */
export function summarizeItemCosts(allocations: readonly Allocation[], itemIds: readonly string[]): ItemCost[] {
  const map = new Map<string, ItemCost>(
    itemIds.map((id) => [
      id,
      { itemId: id, purchaseVnd: 0n, usDomesticVnd: 0n, internationalVnd: 0n, hnSgVnd: 0n, otherVnd: 0n, landedCostVnd: 0n, hasEstimate: false },
    ]),
  );
  for (const a of allocations) {
    const c = map.get(a.itemId);
    if (!c) continue;
    c[GROUP[a.component]] += a.amountVnd;
    c.landedCostVnd += a.amountVnd;
    c.hasEstimate ||= a.isEstimate;
  }
  return itemIds.map((id) => map.get(id)!);
}
