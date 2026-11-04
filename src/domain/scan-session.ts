/**
 * Gom các mã đã đọc thành "bản ghi máy" (mỗi bản ghi = một thiết bị).
 * Hàm thuần, không phụ thuộc trình duyệt — kiểm thử trong tests/unit.
 */
import type { TextExtraction } from "./text-extract";
import {
  classifyCode,
  isPartNumber,
  isSerialFormat,
  isValidImei,
  normalizeCode,
  partNumberRegion,
  type ClassifiedCode,
} from "./identifiers";

export type FieldKey = "serial" | "imei1" | "imei2" | "partNumber" | "upc" | "eid";
export type FieldSource = "BARCODE" | "HW_SCANNER" | "PASTE" | "OCR" | "MANUAL";
export type RecordOrigin = "CAMERA" | "PHOTO" | "HW_SCANNER" | "PASTE" | "MANUAL";

export interface FieldValue {
  value: string;
  source: FieldSource;
}

export interface DeviceRecord {
  id: string;
  createdAt: string;
  origin: RecordOrigin;
  photoName?: string;
  fields: Partial<Record<FieldKey, FieldValue>>;
  /** Mã đọc được nhưng chưa nhận dạng được loại, hoặc bị trùng ô. */
  extras: string[];
  note?: string;
}

export const FIELD_LABELS: Record<FieldKey, string> = {
  serial: "Serial",
  imei1: "IMEI 1",
  imei2: "IMEI 2",
  partNumber: "Part No. (mã máy)",
  upc: "UPC/EAN",
  eid: "EID",
};

export const FIELD_ORDER: FieldKey[] = ["serial", "imei1", "imei2", "partNumber", "upc", "eid"];

export function emptyRecord(id: string, origin: RecordOrigin, now = new Date()): DeviceRecord {
  return { id, createdAt: now.toISOString(), origin, fields: {}, extras: [] };
}

type ApplyResult = "set" | "duplicate" | "conflict" | "ignored";

function targetFields(code: ClassifiedCode): FieldKey[] {
  switch (code.kind) {
    case "IMEI":
      return ["imei1", "imei2"];
    case "SERIAL":
      return ["serial"];
    case "PART_NUMBER":
      return ["partNumber"];
    case "UPC":
    case "EAN":
      return ["upc"];
    case "EID":
      return ["eid"];
    default:
      return [];
  }
}

/** Gán một mã vào bản ghi (không sửa bản ghi gốc). */
export function applyCode(
  record: DeviceRecord,
  code: ClassifiedCode,
  source: FieldSource,
): { record: DeviceRecord; result: ApplyResult } {
  const keys = targetFields(code);
  if (keys.length === 0) {
    if (record.extras.includes(code.value)) return { record, result: "duplicate" };
    return { record: { ...record, extras: [...record.extras, code.value] }, result: "ignored" };
  }
  if (keys.some((k) => record.fields[k]?.value === code.value)) return { record, result: "duplicate" };
  const free = keys.find((k) => !record.fields[k]);
  if (!free) return { record, result: "conflict" };
  return {
    record: { ...record, fields: { ...record.fields, [free]: { value: code.value, source } } },
    result: "set",
  };
}

/** Mọi giá trị đã có trong phiên (để bỏ qua mã quét lặp). */
export function knownValues(records: DeviceRecord[]): Set<string> {
  const s = new Set<string>();
  for (const r of records) for (const f of Object.values(r.fields)) if (f) s.add(f.value);
  return s;
}

export interface StreamState {
  records: DeviceRecord[];
  currentId: string | null;
}

/**
 * Quét liên tục (camera / máy quét cầm tay / dán từng mã): mã mới được gán vào
 * máy đang quét; khi ô tương ứng đã có giá trị khác (vd: gặp serial thứ hai)
 * thì tự mở bản ghi máy mới. Mã đã có trong phiên bị bỏ qua.
 */
export function mergeStream(
  state: StreamState,
  rawCodes: string[],
  source: FieldSource,
  origin: RecordOrigin,
  makeId: () => string,
): StreamState & { added: ClassifiedCode[] } {
  let records = [...state.records];
  let currentId = state.currentId;
  const known = knownValues(records);
  const added: ClassifiedCode[] = [];

  for (const raw of rawCodes) {
    const code = classifyCode(raw);
    if (!code.value || known.has(code.value)) continue;
    if (code.kind === "UNKNOWN" && code.value.length < 4) continue;

    let idx = records.findIndex((r) => r.id === currentId);
    if (idx === -1) {
      records = [...records, emptyRecord(makeId(), origin)];
      idx = records.length - 1;
      currentId = records[idx].id;
    }
    let { record, result } = applyCode(records[idx], code, source);
    if (result === "conflict") {
      const fresh = emptyRecord(makeId(), origin);
      ({ record, result } = applyCode(fresh, code, source));
      records = [...records, record];
      currentId = record.id;
    } else {
      records[idx] = record;
    }
    if (result === "set") {
      known.add(code.value);
      added.push(code);
    }
  }
  return { records, currentId, added };
}

export interface PositionedCode {
  text: string;
  /** Tâm của mã vạch trên ảnh (pixel). */
  x: number;
  y: number;
}

/**
 * Một ảnh / một khung hình → một hay nhiều bản ghi.
 * - Một serial (một hộp): gom hết vào một bản ghi.
 * - Nhiều serial (nhiều hộp trong ảnh): mỗi serial là một máy; mỗi IMEI theo serial gần nhất;
 *   mã còn lại (Part No., UPC…) theo máy có mã định danh (serial/IMEI) gần nhất.
 */
export function recordsFromPhoto(
  codes: PositionedCode[],
  photoName: string,
  makeId: () => string,
  origin: RecordOrigin = "PHOTO",
): DeviceRecord[] {
  const classified = codes
    .map((c) => ({ ...c, code: classifyCode(c.text) }))
    .filter((c, i, arr) => arr.findIndex((o) => o.code.value === c.code.value) === i);
  type C = (typeof classified)[number];
  const dist = (a: C, b: C) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const nearest = <T extends C>(c: C, pool: T[]) => pool.reduce((best, p) => (dist(c, p) < dist(c, best) ? p : best), pool[0]);

  const serials = classified.filter((c) => c.code.kind === "SERIAL");
  let groups: C[][];
  if (serials.length > 1) {
    const groupOf = new Map<C, number>(serials.map((s, i) => [s, i]));
    groups = serials.map((s) => [s]);
    for (const c of classified.filter((x) => x.code.kind === "IMEI")) {
      const g = groupOf.get(nearest(c, serials))!;
      groups[g].push(c);
      groupOf.set(c, g);
    }
    const identities = [...groupOf.keys()];
    for (const c of classified.filter((x) => x.code.kind !== "SERIAL" && x.code.kind !== "IMEI")) {
      groups[groupOf.get(nearest(c, identities))!].push(c);
    }
  } else {
    groups = [classified];
  }

  return groups.map((group) => {
    let record: DeviceRecord = { ...emptyRecord(makeId(), origin), ...(origin === "PHOTO" ? { photoName } : {}) };
    // serial trước để bản ghi có "neo"
    const ordered = [...group].sort((a, b) => Number(b.code.kind === "SERIAL") - Number(a.code.kind === "SERIAL"));
    for (const c of ordered) {
      const res = applyCode(record, c.code, "BARCODE");
      record = res.result === "conflict" ? { ...res.record, extras: [...res.record.extras, c.code.value] } : res.record;
    }
    return record;
  });
}

/**
 * Một khung hình camera (quét liên tục). Thấy nhiều hộp → gom theo vị trí như ảnh rồi gộp vào máy đã có.
 * Thấy một hộp → nối vào máy đang quét, nhưng BỎ Part No. nằm dưới mọi mã định danh trong khung:
 * trên nhãn Apple, dòng Part No. luôn ở trên cùng — mã nằm dưới là của hộp bên dưới.
 */
export function mergeLiveFrame(
  state: StreamState,
  codes: PositionedCode[],
  makeId: () => string,
): StreamState & { added: number } {
  const kinds = codes.map((c) => ({ ...c, kind: classifyCode(c.text).kind }));
  const serialCount = new Set(kinds.filter((k) => k.kind === "SERIAL").map((k) => classifyCode(k.text).value)).size;
  if (serialCount > 1) {
    let records = [...state.records];
    let added = 0;
    let currentId = state.currentId;
    for (const rec of recordsFromPhoto(codes, "", makeId, "CAMERA")) {
      const match = findMatch(records, rec);
      if (match) {
        const m = mergeRecord(match, rec);
        if (m.filled) {
          records = records.map((r) => (r.id === match.id ? m.record : r));
          added += m.filled;
        }
      } else if (Object.keys(rec.fields).length > 0) {
        records = [...records, rec];
        currentId = rec.id;
        added += Object.keys(rec.fields).length;
      }
    }
    return { records, currentId, added };
  }
  const identityYs = kinds.filter((k) => k.kind === "SERIAL" || k.kind === "IMEI").map((k) => k.y);
  const lowest = identityYs.length ? Math.max(...identityYs) : Infinity;
  const kept = kinds.filter((k) => !(k.kind === "PART_NUMBER" && k.y > lowest)).map((k) => k.text);
  const next = mergeStream(state, kept, "BARCODE", "CAMERA", makeId);
  return { records: next.records, currentId: next.currentId, added: next.added.length };
}

/**
 * Đưa kết quả đọc chữ (OCR) vào bản ghi: CHỈ điền các ô còn trống — giá trị đọc từ
 * mã vạch (có số kiểm tra) luôn được ưu tiên. Trả về bản ghi mới và số ô đã điền.
 */
export function applyExtraction(record: DeviceRecord, x: TextExtraction, source: FieldSource = "OCR"): { record: DeviceRecord; filled: number } {
  const fields = { ...record.fields };
  let filled = 0;
  const known = new Set(Object.values(fields).map((f) => f?.value));
  const put = (k: FieldKey, v: string | undefined) => {
    if (!v || fields[k] || known.has(v)) return;
    fields[k] = { value: v, source };
    known.add(v);
    filled++;
  };
  put("serial", x.serial);
  for (const imei of x.imeis) put(fields.imei1 ? "imei2" : "imei1", imei);
  put("partNumber", x.partNumber);
  put("upc", x.upc);
  put("eid", x.eid);
  return { record: filled ? { ...record, fields } : record, filled };
}

/** Tìm máy đã có trùng serial hoặc IMEI với bản ghi mới (chụp lại cùng một hộp). */
export function findMatch(records: DeviceRecord[], rec: DeviceRecord): DeviceRecord | undefined {
  const ids = ["serial", "imei1", "imei2"].map((k) => rec.fields[k as FieldKey]?.value).filter(Boolean) as string[];
  if (ids.length === 0) return undefined;
  return records.find((r) => ["serial", "imei1", "imei2"].some((k) => ids.includes(r.fields[k as FieldKey]?.value ?? "")));
}

/** Gộp các ô còn trống của `target` từ `src` (giữ nguồn của từng ô). */
export function mergeRecord(target: DeviceRecord, src: DeviceRecord): { record: DeviceRecord; filled: number } {
  const fields = { ...target.fields };
  const known = new Set(Object.values(fields).map((f) => f?.value));
  let filled = 0;
  for (const k of FIELD_ORDER) {
    const v = src.fields[k];
    if (!v) continue;
    if (k === "imei1" || k === "imei2") {
      if (known.has(v.value)) continue;
      const slot: FieldKey | undefined = !fields.imei1 ? "imei1" : !fields.imei2 ? "imei2" : undefined;
      if (slot) {
        fields[slot] = v;
        known.add(v.value);
        filled++;
      }
    } else if (!fields[k] && !known.has(v.value)) {
      fields[k] = v;
      known.add(v.value);
      filled++;
    }
  }
  return { record: filled ? { ...target, fields } : target, filled };
}

/** Người dùng sửa tay một ô. Chuỗi rỗng = xoá ô. */
export function setField(record: DeviceRecord, key: FieldKey, rawValue: string): DeviceRecord {
  const value = normalizeCode(rawValue);
  const fields = { ...record.fields };
  if (!value) delete fields[key];
  else fields[key] = { value, source: "MANUAL" };
  return { ...record, fields };
}

export type Severity = "error" | "warning";
export interface RecordIssue {
  field?: FieldKey;
  severity: Severity;
  message: string;
}

export function validateRecord(
  record: DeviceRecord,
  all: DeviceRecord[],
  expectedRegion: string | null = "LL/A",
): RecordIssue[] {
  const issues: RecordIssue[] = [];
  const f = record.fields;

  for (const k of ["imei1", "imei2"] as const) {
    const v = f[k]?.value;
    if (v && !isValidImei(v)) issues.push({ field: k, severity: "error", message: "IMEI sai số kiểm tra (Luhn)" });
  }
  if (f.imei1 && f.imei2 && f.imei1.value === f.imei2.value)
    issues.push({ field: "imei2", severity: "error", message: "IMEI 2 trùng IMEI 1" });
  if (f.serial?.source === "OCR")
    issues.push({ field: "serial", severity: "warning", message: "Đọc bằng chữ (OCR) — soát lại với hộp máy" });
  if (f.serial && !isSerialFormat(f.serial.value))
    issues.push({ field: "serial", severity: "warning", message: "Serial thường có 10 hoặc 12 ký tự — kiểm tra lại" });
  if (f.partNumber) {
    if (!isPartNumber(f.partNumber.value)) {
      issues.push({ field: "partNumber", severity: "warning", message: "Part No. không đúng mẫu (vd: XXXXXLL/A)" });
    } else if (expectedRegion) {
      const region = partNumberRegion(f.partNumber.value);
      if (region && region !== expectedRegion)
        issues.push({
          field: "partNumber",
          severity: "warning",
          message: `Mã thị trường ${region} — không phải hàng ${expectedRegion}`,
        });
    }
  }
  if (!f.serial && !f.imei1) issues.push({ severity: "warning", message: "Chưa có Serial hoặc IMEI" });

  for (const k of ["serial", "imei1", "imei2"] as const) {
    const v = f[k]?.value;
    if (!v) continue;
    const dup = all.some(
      (o) => o.id !== record.id && (o.fields.serial?.value === v || o.fields.imei1?.value === v || o.fields.imei2?.value === v),
    );
    if (dup) issues.push({ field: k, severity: "error", message: "Trùng với máy khác trong phiên quét" });
  }
  return issues;
}

const EXPORT_HEADER = ["STT", "Serial", "IMEI 1", "IMEI 2", "Part No.", "UPC/EAN", "EID", "Nguồn", "Ảnh", "Ghi chú"];

function exportRows(records: DeviceRecord[]): string[][] {
  return records.map((r, i) => [
    String(i + 1),
    ...FIELD_ORDER.map((k) => r.fields[k]?.value ?? ""),
    r.origin,
    r.photoName ?? "",
    r.note ?? "",
  ]);
}

/** Dạng tab — dán thẳng vào Excel / Google Sheets. */
export function toTsv(records: DeviceRecord[]): string {
  return [EXPORT_HEADER, ...exportRows(records)].map((row) => row.join("\t")).join("\n");
}

/** CSV có BOM UTF-8 để Excel hiển thị đúng tiếng Việt. Mã số dài được giữ dạng chữ. */
export function toCsv(records: DeviceRecord[]): string {
  const esc = (v: string, col: number) => {
    const isLongNumber = /^\d{11,}$/.test(v) && col >= 1 && col <= 6;
    const text = isLongNumber ? `="${v}"` : v;
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [EXPORT_HEADER, ...exportRows(records)].map((row) => row.map(esc).join(","));
  return "﻿" + lines.join("\r\n");
}
