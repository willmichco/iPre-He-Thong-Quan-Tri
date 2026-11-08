/**
 * Chat demo (bản xem thử tĩnh) — điều phối hội thoại trong trình duyệt, cùng luật với `handleMessage` / `handleEvent`
 * (src/server/assistant/handle.ts): đọc câu → hỏi đáp (câu trả lời dựng sẵn lúc chụp) hoặc lập phiếu (dựng tại chỗ);
 * "ok" / "huỷ" / "để sau" / "sửa …" / "chọn 2". Không ghi gì — Xác nhận chỉ giải thích bản chạy thật sẽ ghi gì.
 */
import { demoKey, demoPeriodOf, demoSubject, PERIOD_INTENTS, type DemoPack } from "@/domain/assistant/demo";
import { metaOf } from "@/domain/assistant/dialog";
import { draftFromSlots, mergeSlots, type Choice, type Draft } from "@/domain/assistant/drafts";
import { extractSlots, type Slots } from "@/domain/assistant/extract";
import { fallbackReply, helpReply } from "@/domain/assistant/examples";
import { isWriteIntent, type Intent } from "@/domain/assistant/intents";
import { shortVnd } from "@/domain/assistant/money";
import { fold } from "@/domain/assistant/normalize";
import { hasEditableSlots, parseMessage, type ParseCtx } from "@/domain/assistant/parse";
import type { ActionStatus, AssistantEvent, Chip, PreviewCard, Reply } from "@/domain/assistant/reply";
import { demoPreview, type DemoBuilt } from "./preview";

const NOTE = "(Bản xem thử: dữ liệu mẫu, không lưu gì.)";
const ALT_LABEL: Record<string, string> = { STOCK: "Tồn kho", REVENUE: "Doanh thu", DEBT: "Công nợ", SHIPMENTS: "Kiện đang đi", RECENT_SALES: "Đơn bán gần đây", BALANCE: "Số dư" };
const ALT_TEXT: Record<string, string> = { STOCK: "tồn kho", REVENUE: "doanh thu tháng này", DEBT: "ai còn nợ", SHIPMENTS: "kiện đang đi", RECENT_SALES: "đơn bán tuần này", BALANCE: "số dư" };

interface Action {
  id: string;
  draft: Draft;
  status: ActionStatus;
}

export class DemoEngine {
  private actions = new Map<string, Action>();
  private pendingId: string | null = null;
  private seq = 0;
  private readonly ctx: ParseCtx;

  constructor(private readonly pack: DemoPack) {
    this.ctx = { today: pack.today, variants: pack.variants, accountNames: pack.accountNames };
  }

  status(actionId: string): ActionStatus {
    return this.actions.get(actionId)?.status ?? "EXPIRED";
  }

  private pending(): Action | null {
    const a = this.pendingId ? this.actions.get(this.pendingId) : null;
    return a && a.status === "PENDING" ? a : null;
  }

  // ---- phiếu ----

  private cardReply(a: Action, b: DemoBuilt): Reply {
    const blockers = [...b.card.blockers];
    if (b.ask) blockers.unshift(`Đang chờ: ${b.ask.question}`);
    const card: PreviewCard = { kind: "preview", actionId: a.id, status: "PENDING", ...b.card, blockers };
    const chips: Chip[] = [];
    if (b.draft.choices) b.draft.choices.options.forEach((o: Choice, i: number) => chips.push({ label: `${i + 1}. ${o.label}`, event: { type: "CHOOSE", actionId: a.id, index: i + 1 } }));
    else if (b.ask?.chips?.length) chips.push(...b.ask.chips);
    if (b.ask) chips.push({ label: "Để sau (bảng kê nháp)", event: { type: "TO_BANG_KE", actionId: a.id } }, { label: "Huỷ", event: { type: "DISCARD", actionId: a.id } });
    const text = b.ask ? b.ask.question : b.card.blockers.length ? "Phiếu còn vướng — sửa rồi mới xác nhận được:" : 'Kiểm tra rồi bấm Xác nhận (hoặc gõ "ok"). Sai chỗ nào thì gõ "sửa …".';
    return { text, cards: [card], ...(chips.length ? { chips } : {}) };
  }

  private toBangKeReply(reason: string): Reply {
    return {
      text: `Chưa ghi thật được: ${reason}. Trên bản chạy thật, tin này được đưa vào Bảng kê nháp để bổ sung rồi "Ghi thật". ${NOTE}`,
      link: { href: "tro-ly__bang-ke.html", label: "Xem Bảng kê nháp" },
    };
  }

  private start(d: Draft): Reply[] {
    const b = demoPreview(d, this.pack);
    if (b.unresolvable) return [this.toBangKeReply(b.unresolvable)];
    const a: Action = { id: `demo-${++this.seq}`, draft: b.draft, status: "PENDING" };
    this.actions.set(a.id, a);
    this.pendingId = a.id;
    return [this.cardReply(a, b)];
  }

  private rebuild(a: Action, d: Draft): Reply[] {
    const b = demoPreview(d, this.pack);
    a.draft = b.draft;
    this.pendingId = a.id;
    if (b.unresolvable)
      return [
        {
          text: `Chưa ghi được: ${b.unresolvable}.`,
          chips: [
            { label: "Đưa vào bảng kê nháp", event: { type: "TO_BANG_KE", actionId: a.id } },
            { label: "Huỷ phiếu", event: { type: "DISCARD", actionId: a.id } },
          ],
        },
      ];
    return [this.cardReply(a, b)];
  }

  private confirm(a: Action): Reply[] {
    const b = demoPreview(a.draft, this.pack);
    if (b.unresolvable || b.ask || b.card.blockers.length) return [{ ...this.cardReply(a, b), text: "Chưa ghi được — phiếu còn vướng:" }];
    return [
      {
        text: `Phiếu hợp lệ ✓ — trên bản chạy thật, bấm Xác nhận sẽ ghi "${b.card.title.toLowerCase()}" vào sổ qua đúng form của hệ thống (kèm nhật ký). Đây là bản xem thử tĩnh nên không lưu gì; bạn có thể "sửa …" để thử tiếp.`,
      },
    ];
  }

  private choose(a: Action, index: number): Reply[] {
    const c = a.draft.choices;
    const opt = c?.options[index - 1];
    if (!c || !opt) return [{ text: `Không có lựa chọn số ${index}.` }];
    const d: Draft = structuredClone(a.draft);
    delete d.choices;
    delete d.asked;
    if (c.field.startsWith("line:")) {
      const l = d.lines?.[Number(c.field.slice(5))];
      if (l) {
        l.code = opt.value;
        l.codeKind = /^\d{15}$/.test(opt.value) ? "IMEI" : "SERIAL";
        delete l.itemId;
      }
    } else if (c.field === "customerId") {
      if (opt.value === "NEW") {
        delete d.customerId;
        d.forceNewCustomer = true;
      } else d.customerId = opt.value;
    } else if (c.field === "variantId") {
      d.variantIds = [opt.value];
      d.variantId = opt.value;
    } else (d as unknown as Record<string, unknown>)[c.field] = opt.value;
    return this.rebuild(a, d);
  }

  // ---- hỏi đáp ----

  private answer(intent: Intent, s: Slots): Reply {
    if (intent === "HELP") return helpReply();
    if (intent === "UNKNOWN") return fallbackReply({ money: s.money.length > 0, date: !!s.period, product: s.variantIds.length > 0, code: s.codes.length > 0 });
    if (intent === "EXPORT")
      return {
        text: `Trên bản chạy thật, câu này trả về file Excel bảng kê (bán · nhập · thu chi · tồn kho · nháp; cột ngày là ngày thật, cột tiền là số). ${NOTE}`,
        link: { href: "#xuat-excel", label: "Tải bảng kê (cần bản chạy thật)", download: true },
      };
    if (intent === "BANG_KE") return { text: "Bảng kê nháp giữ các tin chưa đủ thông tin để ghi thật.", link: { href: "tro-ly__bang-ke.html", label: "Mở Bảng kê nháp" } };
    if (intent === "STOCK" && s.variantIds.length) return this.stockOf(s);

    let subject = demoSubject(intent, s);
    if (intent === "ITEM_LOOKUP" || intent === "PRICE_SUGGEST") {
      const code = s.codes[0];
      if (!code) return s.variantIds.length ? this.stockOf(s) : { text: "Gõ IMEI, Serial hoặc vài số cuối (vd: tra đuôi 0001)." };
      if (code.kind === "IMEI_BAD") return { text: `IMEI ${code.value} sai số kiểm tra (chữ số cuối) — kiểm tra lại, có thể gõ nhầm một số.` };
      const c = code.value.toUpperCase();
      const found = this.pack.items.filter((i) => i.serial === c || i.imei === c || (code.kind === "PARTIAL" && ((i.serial ?? "").includes(c) || (i.imei ?? "").includes(c))));
      if (!found.length) return { text: `Không thấy máy ${code.value} trong hệ thống. Nếu là máy mới mua, nhập vào đơn mua trước (vd: nhập máy … vào CH-…).` };
      if (found.length > 1)
        return {
          text: `Có ${found.length} máy khớp "${code.value}":`,
          cards: [{ kind: "table", columns: ["Máy", "Serial", "IMEI"], rows: found.map((i) => [i.label, i.serial ?? "—", i.imei ?? "—"]) }],
          chips: found.slice(0, 4).map((i) => ({ label: i.serial ?? i.imei ?? "", text: i.serial ?? i.imei ?? "" })),
        };
      subject = `item:${found[0].id}`;
    }
    if ((intent === "DEBT" || intent === "CUSTOMER_LOOKUP") && (s.customerName || s.phone)) {
      const cs = this.findCustomers(s);
      if (!cs.length)
        return intent === "DEBT" ? { text: `${s.customerName ?? s.phone} không còn nợ đơn nào.` } : { text: `Chưa có khách ${s.customerName ?? s.phone ?? ""}.`, chips: [{ label: "Thêm khách này", text: `thêm khách ${s.customerName ?? ""} ${s.phone ?? ""}`.trim() }] };
      if (cs.length > 1 && intent === "CUSTOMER_LOOKUP")
        return { text: `Có ${cs.length} khách khớp:`, cards: [{ kind: "table", columns: ["Khách", "SĐT"], rows: cs.map((c) => [c.name, c.phone ?? "—"]) }] };
      subject = `cust:${cs[0].id}`;
    }
    if (intent === "BALANCE") {
      const hint = fold(`${s.rest} ${s.accountHints.join(" ")}`);
      const acc = this.pack.accounts.find((a) => (/tien mat/.test(hint) && a.kind === "CASH") || s.accountHints.some((h) => fold(a.name).includes(h)));
      if (acc) subject = `acc:${acc.id}`;
    }
    const { period, exact } = PERIOD_INTENTS.has(intent) ? demoPeriodOf(s, this.pack.today) : { period: "" as const, exact: true };
    const tries = [demoKey(intent, subject, period), demoKey(intent, subject, ""), demoKey(intent, "", period), demoKey(intent, "", "")];
    const key = tries.find((k) => this.pack.answers[k]);
    if (!key) return fallbackReply({ money: false, date: !!s.period, product: s.variantIds.length > 0, code: s.codes.length > 0 });
    const r = structuredClone(this.pack.answers[key]);
    if (!exact || key !== tries[0]) r.text += ` ${NOTE.replace(")", " — kỳ / đối tượng gần nhất có sẵn.)")}`;
    return r;
  }

  private stockOf(s: Slots): Reply {
    const rows = this.pack.stock.filter((x) => s.variantIds.includes(x.variantId));
    if (!rows.length) return { text: `Không còn máy ${s.productText ?? "dòng này"} — kể cả máy đang về.`, chips: [{ label: "Tồn kho", text: "tồn kho" }] };
    const t = rows.reduce((a, r) => a + r.inStock, 0);
    return {
      text: `${s.productText ? `"${s.productText}"` : "Dòng này"}: còn ${t} máy sẵn bán tại SG.`,
      cards: [
        {
          kind: "table",
          columns: ["Cấu hình", "Sẵn bán", "Khách cọc", "Đang về", "Vốn tồn", "Tồn lâu nhất"],
          numeric: [1, 2, 3, 4, 5],
          rows: rows.map((r) => [r.label, String(r.inStock), String(r.reserved), String(r.incoming), shortVnd(BigInt(r.costVnd)), r.oldestDays === null ? "—" : `${r.oldestDays} ngày`]),
        },
      ],
      link: { href: "kho.html", label: "Mở Kho máy" },
    };
  }

  private findCustomers(s: Slots) {
    if (s.phone) return this.pack.customers.filter((c) => c.phone === s.phone);
    const want = fold(s.customerName ?? "").replace(/^(anh|chi|em|co|chu|ban|bac|ong|ba|cau|di|thim) /, "");
    const words = want.split(" ").filter(Boolean);
    return this.pack.customers.filter((c) => fold(c.name) === fold(s.customerName ?? "") || words.every((w) => fold(c.name).split(/\s+/).includes(w)));
  }

  // ---- vào ----

  send(raw: string): Reply[] {
    const text = raw.trim().slice(0, 4000);
    if (!text) return [];
    const pending = this.pending();
    const meta = metaOf(text, !!pending);
    if (meta?.type === "CLEAR") {
      this.actions.clear();
      this.pendingId = null;
      return [{ text: "Đã xoá lịch sử trò chuyện." }];
    }
    if (meta && pending) {
      if (meta.type === "CONFIRM") return this.confirm(pending);
      if (meta.type === "CANCEL") return this.discard(pending);
      if (meta.type === "DRAFT") return this.toBangKe(pending);
      if (meta.type === "CHOOSE") return this.choose(pending, meta.index);
      const t = meta.type === "EDIT" ? meta.text : text;
      return this.rebuild(pending, mergeSlots(pending.draft, extractSlots(t, this.ctx), t));
    }
    const p = parseMessage(text, this.ctx);
    if (pending && !isWriteIntent(p.intent) && hasEditableSlots(p.slots) && (p.intent === "UNKNOWN" || p.score < 6 || !!pending.draft.asked))
      return this.rebuild(pending, mergeSlots(pending.draft, p.slots, text));
    if (isWriteIntent(p.intent)) return this.start(draftFromSlots(p.intent, p.slots, text));
    const r = this.answer(p.intent, p.slots);
    if (p.intent !== "UNKNOWN" && p.alternatives.length && !r.chips?.length) r.chips = p.alternatives.map((i) => ({ label: ALT_LABEL[i] ?? i, text: ALT_TEXT[i] ?? text }));
    return [r];
  }

  private discard(a: Action): Reply[] {
    a.status = "DISCARDED";
    this.pendingId = null;
    return [{ text: "Đã huỷ phiếu — không ghi gì." }];
  }

  private toBangKe(a: Action): Reply[] {
    a.status = "DRAFTED";
    this.pendingId = null;
    return [{ text: `Trên bản chạy thật, phiếu này được đưa vào Bảng kê nháp để bổ sung sau. ${NOTE}`, link: { href: "tro-ly__bang-ke.html", label: "Xem Bảng kê nháp" } }];
  }

  event(ev: AssistantEvent): Reply[] {
    const a = this.actions.get(ev.actionId);
    if (!a || a.status !== "PENDING") return [{ text: "Phiếu này không còn chờ xác nhận." }];
    if (ev.type === "CONFIRM") return this.confirm(a);
    if (ev.type === "DISCARD") return this.discard(a);
    if (ev.type === "TO_BANG_KE") return this.toBangKe(a);
    if (ev.type === "CHOOSE") return this.choose(a, ev.index);
    const t = ev.text.trim().slice(0, 500);
    return t ? this.rebuild(a, mergeSlots(a.draft, extractSlots(t, this.ctx), t)) : [];
  }
}
