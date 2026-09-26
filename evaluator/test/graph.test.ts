import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

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
  const baseline = directory(), out = directory();
  const ref = "a07469bd3692751a9738d166800fc4d841cf9794";
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "evaluator/src"],
    { cwd: resolve(root, ".."), encoding: "utf8" }).trim().split("\n");
  for (const file of files) {
    const target = join(baseline, file.replace(/^evaluator\//, ""));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync("git", ["show", `${ref}:${file}`], { cwd: root }));
  }
  writeFileSync(join(baseline, "package.json"), '{"type":"module"}');
  symlinkSync(resolve(root, "node_modules"), join(baseline, "node_modules"), "dir");
  const args = ["evaluate", "--params", resolve(root, "test/fixtures/params.json"), "--out", out];
  const oldRun = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...a],
    { cwd: baseline, encoding: "utf8", timeout: 30_000 });
  const previous = oldRun(...args);
  expect(previous.status, previous.stderr).toBe(0);
  const receipt = JSON.parse(previous.stdout);
  expect(receipt.root).toBe("0x4e663e1d45553efdf5247a720b30f569a340fe2e7c4294501d04608160230fe9");
  expect(receipt.manifestDigest).toBe("0x1f61fff1d38a9944ad53b6562423d5b9b33f59e067dece272b58087c1077351a");
  const readTree = (dir: string): Record<string, Buffer> => Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => {
      const path = join(f.parentPath, f.name);
      return [path.slice(dir.length + 1), readFileSync(path)];
    }));
  const bytes = readTree(out);
  const beforeVerify = oldRun("verify", "--manifest", join(out, "manifest.json"));
  expect(beforeVerify.status).toBe(0);
  expect(beforeVerify.stdout).toBe('{"result":"PASS"}\n');
  rmSync(out, { recursive: true });
  const current = run(...args);
  expect(current.status, current.stderr).toBe(0);
  expect(current.stdout).toBe(previous.stdout);
  expect(readTree(out)).toEqual(bytes);
  const afterVerify = run("verify", "--manifest", join(out, "manifest.json"));
  expect(afterVerify.status).toBe(beforeVerify.status);
  expect(afterVerify.stdout).toBe(beforeVerify.stdout);
}, 30_000);
