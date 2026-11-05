import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "scripts/rtl-lint.ts",
    target: "node24",
    outDir: "dist-cli",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: "rtl-lint.mjs" },
      external: [/^node:/],
    },
  },
});
