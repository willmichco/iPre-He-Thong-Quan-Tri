import { useState, type DragEvent } from "react";
import { classifyCode } from "@/domain/identifiers";
import { rasterizeImageUrl } from "./decoder";
import { Icon } from "./icons";
import type { ImageResult } from "./types";

/** Hộp gợi ý (thông tin / cảnh báo) dùng chung trong các bảng của bộ quét. */
export function Tip({ tone = "info", children }: { tone?: "info" | "warn"; children: React.ReactNode }) {
  return (
    <p className={`sc-tip ${tone === "warn" ? "is-warn" : ""}`}>
      <Icon name={tone === "warn" ? "warn" : "info"} size={18} />
      <span>{children}</span>
    </p>
  );
}

export function PhotoPanel({
  ready,
  busy,
  hasOcr,
  sampleLabelUrl,
  onImage,
}: {
  ready: boolean;
  busy: boolean;
  hasOcr: boolean;
  sampleLabelUrl?: string;
  onImage: (image: Blob, name: string) => Promise<ImageResult>;
}) {
  const [log, setLog] = useState<{ id: number; name: string; text: string; ok: boolean }[]>([]);
  const [over, setOver] = useState(false);

  const describe = (r: ImageResult) =>
    r.added || r.updated
      ? `${r.barcodes} mã vạch${r.usedOcr ? " + đọc chữ" : ""} → ${r.added} máy mới${r.updated ? `, ${r.updated} máy bổ sung` : ""}`
      : r.barcodes
        ? `${r.barcodes} mã vạch → 0 máy mới (đã có trong danh sách)`
        : hasOcr
          ? "Không thấy mã vạch hay IMEI/Serial — chụp gần hơn, đủ sáng, nhãn phẳng"
          : "Không thấy mã vạch — chụp gần hơn, đủ sáng, nhãn phẳng, tránh loá";

  const run = async (image: Blob, name: string) => {
    const id = Date.now() + Math.random();
    try {
      const r = await onImage(image, name);
      setLog((l) => [{ id, name, text: describe(r), ok: r.added + r.updated > 0 }, ...l].slice(0, 30));
    } catch {
      setLog((l) => [{ id, name, text: "Không mở được ảnh này", ok: false }, ...l].slice(0, 30));
    }
  };

  const handleFiles = async (files: FileList | File[] | null) => {
    // loại tệp không phải ảnh khi kéo thả (ảnh HEIC trên vài trình duyệt không có type → vẫn thử đọc)
    const list = Array.from(files ?? []).filter((f) => !f.type || f.type.startsWith("image/"));
    for (const file of list) await run(file, file.name || `anh-${Date.now()}.jpg`);
  };

  // kéo thả ảnh từ máy tính vào khung
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (ready) void handleFiles(e.dataTransfer.files);
  };

  return (
    <section className="sc-panel">
      <div
        className={`sc-drop ${over ? "is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <span className="sc-drop-icon" aria-hidden>
          <Icon name="image" size={26} />
        </span>
        <p className="sc-drop-title">Chụp hoặc chọn ảnh nhãn hộp, ảnh chụp màn hình</p>
        <div className="sc-row sc-row-center">
          <label className={`sc-btn sc-btn-primary ${!ready ? "is-disabled" : ""}`}>
            <Icon name="camera" size={18} />
            Chụp ảnh
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              disabled={!ready}
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <label className={`sc-btn ${!ready ? "is-disabled" : ""}`}>
            <Icon name="upload" size={18} />
            Chọn ảnh
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={!ready}
              data-testid="photo-input"
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <p className="sc-drop-sub">Kéo thả ảnh vào đây — được nhiều ảnh một lượt</p>
      </div>

      <div className="sc-paste">
        <Icon name="paste" size={18} />
        <div
          className="sc-paste-zone"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label="Vùng dán ảnh hoặc mã"
          inputMode="none"
          onInput={(e) => (e.currentTarget.textContent = "")}
        >
          Chạm vào đây → <b>Dán</b> ảnh chụp màn hình hoặc mã đã sao chép
        </div>
      </div>

      <Tip>
        Chọn ảnh là <b>tự đọc ngay</b>: mã vạch trên nhãn hộp
        {hasOcr ? (
          <>
            , và chữ trên ảnh chụp màn hình <b>Cài đặt › Cài đặt chung › Giới thiệu</b> (IMEI, Số sê-ri, Số kiểu máy)
          </>
        ) : null}
        . Ảnh không rời khỏi máy của bạn.
      </Tip>

      {sampleLabelUrl && (
        <div className="sc-sample">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sampleLabelUrl} alt="Nhãn hộp mẫu với mã vạch Part No., Serial, IMEI và UPC" />
          <div>
            <p>
              <b>Chưa có hộp máy?</b> Thử với nhãn mẫu (2 máy, số liệu minh hoạ).
            </p>
            <button type="button" className="sc-btn" disabled={!ready || busy} onClick={async () => run(await rasterizeImageUrl(sampleLabelUrl), "Nhãn mẫu")}>
              <Icon name="sparkle" size={18} />
              Thử với nhãn mẫu
            </button>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <ul className="sc-log" aria-label="Kết quả đọc ảnh">
          {log.map((l) => (
            <li key={l.id} className={l.ok ? "is-ok" : "is-bad"}>
              <Icon name={l.ok ? "check" : "warn"} size={16} />
              <span>
                <b>{l.name}</b>: {l.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ManualPanel({ onText, onAddBlank }: { onText: (text: string) => number; onAddBlank: () => void }) {
  const [code, setCode] = useState("");
  const [text, setText] = useState("");

  /** Ô nhập một mã: IMEI (có số kiểm tra) hoặc Part No. đủ mẫu là tự thêm; mã khác bấm Enter. */
  const onCodeChange = (value: string) => {
    const c = classifyCode(value);
    if (c.kind === "IMEI" || c.kind === "PART_NUMBER") {
      onText(c.value);
      setCode("");
    } else {
      setCode(value);
    }
  };

  return (
    <section className="sc-panel sc-manual">
      <label className="sc-field">
        <span className="sc-label">Nhập một mã — IMEI đủ 15 số hợp lệ sẽ tự thêm; Serial thì bấm Enter</span>
        <span className="sc-input-wrap">
          <Icon name="barcode" size={20} />
          <input
            className="sc-input sc-input-lg"
            value={code}
            placeholder="IMEI, Serial hoặc Part No."
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
            onChange={(e) => onCodeChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code.trim()) {
                onText(code);
                setCode("");
              }
            }}
          />
        </span>
      </label>
      <label className="sc-field">
        <span className="sc-label">Hoặc dán danh sách (Excel, email, tin nhắn, ảnh chụp màn hình) — tự nhận diện khi dán</span>
        <textarea
          className="sc-input sc-textarea"
          rows={3}
          value={text}
          placeholder={"F2LXQ7Y9KD\t350000000000006\tMDEM1LL/A\nC02XL0GTJGH5, 350000000000014"}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="sc-row">
        <button
          type="button"
          className="sc-btn sc-btn-primary"
          disabled={!text.trim()}
          onClick={() => {
            onText(text);
            setText("");
          }}
        >
          <Icon name="check" size={18} />
          Thêm từ văn bản đã gõ
        </button>
        <button type="button" className="sc-btn" onClick={onAddBlank}>
          <Icon name="plus" size={18} />
          Thêm máy trống, nhập từng ô
        </button>
      </div>
      <Tip>Có máy quét mã vạch USB/Bluetooth? Cứ quét khi đang ở trang này (không cần bấm vào ô nào) — mã sẽ tự vào đúng ô.</Tip>
    </section>
  );
}
