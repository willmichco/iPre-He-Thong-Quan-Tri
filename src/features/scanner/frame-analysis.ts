/**
 * Phân tích khung hình camera kiểu "máy quét tài liệu" — hàm thuần trên ảnh xám
 * (Uint8Array w×h), không phụ thuộc trình duyệt, kiểm thử được trên Node.
 *
 *  - motion():      khung hình có đang rung/lắc không (so với khung trước)
 *  - sharpness():   ảnh có nét không (phương sai Laplacian)
 *  - findTextRegion(): tự tìm vùng chứa văn bản (các dòng chữ) trong khung
 */

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA (ImageData) → ảnh xám. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) data[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return { data, width, height };
}

/**
 * Độ lệch trung bình (0–255) giữa hai khung cùng kích thước — đo rung/lắc.
 * Nên đo trong vùng chữ (box): nền phẳng chiếm phần lớn khung làm phép đo kém nhạy.
 */
export function motion(a: Gray, b: Gray, box?: Box): number {
  if (a.width !== b.width || a.height !== b.height) return 255;
  const w = a.width;
  const x0 = box ? Math.max(0, Math.floor(box.x)) : 0;
  const y0 = box ? Math.max(0, Math.floor(box.y)) : 0;
  const x1 = box ? Math.min(w, Math.ceil(box.x + box.w)) : w;
  const y1 = box ? Math.min(a.height, Math.ceil(box.y + box.h)) : a.height;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = y * w + x;
      sum += Math.abs(a.data[i] - b.data[i]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** Độ nét: phương sai của Laplacian trong vùng (mặc định cả ảnh). Ảnh nhòe → giá trị thấp. */
export function sharpness(g: Gray, box?: Box): number {
  const { data, width } = g;
  const x0 = Math.max(1, box ? Math.floor(box.x) : 1);
  const y0 = Math.max(1, box ? Math.floor(box.y) : 1);
  const x1 = Math.min(g.width - 2, box ? Math.ceil(box.x + box.w) : g.width - 2);
  const y1 = Math.min(g.height - 2, box ? Math.ceil(box.y + box.h) : g.height - 2);
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      sum += lap;
      sum2 += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export interface TextLine extends Box {
  /** số ô "chữ" trong dòng — độ đậm đặc */
  weight: number;
}

/**
 * Tìm vùng văn bản theo DÒNG CHỮ (giống app quét tài liệu):
 * 1) cạnh ngang |I(x+1) − I(x)| vượt ngưỡng thích nghi → lưới mật độ cạnh
 * 2) mỗi hàng ô: nối khoảng trống ngắn (giữa nhãn và giá trị), lấy các đoạn dài ≥ 3 ô = dòng chữ
 *    (đường viền dọc mảnh, nhiễu lẻ tẻ bị loại vì quá ngắn)
 * 3) gộp đoạn của các hàng ô liền kề thành một dòng; gom các dòng thẳng hàng, cách đều thành khối
 * 4) chọn khối có nhiều dòng nhất (≥ 2 dòng) → hộp bao
 */
export function findTextLines(g: Gray, opts: { cell?: number } = {}): { lines: TextLine[]; cell: number } {
  const { data, width, height } = g;
  const cell = opts.cell ?? Math.max(6, Math.round(Math.min(width, height) / 40));
  const cols = Math.floor(width / cell);
  const rows = Math.floor(height / cell);
  if (cols < 4 || rows < 4) return { lines: [], cell };

  let s = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i += 7) {
    s += data[i];
    s2 += data[i] * data[i];
  }
  const cnt = Math.ceil(data.length / 7);
  const std = Math.sqrt(Math.max(0, s2 / cnt - (s / cnt) ** 2));
  const edgeT = Math.max(18, std * 0.6);

  const mark = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let e = 0;
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        const row = y * width;
        for (let x = cx * cell; x < (cx + 1) * cell - 1; x++) if (Math.abs(data[row + x + 1] - data[row + x]) > edgeT) e++;
      }
      mark[cy * cols + cx] = e / (cell * cell) > 0.06 ? 1 : 0;
    }
  }

  // đoạn ngang theo từng hàng ô:
  //  (a) gom các ô liền nhau (hở ≤ 1 ô) thành "cụm chữ", bỏ cụm 1 ô (viền dọc mảnh, nhiễu)
  //  (b) nối các cụm cách nhau ≤ 25% bề ngang (khoảng giữa nhãn và giá trị)
  const maxGap = Math.max(2, Math.ceil(cols * 0.25));
  type Seg = { row: number; x0: number; x1: number; weight: number };
  const segs: Seg[] = [];
  for (let cy = 0; cy < rows; cy++) {
    const runs: Seg[] = [];
    let cur: Seg | null = null;
    let lastOn = -99;
    for (let cx = 0; cx < cols; cx++) {
      if (!mark[cy * cols + cx]) continue;
      if (cur && cx - lastOn <= 2) {
        cur.x1 = cx;
        cur.weight++;
      } else {
        if (cur) runs.push(cur);
        cur = { row: cy, x0: cx, x1: cx, weight: 1 };
      }
      lastOn = cx;
    }
    if (cur) runs.push(cur);
    let joined: Seg | null = null;
    for (const r of runs.filter((r) => r.weight >= 2)) {
      if (joined && r.x0 - joined.x1 <= maxGap) {
        joined.x1 = r.x1;
        joined.weight += r.weight;
      } else {
        if (joined) segs.push(joined);
        joined = { ...r };
      }
    }
    if (joined) segs.push(joined);
  }
  const longSegs = segs.filter((sg) => sg.weight >= 3 && sg.x1 - sg.x0 + 1 >= 3);

  // gộp đoạn ở các hàng ô liền kề, chồng lấn theo chiều ngang → một dòng chữ
  const lines: (Seg & { row1: number })[] = [];
  for (const sg of longSegs.sort((a, b) => a.row - b.row)) {
    const host = lines.find((l) => sg.row - l.row1 <= 1 && sg.row > l.row - 1 && Math.min(l.x1, sg.x1) - Math.max(l.x0, sg.x0) >= 0);
    if (host) {
      host.row1 = Math.max(host.row1, sg.row);
      host.x0 = Math.min(host.x0, sg.x0);
      host.x1 = Math.max(host.x1, sg.x1);
      host.weight += sg.weight;
    } else {
      lines.push({ ...sg, row1: sg.row });
    }
  }
  return {
    cell,
    lines: lines.map((l) => ({ x: l.x0 * cell, y: l.row * cell, w: (l.x1 - l.x0 + 1) * cell, h: (l.row1 - l.row + 1) * cell, weight: l.weight })),
  };
}

export interface TextRegion extends Box {
  /** chiều cao dòng chữ trung vị (px của ảnh đầu vào) — để tính mức phóng to trước khi OCR */
  lineHeight: number;
  lineCount: number;
}

export function findTextRegion(g: Gray, opts: { cell?: number } = {}): TextRegion | null {
  const { lines, cell } = findTextLines(g, opts);
  if (lines.length < 2) return null;
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  // gom khối: dòng kế tiếp chồng lấn ngang ≥ 40% và cách dòng trước ≤ 6 lần chiều cao dòng
  type Block = { lines: TextLine[]; x0: number; x1: number; y0: number; y1: number };
  const blocks: Block[] = [];
  for (const l of sorted) {
    const b = blocks.find((bk) => {
      const last = bk.lines[bk.lines.length - 1];
      const overlap = Math.min(bk.x1, l.x + l.w) - Math.max(bk.x0, l.x);
      const gap = l.y - (last.y + last.h);
      return overlap >= 0.4 * Math.min(bk.x1 - bk.x0, l.w) && gap <= Math.max(6 * last.h, 4 * cell);
    });
    if (b) {
      b.lines.push(l);
      b.x0 = Math.min(b.x0, l.x);
      b.x1 = Math.max(b.x1, l.x + l.w);
      b.y1 = Math.max(b.y1, l.y + l.h);
    } else {
      blocks.push({ lines: [l], x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h });
    }
  }
  const best = blocks.reduce<Block | null>((a, b) => (!a || b.lines.length > a.lines.length || (b.lines.length === a.lines.length && b.x1 - b.x0 > a.x1 - a.x0) ? b : a), null);
  if (!best || best.lines.length < 2) return null;
  // Gộp các cột nằm CẠNH NHAU cùng hàng (màn hình Giới thiệu: nhãn bên trái, giá trị căn phải cách xa):
  // khối nào có ≥ 2 dòng và chồng lấn theo chiều dọc ≥ 50% với khối chính thì thuộc cùng vùng chữ.
  for (const b of blocks) {
    if (b === best || b.lines.length < 2) continue;
    const vOverlap = Math.min(best.y1, b.y1) - Math.max(best.y0, b.y0);
    if (vOverlap >= 0.5 * Math.min(best.y1 - best.y0, b.y1 - b.y0)) {
      best.x0 = Math.min(best.x0, b.x0);
      best.x1 = Math.max(best.x1, b.x1);
      best.y0 = Math.min(best.y0, b.y0);
      best.y1 = Math.max(best.y1, b.y1);
      best.lines.push(...b.lines);
    }
  }
  const pad = cell;
  const x = Math.max(0, best.x0 - pad);
  const y = Math.max(0, best.y0 - pad);
  const hs = best.lines.map((l) => l.h).sort((a, b) => a - b);
  return {
    x,
    y,
    w: Math.min(g.width - x, best.x1 - best.x0 + 2 * pad),
    h: Math.min(g.height - y, best.y1 - best.y0 + 2 * pad),
    lineHeight: hs[Math.floor(hs.length / 2)],
    lineCount: best.lines.length,
  };
}
