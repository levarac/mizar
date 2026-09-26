import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = resolve(root, "test/fixtures/comparison/params.json");
const temporary: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "mizar-compare-test-"));
  temporary.push(path);
  return path;
};
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args],
  { cwd: root, encoding: "utf8", timeout: 30_000 });

it("writes only a NON-CANONICAL comparison table matching the published example", () => {
  const out = directory();
  const result = run("compare", "--params", fixture, "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(out)).toEqual(["comparison.md"]);
  const report = readFileSync(join(out, "comparison.md"), "utf8");
  expect(result.stdout).toBe(report);
  expect(report).toContain("NON-CANONICAL");
  expect(report).toContain("RECORDED SYNTHETIC");
  expect(report).toContain("| Honest attendees | 3 / 3 | 3 / 3 | 3 / 3 |");
  expect(report).toContain("| Mallory: one human, three phones | 3 / 3 | 1 / 3 | 0 / 3 |");
  expect(report).toContain("| Walk-in: credential, no encounters | 0 / 1 | 1 / 1 | 0 / 1 |");
  expect(report).not.toMatch(/manifest\.json|"proofs"|"root"/);
  const documented = readFileSync(resolve(root, "../docs/demo/comparison.md"), "utf8");
  expect(documented).toContain(report);
}, 30_000);

it("refuses a nonempty output directory without changing its manifest", () => {
  const out = directory(), manifest = join(out, "manifest.json");
  writeFileSync(manifest, "existing snapshot\n");
  const result = run("compare", "--params", fixture, "--out", out);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("NON-CANONICAL");
  expect(readFileSync(manifest, "utf8")).toBe("existing snapshot\n");
  expect(readdirSync(out)).toEqual(["manifest.json"]);
}, 30_000);

it.each(["evidenceSource", "credentialsSource", "anchorBlocksSource", "rpcUrl"])(
  "rejects remote or RPC %s before reading any input or writing outputs", field => {
    const out = directory(), output = join(out, "result"), params = join(out, "params.json");
    writeFileSync(params, JSON.stringify({ ...JSON.parse(readFileSync(fixture, "utf8")),
      [field]: "https://fixture.invalid/never-fetch" }));
    const result = run("compare", "--params", params, "--out", output);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("NON-CANONICAL compare accepts local recorded inputs only");
    expect(existsSync(output)).toBe(false);
  }, 30_000);

it("rejects unknown comparison options instead of silently ignoring them", () => {
  const out = directory();
  const result = run("compare", "--params", fixture, "--out", out, "--rpc", "https://fixture.invalid");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("NON-CANONICAL compare supports only --params and --out");
  expect(readdirSync(out)).toEqual([]);
}, 30_000);

it("compares ordinary local parameters without requiring scenario metadata", () => {
  const out = directory();
  const result = run("compare", "--params", "test/fixtures/params.json", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("RECORDED LOCAL inputs; provenance not independently verified");
  expect(result.stdout).toContain("Invalid observations: 1. Invalid credentials: 2.");
  expect(result.stdout.match(/\| 0x[0-9a-fA-F]{40} \|/g)).toHaveLength(8);
  expect(readdirSync(out)).toEqual(["comparison.md"]);
}, 30_000);

it.each(["omitted", "duplicate", "unknown"])("rejects %s case membership", problem => {
  const out = directory(), output = join(out, "result"), paramsFile = join(out, "params.json");
  const params = JSON.parse(readFileSync(fixture, "utf8"));
  for (const field of ["evidenceSource", "credentialsSource", "anchorBlocksSource"])
    params[field] = resolve(root, "test/fixtures/comparison", params[field]);
  if (problem === "omitted") params.comparison.cases.pop();
  if (problem === "duplicate") params.comparison.cases.push(params.comparison.cases[0]);
  if (problem === "unknown") params.comparison.cases[0].addresses[0] = "0x" + "00".repeat(20);
  writeFileSync(paramsFile, JSON.stringify(params));
  const result = run("compare", "--params", paramsFile, "--out", output);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("NON-CANONICAL comparison cases must name each evaluated address exactly once");
  expect(existsSync(output)).toBe(false);
}, 30_000);

it("preserves exact evaluate and verify receipts and the canonical fixture digest", () => {
  const out = directory();
  const evaluated = run("evaluate", "--params", "test/fixtures/params.json", "--out", out);
  expect(evaluated.status, evaluated.stderr).toBe(0);
  expect(evaluated.stdout).toBe(JSON.stringify({ result: "EVALUATED",
    root: "0x4e663e1d45553efdf5247a720b30f569a340fe2e7c4294501d04608160230fe9",
    eligible: 4, rejected: 4, invalidObservations: 1,
    manifestDigest: "0x1f61fff1d38a9944ad53b6562423d5b9b33f59e067dece272b58087c1077351a", out }) + "\n");
  const verified = run("verify", "--manifest", join(out, "manifest.json"));
  expect(verified.status).toBe(0);
  expect(verified.stdout).toBe('{"result":"PASS"}\n');
}, 30_000);
