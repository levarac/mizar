import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = resolve(root, "test/fixtures/comparison/params.json");
const temporary: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "evaluation-graph-test-"));
  temporary.push(path);
  return path;
};
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args],
  { cwd: root, encoding: "utf8", timeout: 30_000 });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

it("exports synthetic outcomes and replays the actual rule as mutual windows accumulate", () => {
  const out = directory();
  const result = run("graph", "--params", fixture, "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(out)).toEqual(["graph.json"]);
  const graph = json(join(out, "graph.json"));
  expect(graph.kind).toBe("NON-CANONICAL");
  expect(graph.provenance).toBe("recorded-synthetic");
  expect(graph.rule).toEqual({ minPartners: 2, minWindowsPerPartner: 2, slotSeconds: 300 });
  expect(graph.nodes).toHaveLength(7);
  const cases = json(fixture).comparison.cases;
  const members = (i: number) => graph.nodes.filter((n: any) => cases[i].addresses.includes(n.address));
  expect(members(0).map((n: any) => n.status)).toEqual(["passed", "passed", "passed"]);
  expect(members(1).filter((n: any) => n.credentialed)).toHaveLength(1);
  expect(members(1).map((n: any) => n.status).sort()).toEqual([
    "credentialed_not_passed", "not_credentialed", "not_credentialed",
  ]);
  expect(members(2)[0]).toMatchObject({ status: "no_qualifying_partner", partnerCount: 0 });
  expect(graph.edges).toHaveLength(6);
  expect(graph.edges.every((e: any) => JSON.stringify(e.windows) === "[1,2]")).toBe(true);
  expect(graph.edges.filter((e: any) => e.counted)).toHaveLength(3);
  expect(graph.frames.map((f: any) => f.slot)).toEqual([null, 1, 2]);
  expect(graph.frames[0].edges).toEqual([]);
  expect(graph.frames[1].nodes.filter((n: any) => n.status === "passed")).toHaveLength(0);
  expect(graph.frames[1].nodes.filter((n: any) => n.partnerCount === 2)).toHaveLength(3);
  expect(graph.frames[2].nodes).toEqual(graph.nodes);
  expect(graph).not.toHaveProperty("root");
  expect(graph).not.toHaveProperty("proofs");
  expect(graph).not.toHaveProperty("manifest");
  const second = directory();
  expect(run("graph", "--params", fixture, "--out", second).status).toBe(0);
  expect(readFileSync(join(second, "graph.json"))).toEqual(readFileSync(join(out, "graph.json")));
}, 30_000);

it("uses archived local inputs and checks eligible and rejected results", () => {
  const archive = directory(), out = directory();
  expect(run("evaluate", "--params", "test/fixtures/params.json", "--out", archive).status).toBe(0);
  // Archived parameters can retain remote source hints. They must never be followed.
  const paramsPath = join(archive, "inputs/params.json"), params = json(paramsPath);
  params.evidenceSource = "https://fixture.invalid/never-fetch";
  writeFileSync(paramsPath, JSON.stringify(params));
  expect(run("graph", "--snapshot", archive, "--out", out).status).toBe(0);
  const graph = json(join(out, "graph.json"));
  expect(graph.nodes.filter((n: any) => n.status === "passed")).toHaveLength(4);
  expect(graph.nodes.filter((n: any) => n.status === "excluded_duplicate")).toHaveLength(2);
  writeFileSync(join(archive, "eligible.json"), '{"addresses":[],"explanations":[]}');
  const mismatch = run("graph", "--snapshot", archive, "--out", directory());
  expect(mismatch.status).toBe(2);
  expect(mismatch.stderr).toContain("snapshot outputs differ");
}, 30_000);

it.each(["evidenceSource", "credentialsSource", "anchorBlocksSource", "rpcUrl"])(
  "refuses remote or RPC %s before reading inputs", field => {
    const out = directory(), paramsPath = join(out, "params.json");
    writeFileSync(paramsPath, JSON.stringify({ ...json(fixture), [field]: "https://fixture.invalid/never-fetch" }));
    const result = run("graph", "--params", paramsPath, "--out", join(out, "output"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("graph accepts local recorded inputs only");
  }, 30_000);

it("refuses RPC flags and nonempty output directories", () => {
  const out = directory();
  const rpc = run("graph", "--params", fixture, "--out", out, "--rpc", "http://localhost:8545");
  expect(rpc.status).toBe(2);
  expect(rpc.stderr).toContain("graph supports only");
  writeFileSync(join(out, "manifest.json"), "keep\n");
  const occupied = run("graph", "--params", fixture, "--out", out);
  expect(occupied.status).toBe(2);
  expect(occupied.stderr).toContain("empty output directory");
  expect(readdirSync(out)).toEqual(["manifest.json"]);
  expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe("keep\n");
}, 30_000);

it("keeps every evaluate file and both CLI receipts byte-identical to main a07469b", () => {
  const out = directory();
  const baseline = json(resolve(root, "test/fixtures/graph-baseline-a07469b.json"));
  expect(baseline.baselineCommit).toBe("a07469bd3692751a9738d166800fc4d841cf9794");
  expect(Object.keys(baseline.files)).toHaveLength(11);
  const current = run("evaluate", "--params", baseline.input, "--out", out);
  expect(current.status, current.stderr).toBe(baseline.evaluate.exitCode);
  // Normalize only the output directory, which varies between test runs.
  expect(current.stdout.replace(JSON.stringify(out), JSON.stringify("<OUTPUT_DIRECTORY>")))
    .toBe(baseline.evaluate.stdout);
  expect(current.stderr).toBe(baseline.evaluate.stderr);
  const hashes = Object.fromEntries(readdirSync(out, { recursive: true, withFileTypes: true })
    .filter(file => file.isFile()).map(file => {
      const path = join(file.parentPath, file.name);
      return [relative(out, path).split(sep).join("/"), createHash("sha256").update(readFileSync(path)).digest("hex")];
    }));
  expect(hashes).toEqual(baseline.files);
  const verified = run("verify", "--manifest", join(out, "manifest.json"));
  expect(verified.status, verified.stderr).toBe(baseline.verify.exitCode);
  expect(verified.stdout).toBe(baseline.verify.stdout);
  expect(verified.stderr).toBe(baseline.verify.stderr);
}, 30_000);
