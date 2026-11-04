/**
 * Bỏ phiếu giữa nhiều lần chụp khi đọc chữ từ camera (chế độ "Màn hình máy").
 * Một lần đọc sai (rung, loá) không được tạo ra máy mới hay ghi đè giá trị đúng:
 *  - IMEI: nhận ngay ở lần đầu — đã có số kiểm tra Luhn chặn đọc sai.
 *  - Serial, Part No., EID: chỉ nhận khi ≥ 2 lần chụp đọc ra GIỐNG HỆT nhau.
 *    Serial không nằm cạnh nhãn "Serial/Số sê-ri" chỉ tính nửa phiếu.
 * Hàm thuần, kiểm thử trong tests/unit/screen-votes.test.ts.
 */
import type { TextExtraction } from "./text-extract";

export interface Accepted {
  serial?: string;
  imeis: string[];
  partNumber?: string;
  eid?: string;
}

export interface ScreenVotes {
  counts: Record<string, number>;
  accepted: Accepted;
  readings: number;
}

export const VOTES_NEEDED = { serial: 2, partNumber: 2, eid: 2, imei: 1 } as const;

export function emptyVotes(): ScreenVotes {
  return { counts: {}, accepted: { imeis: [] }, readings: 0 };
}

export interface VoteResult {
  votes: ScreenVotes;
  /** Giá trị vừa được nhận ở lần đọc này. */
  newly: Accepted;
  /** Lần đọc này cho thấy đây là MÁY KHÁC (serial/IMEI đã chốt khác hẳn). */
  otherDevice: boolean;
}

export function addReading(prev: ScreenVotes, x: TextExtraction): VoteResult {
  const counts = { ...prev.counts };
  const accepted: Accepted = { ...prev.accepted, imeis: [...prev.accepted.imeis] };
  const newly: Accepted = { imeis: [] };
  let otherDevice = false;

  const vote = (field: string, value: string, weight = 1) => {
    const key = `${field}:${value}`;
    counts[key] = (counts[key] ?? 0) + weight;
    return counts[key];
  };

  for (const imei of x.imeis) {
    if (vote("imei", imei) >= VOTES_NEEDED.imei && !accepted.imeis.includes(imei)) {
      if (accepted.imeis.length >= 2) {
        otherDevice = true; // máy chỉ có tối đa 2 IMEI
        continue;
      }
      accepted.imeis.push(imei);
      newly.imeis.push(imei);
    }
  }
  if (x.serial && vote("serial", x.serial, x.serialAnchored ? 1 : 0.5) >= VOTES_NEEDED.serial) {
    if (!accepted.serial) {
      accepted.serial = x.serial;
      newly.serial = x.serial;
    } else if (accepted.serial !== x.serial && x.serialAnchored) {
      otherDevice = true;
    }
  }
  if (x.partNumber && vote("part", x.partNumber) >= VOTES_NEEDED.partNumber && !accepted.partNumber) {
    accepted.partNumber = x.partNumber;
    newly.partNumber = x.partNumber;
  }
  if (x.eid && vote("eid", x.eid) >= VOTES_NEEDED.eid && !accepted.eid) {
    accepted.eid = x.eid;
    newly.eid = x.eid;
  }
  return { votes: { counts, accepted, readings: prev.readings + 1 }, newly, otherDevice };
}

export function hasNew(a: Accepted): boolean {
  return Boolean(a.serial || a.partNumber || a.eid || a.imeis.length);
}

/** Đổi kết quả đã chốt sang dạng TextExtraction để ghi vào bản ghi máy. */
export function acceptedAsExtraction(a: Accepted): TextExtraction {
  return { serial: a.serial, serialAnchored: true, imeis: a.imeis, partNumber: a.partNumber, eid: a.eid };
}
