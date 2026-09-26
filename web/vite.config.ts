import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDeploymentConfig, validateSnapshot } from "./src/deployment";

export default defineConfig({
  plugins: [{
    name: "validate-claim-deployment",
    apply: "build",
    buildStart() {
      const publicDirectory = new URL("./public/", import.meta.url);
      const readJson = (path: string) => JSON.parse(readFileSync(
        fileURLToPath(new URL(path.replace(/^\//, ""), publicDirectory)), "utf8",
      ));
      validateSnapshot(parseDeploymentConfig(readJson("claim-config.json")), readJson);
    },
  }],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
