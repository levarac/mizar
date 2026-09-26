import { defineConfig } from "vite";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: false,
  build: { outDir: "dist/preview", emptyOutDir: true },
  plugins: [
    {
      name: "preview-fonts",
      closeBundle() {
        const target = "dist/preview/fonts";
        mkdirSync(target, { recursive: true });
        cpSync(resolve("public/fonts"), target, { recursive: true });
      },
    },
  ],
  preview: { host: "0.0.0.0", port: 4173, strictPort: true },
});
