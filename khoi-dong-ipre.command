#!/bin/bash
# macOS: bấm đúp để chạy iPre trên máy này + mở qua Cloudflare. Xem docs/08-chay-tai-may-cloudflare.md
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Chưa cài Node.js 22+ — tải ở https://nodejs.org rồi bấm đúp lại."; read -r -p "Nhấn Enter để đóng…"; exit 1
fi
[ -d node_modules ] || npm install || { read -r -p "Cài thư viện lỗi. Nhấn Enter để đóng…"; exit 1; }
npx tsx scripts/chay-tai-may.ts --cloudflare "$@"
read -r -p "iPre đã dừng. Nhấn Enter để đóng…"
