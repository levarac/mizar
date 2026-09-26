import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as evidenceModule from "../src/evidence.js";
import { evaluateRule, type CredentialList, type Parameters } from "../src/evaluate.js";
import { graph } from "../src/graph.js";

it("never shows PASS for keys invalidated by a later RPID conflict", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/comparison/", import.meta.url));
  const json = async (name: string) => JSON.parse(await readFile(join(fixture, name), "utf8"));
  const params = await json("params.json") as Parameters;
  const credentials = await json("credentials.json") as CredentialList;
  const prefix = evidenceModule.verifyEvidence(await json("envelopes.json"), params.eventId,
    params.snapshot.cutoffBlock, await json("anchor-blocks.json"));
  const victim = prefix.observations.find(o => o.enin === 1 &&
    o.observer === credentials.credentials[0].eventKey.replace(/^0x/, ""))!;
  expect(victim).toBeDefined();
  // Start with verified fixture observations, then inject a late conflict at the
  // verified-evidence boundary. Relation derivation and evaluation stay real.
  const evidence = { ...prefix, observations: [...prefix.observations, { ...victim,
    digest: "ee".repeat(32), enin: 3, observed: [],
    observer: credentials.credentials[1].eventKey.replace(/^0x/, "") }] };
  expect(evaluateRule(params, prefix, credentials).eligible).toHaveLength(3);
  const final = evaluateRule(params, evidence, credentials);
  expect(final.rpidConflicts).toHaveLength(1);
  expect(final.eligible).toHaveLength(0);
  const out = await mkdtemp(join(tmpdir(), "graph-late-conflict-"));
  const verify = vi.spyOn(evidenceModule, "verifyEvidence").mockReturnValue(evidence);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await graph({ params: join(fixture, "params.json") }, out);
    expect(verify).toHaveBeenCalledOnce();
    const exported = JSON.parse(await readFile(join(out, "graph.json"), "utf8"));
    expect(exported.frames.map((frame: any) => frame.slot)).toEqual([null, 1, 2, 3]);
    const earlier = exported.frames[2];
    expect(earlier.nodes.filter((node: any) => node.qualifyingPartners === 2)).toHaveLength(3);
    expect(earlier.nodes.filter((node: any) => node.status === "passed")).toHaveLength(0);
    expect(earlier.nodes.filter((node: any) => node.qualifyingPartners === 2)
      .every((node: any) => node.status === "credentialed_not_passed" && node.reason !== null)).toBe(true);
    expect(exported.frames.every((frame: any) => frame.nodes.every((node: any) => node.status !== "passed"))).toBe(true);
    expect(exported.frames[3].nodes).toEqual(exported.nodes);
  } finally {
    verify.mockRestore(); log.mockRestore();
    await rm(out, { recursive: true, force: true });
  }
});
