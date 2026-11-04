import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Thư viện chép vào public/ và bản build chạy thử
    "public/wasm/**",
    "public/ocr/**",
    "dist/**",
    "test-results/**",
    ".e2e-fixtures/**",
  ]),
]);

export default eslintConfig;
