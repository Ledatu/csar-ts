import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "server-drain": "src/server/drain.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  target: "es2020",
  outDir: "dist",
  external: ["axios", "jose"],
});
