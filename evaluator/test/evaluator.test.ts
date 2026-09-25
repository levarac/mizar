import { describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { ed25519 } from "@noble/curves/ed25519.js";
import { getBytes, recoverAddress, toBeHex, zeroPadValue } from "ethers";
import { appDigest, appMessage, eventKeyAddress, fromHex, hex, sha } from "../src/codec.js";
import { verifyEvidence, type Envelope } from "../src/evidence.js";
import { deriveRelations, evaluateRule, verifyCredentials, type CredentialList, type Parameters } from "../src/evaluate.js";
import { loadEnvelopes } from "../src/io.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(root, "test/fixtures", name), "utf8")) as T;
const params = fixture<Parameters>("params.json");
const credentials = fixture<CredentialList>("credentials.json");
const pages = fixture<Envelope[]>("envelopes.json");
const anchors = fixture<Record<string, number>>("anchor-blocks.json");
const evidence = verifyEvidence(pages, params.eventId, params.snapshot.cutoffBlock, anchors);
const address = (index: number) => credentials.credentials[index].eventKeyAddress.toLowerCase();
const participantPasses = (result: ReturnType<typeof evaluateRule>, index: number) =>
  result.eligible.some(x => x.address.toLowerCase() === address(index));

describe("golden app signatures", () => {
  const vector = JSON.parse(readFileSync(resolve(root, "../docs/design/test-vectors/app-signature-v1.json"), "utf8"));
  it("matches both exact messages, digests, signer and address", () => {
    expect(eventKeyAddress(fromHex(vector.eventKeyCompressed))).toBe(vector.eventKeyAddress);
    const event = fromHex(vector.eventId);
    const claimBody = Buffer.concat([
      getBytes(zeroPadValue(toBeHex(vector.claim.chainId), 32)),
      fromHex(vector.claim.claimContract),
      fromHex(vector.claim.recipient),
    ]);
    expect("0x" + hex(appMessage(2, event, claimBody))).toBe(vector.claim.message);
    expect("0x" + hex(appDigest(2, event, claimBody))).toBe(vector.claim.digest);
    expect(recoverAddress(vector.claim.digest, vector.claim.signature)).toBe(vector.eventKeyAddress);
    const challenge = fromHex(vector.humanCheckBinding.challenge);
    expect("0x" + hex(appMessage(1, event, challenge))).toBe(vector.humanCheckBinding.message);
    expect("0x" + hex(appDigest(1, event, challenge))).toBe(vector.humanCheckBinding.digest);
    expect(recoverAddress(vector.humanCheckBinding.digest, vector.humanCheckBinding.signature))
      .toBe(vector.eventKeyAddress);
  });
});

describe("fixture evidence and evaluation", () => {
  it("verifies real COSE and inclusion, then drops the tampered signature", () => {
    expect(evidence.observations).toHaveLength(14);
    expect(evidence.invalid).toHaveLength(1);
    expect(evidence.invalid[0].reason).toBe("invalid_signature");
    expect(evidence.commitmentDigests).toHaveLength(1);
    expect(evidence.anchorRange).toEqual({ first: 90, last: 90 });
  });
  it("matches all three pitch counterfactual columns", () => {
    const full = evaluateRule(params, evidence, credentials);
    const noGate = evaluateRule(params, evidence, credentials, { humanGate: false });
    const noEncounter = evaluateRule(params, evidence, credentials, { encounterRequirement: false });
    for (const result of [full, noGate, noEncounter])
      for (const index of [0, 1, 2]) expect(participantPasses(result, index)).toBe(true);
    expect([3, 4, 5].filter(i => participantPasses(full, i))).toHaveLength(1);
    expect([3, 4, 5].filter(i => participantPasses(noGate, i))).toHaveLength(3);
    expect([3, 4, 5].filter(i => participantPasses(noEncounter, i))).toHaveLength(1);
    expect(participantPasses(full, 6)).toBe(false);
    expect(participantPasses(noGate, 6)).toBe(false);
    expect(participantPasses(noEncounter, 6)).toBe(true);
    expect(full.rejected.find(x => x.address.toLowerCase() === address(6))?.reason).toBe("too_few_partners");
    expect(full.rpidConflicts).toHaveLength(1);
    expect(full.rpidConflicts[0].keys).toHaveLength(2);
  });
  it("counts distinct windows per partner and is independent of retries", () => {
    const repeated = deriveRelations([...evidence.observations, evidence.observations[0]]);
    expect([...repeated.pairs].map(([key, windows]) => [key, [...windows].sort()]))
      .toEqual([...deriveRelations(evidence.observations).pairs].map(([key, windows]) => [key, [...windows].sort()]));
    const stricter = evaluateRule({ ...params, minWindowsPerPartner: 3 }, evidence, credentials);
    expect(stricter.eligible).toHaveLength(0);
    expect(stricter.rejected.find(x => x.address.toLowerCase() === address(0))?.reason).toBe("too_few_windows");
  });
  it("fails closed if the trusted block map is absent", () => {
    expect(() => verifyEvidence(pages, params.eventId, params.snapshot.cutoffBlock, {}))
      .toThrow("missing trusted anchor block mapping");
  });
  it("reassembles inner observation continuation before checking the commitment", () => {
    const [original] = structuredClone(pages);
    const first = structuredClone(original), second = structuredClone(original);
    first.commitments[0].inclusions = original.commitments[0].inclusions.slice(0, 7);
    first.observations = original.observations.slice(0, 7);
    first.commitments[0].nextObservationCursor = "6";
    second.commitments[0].inclusions = original.commitments[0].inclusions.slice(7);
    second.observations = original.observations.slice(7);
    second.commitments[0].observationCursor = "6";
    expect(verifyEvidence([first, second], params.eventId, params.snapshot.cutoffBlock, anchors).inputDigests)
      .toEqual(evidence.inputDigests);
    expect(() => verifyEvidence([first], params.eventId, params.snapshot.cutoffBlock, anchors))
      .toThrow("incomplete envelope pagination");
  });
  it("follows the verification-envelope API's inner continuation with fixture responses", async () => {
    const [original] = structuredClone(pages);
    const first = structuredClone(original), second = structuredClone(original);
    first.commitments[0].inclusions = original.commitments[0].inclusions.slice(0, 7);
    first.observations = original.observations.slice(0, 7);
    first.commitments[0].nextObservationCursor = "6";
    second.commitments[0].inclusions = original.commitments[0].inclusions.slice(7);
    second.observations = original.observations.slice(7);
    second.commitments[0].observationCursor = "6";
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      requested.push(String(url));
      return new Response(JSON.stringify(requested.length === 1 ? first : second),
        { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const url = `https://fixture.invalid/v1/events/${params.eventId.slice(2)}/verification`;
      const loaded = await loadEnvelopes(url, root, params.eventId);
      expect(loaded).toHaveLength(2);
      expect(requested[1]).toContain("observationCursor=6");
      expect(verifyEvidence(loaded, params.eventId, params.snapshot.cutoffBlock, anchors).inputDigests)
        .toEqual(evidence.inputDigests);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("Alcor credentials", () => {
  // Exact public fixture emitted by alcor worker at commit 448ab64.
  const producer = fixture<{ testAttestationSeed: string; response: CredentialList }>("alcor-signed-credentials-v1.json");
  const producerParams: Parameters = { ...params, eventId: producer.response.eventId,
    credentialsPublicKey: producer.response.credentials[0].attestation.publicKey,
    snapshot: { ...params.snapshot, cutoffTimestamp: Date.parse("2026-09-26T00:00:00.000Z") / 1000 } };
  it("verifies the pinned Ed25519 key, attestation and app binding", () => {
    const result = verifyCredentials(credentials, params);
    expect(result.accepted.size).toBe(5);
    expect(result.invalid.map(x => x.reason)).toEqual(["duplicate_nullifier_or_key", "duplicate_nullifier_or_key"]);
  });
  it("consumes the exact independently produced Alcor fixture", () => {
    const result = verifyCredentials(producer.response, producerParams);
    expect(result.accepted.size).toBe(1);
    expect(result.invalid).toEqual([]);
  });
  it("rejects producer fixture signature and public-key tampering", () => {
    const signature = structuredClone(producer.response);
    signature.credentials[0].attestation.signature = "0x" + "00".repeat(64);
    expect(verifyCredentials(signature, producerParams).invalid[0].reason).toBe("invalid_attestation_signature");
    const key = structuredClone(producer.response);
    key.credentials[0].attestation.publicKey = "0x" + "00".repeat(32);
    expect(verifyCredentials(key, producerParams).invalid[0].reason).toBe("attestation_public_key_mismatch");
  });
  it("rejects a producer app-signature change even when attestation is re-signed", () => {
    const list = structuredClone(producer.response);
    const entry = list.credentials[0];
    entry.appSignature = "0x" + "00" + entry.appSignature.slice(4);
    const { attestation: _old, ...unsigned } = entry;
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object")
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
      return JSON.stringify(value);
    };
    entry.attestation.signature = "0x" + hex(ed25519.sign(
      Buffer.from("alcor/credential/v1\0" + canonical(unsigned)), fromHex(producer.testAttestationSeed, 32)));
    const result = verifyCredentials(list, producerParams);
    expect(result.accepted.size).toBe(0);
    expect(result.invalid[0].reason).not.toBe("invalid_attestation_signature");
  });
  it.each([
    ["attestation signature", (entry: any) => { entry.attestation.signature = entry.attestation.signature.slice(0, -2) + "00"; }],
    ["app signature", (entry: any) => { entry.appSignature = entry.appSignature.slice(0, -2) + "00"; }],
    ["public key", (entry: any) => { entry.attestation.publicKey = "0x" + "00".repeat(32); }],
  ])("rejects a flipped %s", (_, mutate) => {
    const list = structuredClone(credentials);
    mutate(list.credentials[0]);
    const result = verifyCredentials(list, params);
    expect(result.accepted.has(address(0))).toBe(false);
    expect(result.invalid.some(x => x.address.toLowerCase() === address(0))).toBe(true);
  });
});

describe("OpenZeppelin address-only tree", () => {
  it("matches the shared three-address root and all proof bytes", () => {
    const vector = fixture<{ addresses: string[]; root: string; proofs: Record<string, string[]> }>("merkle-3-address.json");
    const tree = StandardMerkleTree.of(vector.addresses.map(x => [x]), ["address"], { sortLeaves: true });
    expect(tree.root).toBe("0xadad4040c18fafa3fd40fa142d1697b736f0c0b95050ba66ad302f0d2373d8a2");
    expect(tree.root).toBe(vector.root);
    for (const [i, address] of vector.addresses.entries()) {
      expect(tree.getProof(i)).toEqual(vector.proofs[address]);
      expect(StandardMerkleTree.verify(vector.root, ["address"], [address], vector.proofs[address])).toBe(true);
    }
  });
});

describe("CLI receipt", () => {
  it("uses an explicit synthetic pending feed and refuses missing live feed", () => {
    const run = (file: string) => spawnSync("pnpm",
      ["mizar", "progress", "--params", file, "--key", credentials.credentials[0].eventKeyAddress],
      { cwd: root, encoding: "utf8", timeout: 30_000 });
    const fixtureProgress = run("test/fixtures/params.json");
    expect(fixtureProgress.status).toBe(0);
    expect(fixtureProgress.stdout).toContain('"source":"synthetic-pending-fixture"');
    expect(fixtureProgress.stdout).toContain('"reached":true');
    const out = mkdtempSync(join(tmpdir(), "mizar-progress-test-"));
    try {
      const noFeed = join(out, "params.json");
      const { pendingSource: _omitted, ...withoutPending } = params;
      writeFileSync(noFeed, JSON.stringify(withoutPending));
      const unavailable = run(noFeed);
      expect(unavailable.status).toBe(2);
      expect(unavailable.stdout).toContain('"result":"UNAVAILABLE"');
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 30_000);
  it("returns UNAVAILABLE before fetching live evidence without registry mapping", () => {
    const out = mkdtempSync(join(tmpdir(), "mizar-live-test-"));
    try {
      const file = join(out, "params.json");
      writeFileSync(file, JSON.stringify({ ...params,
        evidenceSource: `https://fixture.invalid/v1/events/${params.eventId.slice(2)}/verification`,
        rpcUrl: undefined, commitmentRegistry: undefined }));
      const result = spawnSync("pnpm",
        ["mizar", "evaluate", "--params", file, "--out", join(out, "result")],
        { cwd: root, encoding: "utf8", timeout: 30_000 });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('"result":"UNAVAILABLE"');
      expect(result.stdout).toContain("all three registry addresses");
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 30_000);
  it("writes four output classes, passes, and fails on one-bit input/root changes", () => {
    const out = mkdtempSync(join(tmpdir(), "mizar-eval-test-"));
    const run = (...args: string[]) => spawnSync("pnpm", ["mizar", ...args], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    try {
      const evaluated = run("evaluate", "--params", "test/fixtures/params.json", "--out", out);
      expect(evaluated.status).toBe(0);
      expect(readFileSync(join(out, "eligible.json"), "utf8")).toContain("addresses");
      expect(readFileSync(join(out, "rejected.json"), "utf8")).toContain("invalidObservations");
      expect(readFileSync(join(out, "proofs", credentials.credentials[0].eventKeyAddress.toLowerCase() + ".json"), "utf8"))
        .toContain("proof");
      const manifestPath = join(out, "manifest.json");
      const evaluatedReceipt = JSON.parse(evaluated.stdout.trim().split("\n").at(-1)!);
      expect(evaluatedReceipt.manifestDigest).toBe("0x" + hex(sha(readFileSync(manifestPath))));
      expect(run("verify", "--manifest", manifestPath).stdout).toContain('"result":"PASS"');
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.root = manifest.root.slice(0, -1) + (manifest.root.endsWith("0") ? "1" : "0");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const badRoot = run("verify", "--manifest", manifestPath);
      expect(badRoot.status).toBe(1);
      expect(badRoot.stdout).toContain('"fault":"root_mismatch"');
      manifest.root = evaluateRule(params, evidence, credentials).root;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const inputPath = join(out, "inputs/credentials.json");
      const input = readFileSync(inputPath);
      input[input.indexOf(Buffer.from("signature")) + 12] ^= 1;
      writeFileSync(inputPath, input);
      const badInput = run("verify", "--manifest", manifestPath);
      expect(badInput.status).toBe(1);
      expect(badInput.stdout).toContain('"fault":"invalid_signature"');
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 30_000);
});
