import Link from "next/link";
import { Glyph } from "./Glyph";

/** Cuối trang chi tiết: mở nhật ký thay đổi của đúng đối tượng này. */
export function HistoryLink({ id }: { id: string }) {
  return (
    <p className="mt-6 flex justify-end">
      <Link href={`/cai-dat/nhat-ky?id=${id}`} className="link-quiet">
        <Glyph name="history" size={15} />
        Lịch sử thay đổi
      </Link>
    </p>
  );
}
