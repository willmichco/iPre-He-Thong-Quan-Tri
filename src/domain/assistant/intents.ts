/**
 * Trợ lý — bảng ý định (intent) và cách chấm điểm. Mỗi intent có các cụm từ khoá (đã fold) kèm trọng số;
 * câu hỏi ("bao nhiêu", "nào", "?") kéo điểm về phía intent hỏi, làm yếu intent ghi.
 */
import { fold, isQuestion } from "./normalize";
import type { Slots } from "./extract";

export const WRITE_INTENTS = [
  "SALE",
  "DEPOSIT",
  "PAYMENT",
  "COMPLETE_DEPOSIT",
  "PURCHASE_ITEMS",
  "LEDGER_ENTRY",
  "LANDED_COST",
  "TRANSFER",
  "CUSTOMER",
  "EINVOICE",
  "TARGET_PRICE",
] as const;
export type WriteIntent = (typeof WRITE_INTENTS)[number];

export const QUERY_INTENTS = [
  "HELP",
  "STOCK",
  "AGED_STOCK",
  "STAGE",
  "CAPITAL",
  "ITEM_LOOKUP",
  "PRICE_SUGGEST",
  "REVENUE",
  "MONTHLY",
  "OPEX",
  "TOP_MODELS",
  "BY_CHANNEL",
  "BATCH",
  "RECENT_SALES",
  "SALE_LOOKUP",
  "DEBT",
  "PAYABLES",
  "BALANCE",
  "CASHFLOW",
  "SHIPMENTS",
  "SHORTAGES",
  "ALERTS",
  "TAX",
  "UNINVOICED",
  "DOCS",
  "EXPORT",
  "BANG_KE",
  "CUSTOMER_LOOKUP",
] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];
export type Intent = WriteIntent | QueryIntent | "UNKNOWN";

export const isWriteIntent = (i: Intent): i is WriteIntent => (WRITE_INTENTS as readonly string[]).includes(i);

interface IntentDef {
  phrases: [string, number][];
  /** điểm cộng khi câu có ô thông tin này */
  boosts?: (keyof Slots)[];
  /** cụm từ làm intent này không hợp (trừ điểm) */
  blocks?: string[];
}

const DEFS: Record<Exclude<Intent, "UNKNOWN">, IntentDef> = {
  // ---- ghi ----
  SALE: {
    phrases: [
      ["ban", 4],
      ["ban cho", 5],
      ["chot", 3],
      ["chot don", 5],
      ["xuat ban", 5],
      ["ban may", 5],
      ["ban duoc", 2],
      ["ban le", 4],
      ["khach lay", 4],
      ["khach mua", 5],
    ],
    boosts: ["codes", "customerName", "phone", "channel"],
    blocks: ["gia ban muc tieu", "dat gia", "ban chay", "kenh ban", "don ban", "da ban", "ban gi", "ban nhung", "bang ke", "gia ban la", "gia ban"],
  },
  DEPOSIT: {
    phrases: [
      ["coc", 6],
      ["dat coc", 7],
      ["dat truoc", 5],
      ["giu may", 5],
      ["coc truoc", 7],
    ],
    boosts: ["codes", "customerName", "phone"],
    blocks: ["huy coc", "don coc nao", "coc nao"],
  },
  PAYMENT: {
    phrases: [
      ["tra them", 6],
      ["thu them", 6],
      ["tra no", 7],
      ["thu no", 7],
      ["thanh toan them", 6],
      ["tra not", 7],
      ["tra tiep", 6],
      ["tra du", 5],
      ["tra tien", 4],
    ],
    boosts: ["saleCode", "customerName"],
  },
  COMPLETE_DEPOSIT: {
    phrases: [
      ["hoan tat", 7],
      ["hoan tat don", 8],
      ["tat toan", 7],
      ["giao may cho", 5],
      ["khach lay may", 6],
      ["chot don coc", 8],
    ],
    boosts: ["saleCode"],
  },
  PURCHASE_ITEMS: {
    phrases: [
      ["nhap may", 7],
      ["nhap hang", 6],
      ["nhap", 4],
      ["them may", 5],
      ["them vao don", 6],
      ["vao don mua", 6],
      ["mua them", 3],
      ["mua", 3],
    ],
    boosts: ["codes", "usd", "batchCode"],
    blocks: ["bang ke nhap", "ghi nhap", "luu nhap", "khach mua", "mua bao nhieu", "nhap gi"],
  },
  LEDGER_ENTRY: {
    phrases: [
      ["chi", 4],
      ["chi phi", 3],
      ["chi tien", 5],
      ["thu", 2],
      ["thu khac", 6],
      ["gop von", 8],
      ["bo von", 7],
      ["rut von", 8],
      ["rut lai", 7],
      ["nop thue", 8],
      ["quang cao", 4],
      ["chay ads", 6],
      ["ads", 3],
      ["tien nha", 6],
      ["tien mat bang", 7],
      ["thue kho", 6],
      ["thue nha", 6],
      ["tien dien", 6],
      ["tien nuoc", 6],
      ["internet", 4],
      ["cuoc dien thoai", 6],
      ["phan mem", 4],
      ["mua do", 3],
    ],
    blocks: ["chi tiet", "thu chi", "doanh thu", "chi bao nhieu", "chi phi van hanh", "thu tu", "thue thu nhap", "thu ba", "thu hai", "thu nam", "thu sau", "thu bay"],
  },
  LANDED_COST: {
    phrases: [
      ["cuoc kien", 8],
      ["cuoc van chuyen", 7],
      ["phi van chuyen", 6],
      ["phi kien", 7],
      ["cuoc", 3],
      ["phi forwarder", 8],
      ["forwarder", 4],
      ["thong quan", 7],
      ["phi thong quan", 8],
      ["thue nhap khau", 8],
      ["phi hai quan", 8],
      ["phi chuyen", 4],
      ["ship noi dia", 6],
      ["phi ship kien", 8],
      ["cuoc bay", 7],
      ["phi chanh", 7],
      ["chanh xe", 6],
    ],
    boosts: ["tracking", "batchCode"],
  },
  TRANSFER: {
    phrases: [
      ["chuyen tien", 7],
      ["chuyen", 2],
      ["rut tien", 6],
      ["nap tien", 6],
      ["chuyen quy", 7],
    ],
    boosts: ["fromAccountHints"],
    blocks: ["chuyen khoan", "chuyen hang", "chuyen nao", "van chuyen", "chuyen ch"],
  },
  CUSTOMER: {
    phrases: [
      ["them khach", 8],
      ["tao khach", 8],
      ["luu khach", 8],
      ["khach moi", 6],
      ["luu so", 5],
      ["luu sdt", 6],
    ],
    boosts: ["phone", "customerName"],
  },
  EINVOICE: {
    phrases: [
      ["xuat hoa don", 6],
      ["so hoa don", 5],
      ["hoa don", 3],
      ["hddt", 4],
      ["ghi hoa don", 7],
    ],
    boosts: ["einvoiceNo", "saleCode"],
    blocks: ["chua xuat hoa don", "chua co hoa don", "don nao"],
  },
  TARGET_PRICE: {
    phrases: [
      ["dat gia", 8],
      ["gia ban muc tieu", 9],
      ["gia muc tieu", 9],
      ["niem yet", 7],
      ["gia ban la", 6],
      ["len gia", 6],
      ["doi gia ban", 7],
    ],
    boosts: ["codes"],
  },
  // ---- hỏi ----
  HELP: {
    phrases: [
      ["giup", 6],
      ["huong dan", 7],
      ["lam duoc gi", 8],
      ["help", 6],
      ["cach dung", 7],
      ["chao", 4],
      ["hello", 4],
      ["hi", 2],
      ["start", 4],
      ["vi du", 5],
    ],
  },
  STOCK: {
    phrases: [
      ["ton kho", 7],
      ["ton", 3],
      ["con bao nhieu may", 7],
      ["con may", 4],
      ["con hang", 5],
      ["con bao nhieu", 4],
      ["kho", 3],
      ["hang ton", 6],
      ["trong kho", 6],
      ["san hang", 5],
      ["co san", 4],
      ["con khong", 4],
      ["con ko", 4],
    ],
    blocks: ["ton lau", "kho my", "tien", "no", "von", "so du"],
  },
  AGED_STOCK: {
    phrases: [
      ["ton lau", 8],
      ["ton tren", 8],
      ["ton qua", 8],
      ["ton hon", 8],
      ["lau ngay", 6],
      ["ban cham", 7],
      ["e", 1],
      ["hang e", 7],
      ["can xa", 6],
      ["xa hang", 6],
    ],
    boosts: ["days"],
  },
  STAGE: {
    phrases: [
      ["dang ve", 7],
      ["dang o", 5],
      ["o hn", 6],
      ["tai hn", 6],
      ["o ha noi", 6],
      ["kho my", 7],
      ["dang ship", 5],
      ["tren duong", 6],
      ["chua ve", 6],
      ["dang chuyen", 5],
      ["sap ve", 6],
    ],
    blocks: ["kien"],
  },
  CAPITAL: {
    phrases: [
      ["von", 4],
      ["von dang", 7],
      ["von nam", 7],
      ["von dong", 7],
      ["dong von", 7],
      ["tien hang", 4],
    ],
    blocks: ["gop von", "rut von", "gia von", "bo von"],
  },
  ITEM_LOOKUP: {
    phrases: [
      ["tra", 3],
      ["tra cuu", 6],
      ["kiem tra may", 6],
      ["thong tin may", 7],
      ["may nay", 3],
      ["lich su may", 7],
      ["bao hanh", 3],
      ["con bao hanh", 7],
      ["gia von", 5],
      ["lai bao nhieu", 2],
    ],
    boosts: ["codes"],
  },
  PRICE_SUGGEST: {
    phrases: [
      ["nen ban", 7],
      ["ban bao nhieu", 5],
      ["ban gia nao", 6],
      ["goi y gia", 8],
      ["de lai", 5],
      ["muon lai", 6],
      ["lai duoc", 3],
    ],
    boosts: ["codes", "variantIds"],
  },
  REVENUE: {
    phrases: [
      ["doanh thu", 7],
      ["doanh so", 7],
      ["lai", 4],
      ["loi nhuan", 7],
      ["lai lo", 7],
      ["kiem duoc", 6],
      ["lai bao nhieu", 6],
      ["loi", 2],
      ["ban duoc bao nhieu", 6],
      ["ket qua kinh doanh", 8],
      ["tong ket", 5],
    ],
    boosts: ["period"],
    blocks: ["tung thang", "theo thang", "lai nhat", "dong nao", "kenh nao", "chuyen"],
  },
  MONTHLY: {
    phrases: [
      ["tung thang", 8],
      ["theo thang", 8],
      ["moi thang", 6],
      ["cac thang", 7],
      ["xu huong", 6],
    ],
  },
  OPEX: {
    phrases: [
      ["chi phi van hanh", 9],
      ["chi quang cao", 7],
      ["chi ads", 7],
      ["chi bao nhieu", 6],
      ["chi tieu", 5],
      ["chi phi", 4],
      ["ton bao nhieu tien", 6],
      ["het bao nhieu", 5],
    ],
    boosts: ["period"],
  },
  TOP_MODELS: {
    phrases: [
      ["dong nao", 7],
      ["ban chay", 8],
      ["lai nhat", 7],
      ["may nao lai", 8],
      ["top", 5],
      ["theo dong may", 8],
      ["dong may", 5],
      ["model nao", 7],
    ],
  },
  BY_CHANNEL: {
    phrases: [
      ["kenh nao", 8],
      ["theo kenh", 8],
      ["kenh ban", 6],
      ["kenh", 4],
    ],
  },
  BATCH: {
    phrases: [
      ["chuyen", 4],
      ["chuyen hang", 7],
      ["cac chuyen", 7],
      ["chuyen nao", 6],
    ],
    boosts: ["batchCode"],
    blocks: ["chuyen tien", "chuyen khoan", "van chuyen", "chuyen quy"],
  },
  RECENT_SALES: {
    phrases: [
      ["ban gi", 7],
      ["don ban", 6],
      ["da ban", 5],
      ["ban nhung", 7],
      ["ban duoc may", 6],
      ["don hom", 5],
      ["don gan day", 7],
      ["cac don", 5],
      ["ban duoc gi", 7],
      ["danh sach don", 7],
    ],
    boosts: ["period"],
  },
  SALE_LOOKUP: {
    phrases: [
      ["don", 2],
      ["xem don", 6],
      ["chi tiet don", 7],
    ],
    boosts: ["saleCode"],
  },
  DEBT: {
    phrases: [
      ["no", 4],
      ["cong no", 7],
      ["con no", 7],
      ["ai no", 8],
      ["ai con no", 9],
      ["chua tra", 5],
      ["no bao nhieu", 7],
      ["khach no", 8],
      ["phai thu", 7],
    ],
    blocks: ["minh no", "no ai", "phai tra", "tra no", "thu no", "ghi no"],
  },
  PAYABLES: {
    phrases: [
      ["minh no", 8],
      ["no ai", 8],
      ["phai tra", 7],
      ["no nguoi ban", 8],
      ["no forwarder", 8],
    ],
  },
  BALANCE: {
    phrases: [
      ["so du", 8],
      ["con bao nhieu tien", 8],
      ["tien mat con", 8],
      ["quy con", 7],
      ["tai khoan", 4],
      ["con tien", 6],
      ["bao nhieu tien", 4],
      ["tien trong", 6],
    ],
  },
  CASHFLOW: {
    phrases: [
      ["thu chi", 8],
      ["dong tien", 8],
      ["tien vao", 6],
      ["tien ra", 6],
      ["so quy", 7],
    ],
  },
  SHIPMENTS: {
    phrases: [
      ["kien", 5],
      ["kien dang di", 8],
      ["van chuyen", 6],
      ["dang di", 4],
      ["tre", 3],
      ["kien nao tre", 9],
      ["van don", 6],
      ["tracking", 6],
      ["kien hang", 7],
    ],
    boosts: ["tracking"],
    blocks: ["thieu", "cuoc", "phi"],
  },
  SHORTAGES: {
    phrases: [
      ["thieu may", 8],
      ["kien thieu", 9],
      ["thieu hang", 8],
      ["thieu", 4],
      ["that lac", 7],
    ],
    blocks: ["thieu chung tu"],
  },
  ALERTS: {
    phrases: [
      ["can xu ly", 9],
      ["canh bao", 8],
      ["viec can lam", 9],
      ["co gi moi", 6],
      ["nhac viec", 8],
      ["viec gi", 6],
      ["can lam gi", 8],
      ["tong quan", 7],
      ["bao cao nhanh", 7],
      ["tinh hinh", 6],
    ],
  },
  TAX: {
    phrases: [
      ["thue", 5],
      ["nguong", 7],
      ["nguong thue", 9],
      ["doanh thu nam", 6],
      ["ke khai", 7],
      ["1 ty", 4],
    ],
    blocks: ["nop thue", "thue kho", "thue nha", "thue mat bang", "thue nhap khau"],
  },
  UNINVOICED: {
    phrases: [
      ["chua xuat hoa don", 10],
      ["chua co hoa don", 9],
      ["chua xuat hd", 10],
      ["thieu hoa don", 9],
    ],
  },
  DOCS: {
    phrases: [
      ["chung tu", 7],
      ["thieu chung tu", 9],
      ["hop cho", 8],
      ["cho duyet", 7],
    ],
  },
  EXPORT: {
    phrases: [
      ["xuat excel", 10],
      ["xuat file", 9],
      ["excel", 7],
      ["tai bang ke", 9],
      ["xuat bang ke", 10],
      ["file bang ke", 9],
      ["xlsx", 8],
      ["xuat bao cao", 8],
    ],
  },
  BANG_KE: {
    phrases: [
      ["bang ke nhap", 9],
      ["xem bang ke", 8],
      ["bang ke", 5],
      ["dong nhap", 6],
    ],
    blocks: ["xuat bang ke", "tai bang ke", "file bang ke"],
  },
  CUSTOMER_LOOKUP: {
    phrases: [
      ["thong tin khach", 8],
      ["tim khach", 8],
      ["khach nao", 5],
      ["sdt cua", 6],
      ["so cua", 4],
      ["lich su mua", 7],
    ],
    boosts: ["customerName", "phone"],
  },
};

export interface Scored {
  intent: Exclude<Intent, "UNKNOWN">;
  score: number;
}

const has = (hay: string, phrase: string) => hay.includes(` ${phrase} `);
/** câu chỉ còn lại từ khoá rất chung (để phân biệt "tồn kho" với "kho") */
const filled = (s: Slots, k: keyof Slots) => {
  const v = s[k];
  return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== "" && v !== false;
};

/** Chấm điểm mọi intent cho một câu (đã trích ô thông tin). */
export function scoreIntents(text: string, slots: Slots): Scored[] {
  const hay = ` ${fold(text)
    .replace(/[^a-z0-9$>]+/g, " ")
    .trim()} `;
  const question = isQuestion(text);
  const out: Scored[] = [];
  for (const [intent, def] of Object.entries(DEFS) as [Exclude<Intent, "UNKNOWN">, IntentDef][]) {
    // cụm dài khớp trước, cụm ngắn nằm trong cụm dài đã khớp không được cộng lần nữa
    let score = 0;
    let matched = "";
    for (const [p, w] of [...def.phrases].sort((a, b) => b[0].length - a[0].length)) {
      if (has(hay, p) && !has(` ${matched} `, p)) {
        score += w;
        matched += ` ${p} `;
      }
    }
    if (score === 0) continue;
    for (const b of def.boosts ?? []) if (filled(slots, b)) score += 2;
    for (const b of def.blocks ?? []) if (has(hay, b)) score -= 5;
    if (isWriteIntent(intent) && question) score *= 0.35;
    if (!isWriteIntent(intent) && question) score += 1;
    // có số tiền mà không hỏi → gần như chắc là câu ghi ("chi quảng cáo 2tr hôm qua")
    if (!isWriteIntent(intent) && !question && (slots.money.length || slots.usd.length) && intent !== "PRICE_SUGGEST") score *= 0.5;
    if (score > 0) out.push({ intent, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** ngưỡng tối thiểu để tin vào intent */
export const MIN_SCORE = 3;
