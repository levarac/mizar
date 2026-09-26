import { defineConfig } from "vitest/config";
import { readdirSync, readFileSync } from "node:fs";
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
      const config = parseDeploymentConfig(readJson("claim-config.json"));
      const proofPaths = readdirSync(publicDirectory, { recursive: true, encoding: "utf8" })
        .filter((path) => path.includes("/proofs/") && path.endsWith(".json"))
        .map((path) => `/${path}`);
      validateSnapshot(config, readJson, proofPaths);
    },
  }],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
