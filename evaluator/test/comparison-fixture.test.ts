import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { evaluateRule, verifyCredentials, type CredentialList, type Parameters } from "../src/evaluate.js";
import { verifyEvidence, type Envelope } from "../src/evidence.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = (name: string) => resolve(root, "test/fixtures", name);
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

it("regenerates every default fixture byte unchanged", () => {
  const out = mkdtempSync(resolve(tmpdir(), "mizar-original-fixtures-"));
  temporary.push(out);
  const generated = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/generate.ts", "--out", out],
    { cwd: root, encoding: "utf8", timeout: 30_000 });
  expect(generated.status, generated.stderr).toBe(0);
  for (const name of ["params.json", "credentials.json", "envelopes.json", "anchor-blocks.json",
    "pending.json", "merkle-3-address.json"])
    expect(readFileSync(resolve(out, name))).toEqual(readFileSync(path(name)));
}, 30_000);

it("records an isolated three-phone group without changing the original fixtures", () => {
  const originals = ["params.json", "credentials.json", "envelopes.json", "anchor-blocks.json",
    "pending.json", "merkle-3-address.json"];
  const before = originals.map(name => readFileSync(path(name)));
  const out = mkdtempSync(resolve(tmpdir(), "mizar-comparison-fixtures-"));
  temporary.push(out);
  const json = <T>(name: string) => JSON.parse(readFileSync(resolve(out, name), "utf8")) as T;
  const generated = spawnSync(process.execPath,
    ["--import", "tsx", "test/fixtures/generate.ts", "--comparison", "--out", out],
    { cwd: root, encoding: "utf8", timeout: 30_000 });
  expect(generated.status, generated.stderr).toBe(0);
  originals.forEach((name, i) => expect(readFileSync(path(name))).toEqual(before[i]));
  expect(existsSync(resolve(out, "params.json"))).toBe(true);
  for (const name of ["params.json", "credentials.json", "envelopes.json", "anchor-blocks.json"])
    expect(readFileSync(resolve(out, name))).toEqual(readFileSync(path("comparison/" + name)));
  const params = json<Parameters & { comparison: { provenance: string;
    cases: Array<{ label: string; addresses: string[] }> } }>("params.json");
  expect(params.comparison.provenance).toBe("recorded-synthetic");
  const credentials = json<CredentialList>("credentials.json");
  const evidence = verifyEvidence(json<Envelope[]>("envelopes.json"), params.eventId,
    params.snapshot.cutoffBlock, json<Record<string, number>>("anchor-blocks.json"));
  expect(evidence.invalid).toEqual([]);
  expect(evidence.observations).toHaveLength(12);
  expect(verifyCredentials(credentials, params).invalid).toEqual([]);
  expect(credentials.credentials).toHaveLength(5);
  const results = [{ humanGate: false }, { encounterRequirement: false }, {}]
    .map(options => evaluateRule(params, evidence, credentials, options));
  const counts = params.comparison.cases.map(group => results.map(result =>
    result.eligible.filter(entry => group.addresses.includes(entry.address)).length));
  expect(counts).toEqual([[3, 3, 3], [3, 1, 0], [0, 1, 0]]);
  const mallory = params.comparison.cases[1].addresses;
  expect(credentials.credentials.filter(entry => mallory.includes(entry.eventKeyAddress))).toHaveLength(1);
  const walkIn = params.comparison.cases[2].addresses[0];
  expect(results[2].rejected.find(entry => entry.address === walkIn)?.reason).toBe("too_few_partners");
}, 30_000);
