import { defineConfig } from "vite";
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: false,
  build: { outDir: "/private/tmp/claim-ui-preview-dist", emptyOutDir: true },
  plugins: [
    {
      name: "preview-fonts",
      closeBundle() {
        const target = "/private/tmp/claim-ui-preview-dist/fonts";
        mkdirSync(target, { recursive: true });
        cpSync(resolve("public/fonts"), target, { recursive: true });
      },
    },
  ],
  preview: { host: "0.0.0.0", port: 4173, strictPort: true },
});
