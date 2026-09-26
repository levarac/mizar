import { describe, expect, it } from "vitest";
import { parseDeploymentConfig, validateSnapshot } from "./deployment";
import eligible from "./fixtures/evaluator/eligible.json";
import proof0 from "./fixtures/evaluator/proofs/0x4ca63cdf34a0fefffab20834fd69be3b88d5c6de.json";
import proof1 from "./fixtures/evaluator/proofs/0x78488fb96739a6188e7de7219ca0d11e3869b738.json";
import proof2 from "./fixtures/evaluator/proofs/0xc2ce43f3ba566570da3642c1608c1ea83957976d.json";
import proof3 from "./fixtures/evaluator/proofs/0xe1315c4281a2efee4af35b04870e9cef390bd44f.json";

// The contract is pinned; snapshot data remains synthetic.
const config = {
  chainId: 11155111,
  chainName: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  eventId: "0xccb8770a524f4145e04b3c97d8ffe2f7301ce65b4041d80e419bafdd803b2ee1",
  claimContract: "0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC",
  eligibleJsonUrl: "/snapshots/1/eligible.json",
  expectedRoot: proof0.root,
  snapshotId: 1,
};

async function eligibleDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const fixtureDigest = await eligibleDigest(eligible);
const manifest = () => ({
  root: config.expectedRoot,
  parameters: { eventId: config.eventId, chainId: 11155111 },
  outputDigests: { eligible: fixtureDigest },
});

function files(): Record<string, unknown> {
  return {
    "/snapshots/1/manifest.json": manifest(),
    "/snapshots/1/eligible.json": structuredClone(eligible),
    ...Object.fromEntries([proof0, proof1, proof2, proof3].map((proof) => [
      `/snapshots/1/proofs/${proof.address.toLowerCase()}.json`, structuredClone(proof),
    ])),
  };
}

function validate(data: Record<string, unknown>) {
  validateSnapshot(parseDeploymentConfig(config), (path) => data[path], Object.keys(data).filter((path) => path.includes("/proofs/")));
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
    ["claimContract", "0x1234567890123456789012345678901234567890"],
    ["claimContract", config.claimContract.toLowerCase()],
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
  it("accepts complete evaluator eligibility and membership proofs", () => {
    const data = files();
    expect(() => validate(data)).not.toThrow();
  });
  it.each(["manifest.json", "eligible.json", `proofs/${proof0.address.toLowerCase()}.json`])("rejects missing %s", (file) => {
    const data = files();
    delete data[`/snapshots/1/${file}`];
    expect(() => validate(data)).toThrow();
  });
  it.each([
    { root: `0x${"33".repeat(32)}`, parameters: { eventId: config.eventId } },
    { root: config.expectedRoot, parameters: { eventId: `0x${"11".repeat(32)}` } },
  ])("rejects a manifest from another root or event", (manifest) => {
    const data = files();
    data["/snapshots/1/manifest.json"] = manifest;
    expect(() => validate(data)).toThrow("manifest");
  });
  it.each([
    { ...proof0, address: proof1.address },
    { ...proof0, root: `0x${"33".repeat(32)}` },
    { ...proof0, proof: [] },
  ])("rejects mismatched or invalid membership proofs", (proof) => {
    const data = files();
    data[`/snapshots/1/proofs/${proof0.address.toLowerCase()}.json`] = proof;
    expect(() => validate(data)).toThrow(/proof/i);
  });

  it.each([1, undefined, "11155111"])("rejects manifest chainId %s", (chainId) => {
    const data = files();
    data["/snapshots/1/manifest.json"] = { ...manifest(), parameters: { eventId: config.eventId, chainId } };
    expect(() => validate(data)).toThrow("chainId");
  });

  it.each([undefined, "0".repeat(64)])("rejects missing or mismatched eligible digest", (digest) => {
    const data = files();
    data["/snapshots/1/manifest.json"] = { ...manifest(), outputDigests: { eligible: digest } };
    expect(() => validate(data)).toThrow("digest");
  });

  it("rejects modified eligibility explanations even when membership proofs still verify", () => {
    const data = files();
    const changed = structuredClone(eligible);
    changed.explanations[0].partners = [];
    data["/snapshots/1/eligible.json"] = changed;
    expect(() => validate(data)).toThrow("digest");
  });

  it("rejects an unlisted proof even when the reduced eligible list has a matching digest", async () => {
    const data = files();
    const reduced = { addresses: eligible.addresses.slice(1), explanations: eligible.explanations.slice(1) };
    data["/snapshots/1/eligible.json"] = reduced;
    data["/snapshots/1/manifest.json"] = { ...manifest(), outputDigests: { eligible: await eligibleDigest(reduced) } };
    expect(() => validate(data)).toThrow(/unlisted proof/i);
  });

  it.each(["/snapshots/1", "/snapshots/0"])("rejects extra proofs served under %s", (directory) => {
    const data = files();
    data[`${directory}/eligible.json`] = eligible;
    data[`${directory}/proofs/0x1234567890123456789012345678901234567890.json`] = proof0;
    expect(() => validate(data)).toThrow(/unlisted proof/i);
  });

  it("allows retained proofs that are listed in their own snapshot", () => {
    const data = files();
    data["/snapshots/0/eligible.json"] = eligible;
    data[`/snapshots/0/proofs/${proof0.address.toLowerCase()}.json`] = proof0;
    expect(() => validate(data)).not.toThrow();
  });
});
