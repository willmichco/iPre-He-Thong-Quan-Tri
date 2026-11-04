import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      // kiểm thử logic thuần — không cần CSDL
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      // kiểm thử tích hợp với PostgreSQL thật (DATABASE_URL, đã migrate + seed) — mỗi ca chạy trong transaction rồi huỷ
      { extends: true, test: { name: "db", include: ["tests/integration/**/*.test.ts"], fileParallelism: false } },
    ],
    coverage: {
      provider: "v8",
      // Bộ máy tính giá vốn phải đạt ≥ 95% độ phủ (tài liệu 04, mục 9) — CI chặn nếu tụt
      include: ["src/domain/costing/**"],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
      reporter: ["text-summary", "text"],
    },
  },
});
