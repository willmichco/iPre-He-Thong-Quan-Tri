/**
 * Gom các mã đã đọc thành "bản ghi máy" (mỗi bản ghi = một thiết bị).
 * Hàm thuần, không phụ thuộc trình duyệt — kiểm thử trong tests/unit.
 */
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
export type FieldSource = "BARCODE" | "HW_SCANNER" | "PASTE" | "MANUAL";
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
 * Một ảnh → một hay nhiều bản ghi. Ảnh một hộp: gom hết vào một bản ghi.
 * Ảnh nhiều hộp (nhiều serial): mỗi serial là một máy, các mã khác gán cho
 * serial gần nhất trên ảnh.
 */
export function recordsFromPhoto(
  codes: PositionedCode[],
  photoName: string,
  makeId: () => string,
): DeviceRecord[] {
  const classified = codes
    .map((c) => ({ ...c, code: classifyCode(c.text) }))
    .filter((c, i, arr) => arr.findIndex((o) => o.code.value === c.code.value) === i);
  const serials = classified.filter((c) => c.code.kind === "SERIAL");

  const anchors = serials.length > 1 ? serials : [];
  const groups = anchors.length > 0 ? anchors.map(() => [] as typeof classified) : [classified];
  if (anchors.length > 0) {
    for (const c of classified) {
      if (c.code.kind === "SERIAL") {
        groups[anchors.indexOf(c)].push(c);
        continue;
      }
      let best = 0;
      let bestD = Infinity;
      anchors.forEach((a, i) => {
        const d = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      groups[best].push(c);
    }
  }

  return groups.map((group) => {
    let record: DeviceRecord = { ...emptyRecord(makeId(), "PHOTO"), photoName };
    // serial trước để bản ghi có "neo"
    const ordered = [...group].sort((a, b) => Number(b.code.kind === "SERIAL") - Number(a.code.kind === "SERIAL"));
    for (const c of ordered) {
      const res = applyCode(record, c.code, "BARCODE");
      record = res.result === "conflict" ? { ...res.record, extras: [...res.record.extras, c.code.value] } : res.record;
    }
    return record;
  });
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
