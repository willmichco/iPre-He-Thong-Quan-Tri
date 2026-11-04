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
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // Bộ máy tính giá vốn phải đạt ≥ 95% độ phủ (tài liệu 04, mục 9) — CI chặn nếu tụt
      include: ["src/domain/costing/**"],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
      reporter: ["text-summary", "text"],
    },
  },
});
