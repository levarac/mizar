import { describe, expect, it } from "vitest";
import { parseDeploymentConfig, validateSnapshot } from "./deployment";
import eligible from "./fixtures/evaluator/eligible.json";
import proof0 from "./fixtures/evaluator/proofs/0x4ca63cdf34a0fefffab20834fd69be3b88d5c6de.json";
import proof1 from "./fixtures/evaluator/proofs/0x78488fb96739a6188e7de7219ca0d11e3869b738.json";
import proof2 from "./fixtures/evaluator/proofs/0xc2ce43f3ba566570da3642c1608c1ea83957976d.json";
import proof3 from "./fixtures/evaluator/proofs/0xe1315c4281a2efee4af35b04870e9cef390bd44f.json";

// Synthetic configuration only; these values do not identify a live deployment.
const config = {
  chainId: 11155111,
  chainName: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  eventId: "0xccb8770a524f4145e04b3c97d8ffe2f7301ce65b4041d80e419bafdd803b2ee1",
  claimContract: "0x1234567890123456789012345678901234567890",
  eligibleJsonUrl: "/snapshots/1/eligible.json",
  expectedRoot: proof0.root,
  snapshotId: 1,
};

function files(): Record<string, unknown> {
  return {
    "/snapshots/1/manifest.json": { root: config.expectedRoot, parameters: { eventId: config.eventId } },
    "/snapshots/1/eligible.json": structuredClone(eligible),
    ...Object.fromEntries([proof0, proof1, proof2, proof3].map((proof) => [
      `/snapshots/1/proofs/${proof.address.toLowerCase()}.json`, structuredClone(proof),
    ])),
  };
}

describe("deployment configuration", () => {
  it("accepts explicit Sepolia settings and snapshot zero", () => {
    expect(parseDeploymentConfig(config)).toEqual(config);
    expect(parseDeploymentConfig({ ...config, snapshotId: 0, eligibleJsonUrl: "/snapshots/0/eligible.json" }).snapshotId).toBe(0);
  });

  it.each(["claimContract", "expectedRoot", "snapshotId", "eligibleJsonUrl"])("rejects an unresolved %s", (field) => {
    expect(() => parseDeploymentConfig({ ...config, [field]: `REPLACE_${field}` })).toThrow(field);
  });

  it.each([
    ["chainId", 1], ["chainName", "Example Chain"],
    ["eventId", `0x${"11".repeat(32)}`],
    ["rpcUrl", "https://private.example/rpc/key"],
    ["claimContract", `0x${"0".repeat(40)}`],
    ["claimContract", `0x${"0".repeat(39)}1`],
    ["expectedRoot", `0x${"00".repeat(32)}`], ["expectedRoot", "0x1234"],
    ["snapshotId", -1], ["snapshotId", 1.5], ["snapshotId", Number.MAX_SAFE_INTEGER + 1],
    ["eligibleJsonUrl", "https://other.example/snapshots/1/eligible.json"],
    ["eligibleJsonUrl", "/snapshots/2/eligible.json"],
    ["eligibleJsonUrl", "/snapshots/1/../eligible.json"],
  ])("rejects invalid %s = %s", (field, value) => {
    expect(() => parseDeploymentConfig({ ...config, [field]: value })).toThrow(field);
  });
});

describe("published snapshot build validation", () => {
  const parsed = () => parseDeploymentConfig(config);
  it("accepts complete evaluator eligibility and membership proofs", () => {
    const data = files();
    expect(() => validateSnapshot(parsed(), (path) => data[path])).not.toThrow();
  });
  it.each(["manifest.json", "eligible.json", `proofs/${proof0.address.toLowerCase()}.json`])("rejects missing %s", (file) => {
    const data = files();
    delete data[`/snapshots/1/${file}`];
    expect(() => validateSnapshot(parsed(), (path) => data[path])).toThrow();
  });
  it.each([
    { root: `0x${"33".repeat(32)}`, parameters: { eventId: config.eventId } },
    { root: config.expectedRoot, parameters: { eventId: `0x${"11".repeat(32)}` } },
  ])("rejects a manifest from another root or event", (manifest) => {
    const data = files();
    data["/snapshots/1/manifest.json"] = manifest;
    expect(() => validateSnapshot(parsed(), (path) => data[path])).toThrow("manifest");
  });
  it.each([
    { ...proof0, address: proof1.address },
    { ...proof0, root: `0x${"33".repeat(32)}` },
    { ...proof0, proof: [] },
  ])("rejects mismatched or invalid membership proofs", (proof) => {
    const data = files();
    data[`/snapshots/1/proofs/${proof0.address.toLowerCase()}.json`] = proof;
    expect(() => validateSnapshot(parsed(), (path) => data[path])).toThrow(/proof/i);
  });
});
