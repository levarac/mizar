// Deterministic TEST VECTORS ONLY. Every private key is SHA-256 of a published label.
// These keys must never hold funds or be used outside fixtures.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AbiCoder, SigningKey, keccak256 } from "ethers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { bindingDigest, coseSign, domain, encode, eventKeyAddress, hex, sha } from "../../src/codec.js";
import { commitmentDigest, definitionDigest, evidenceRoot, inclusionPath, keySetDigest,
  observationDigest, operatorId } from "../../src/evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
const comparison = process.argv.includes("--comparison");
const outputIndex = process.argv.indexOf("--out");
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error("--out requires a directory");
const output = outputIndex !== -1 ? resolve(process.argv[outputIndex + 1])
  : comparison ? join(here, "comparison") : here;
const key = (label: string) => sha(Buffer.from("Mizar public deterministic TEST KEY: " + label));
const pub = (label: string) => Buffer.from(secp256k1.getPublicKey(key(label), true));
const hex0 = (b: Uint8Array) => "0x" + hex(b);
const media = {
  observation: "application/vnd.levarac.observation+cbor",
  definition: "application/vnd.levarac.event-definition+cbor",
  commitment: "application/vnd.levarac.observation-commitment+cbor",
  receipt: "application/vnd.levarac.inclusion-receipt+cbor",
};
const registrar = Buffer.from("11".repeat(20), "hex");
const operator = Buffer.from("22".repeat(20), "hex");
const keyset = encode(new Map<number, unknown>([[1, 1], [2, [pub("authority")]], [3, 1]]));
const keysetHash = Buffer.from(keySetDigest(keyset), "hex");
const nonce = sha(Buffer.from("Mizar fixture nonce"));
const eventId = Buffer.from(keccak256(Buffer.concat([
  Buffer.from(keccak256(Buffer.from("levarac:event:v1")).slice(2), "hex"),
  Buffer.from(AbiCoder.defaultAbiCoder().encode(["address"], [hex0(registrar)]).slice(2), "hex"),
  Buffer.from(AbiCoder.defaultAbiCoder().encode(["address"], [hex0(operator)]).slice(2), "hex"),
  nonce, keysetHash,
])).slice(2), "hex");
const from = 1_800_000_000, until = from + 86_400;
const receiptKey = pub("operator");
const definitionPayload = encode(new Map<number, unknown>([
  [1, 1], [2, eventId], [3, registrar], [4, operator], [5, nonce], [6, keysetHash],
  [7, 1], [8, Buffer.alloc(32)], [9, receiptKey], [10, operatorId(receiptKey)],
  [11, "https://fixture.invalid/v1/observations"], [12, from], [13, until],
]));
const signedDefinition = coseSign(definitionPayload, key("authority"), media.definition);
const defDigest = Buffer.from(definitionDigest(signedDefinition), "hex");
const rpid = (label: string, window: number) =>
  Buffer.concat([Buffer.from([1]), sha(Buffer.from(`Mizar fixture RPID: ${label}:${window}`)).subarray(0, 16)]);
const names = ["A", "B", "C", "M1", "M2", "M3"] as const;
function observation(label: string, window: number, own: Buffer, heard: Buffer[], salt = ""): Buffer {
  const payload = encode(new Map<number, unknown>([
    [1, defDigest], [2, window], [3, heard.sort(Buffer.compare)],
    [4, null], [5, null],
  ]));
  const id = sha(Buffer.from(`Mizar observation: ${label}:${window}:${salt}`)).subarray(0, 16);
  const body = encode(new Map<number, unknown>([
    [1, 1], [2, id], [3, "levarac.mutual-sensing/v1"], [4, eventId],
    [5, pub(label)], [6, from + window * 60], [7, own], [8, payload],
  ]));
  return coseSign(body, key(label), media.observation);
}
const signed: Buffer[] = [];
for (const window of [1, 2]) {
  for (const label of names) {
    const heard = names.filter(other => other !== label &&
      (!comparison || other.startsWith("M") === label.startsWith("M")))
      .map(other => rpid(other, window));
    signed.push(observation(label, window, rpid(label, window), heard));
  }
}
if (!comparison) {
  signed.push(observation("C", 99, rpid("C", 99), []));
  signed.push(observation("S", 99, rpid("C", 99), [])); // RPID squatter
  const tampered = observation("T", 100, rpid("T", 100), []);
  tampered[tampered.length - 1] ^= 1; // valid CBOR and inclusion, invalid ES256K signature
  signed.push(tampered);
}
const ordered = signed.map(b => ({ bytes: b, digest: observationDigest(b) }))
  .sort((a, b) => a.digest.localeCompare(b.digest));
const digests = ordered.map(x => x.digest);
const bundle = encode(new Map<number, unknown>([
  [1, 1], [2, eventId], [3, 1], [4, ordered.map(x => x.bytes)],
  [5, []], [6, keyset], [7, [signedDefinition]],
]));
const commitmentPayload = encode(new Map<number, unknown>([
  [1, 1], [2, operatorId(receiptKey)], [3, eventId], [4, 1], [5, Buffer.alloc(32)],
  [6, from + 10_000], [7, evidenceRoot(digests)], [8, digests.length],
  [9, sha(bundle)], [10, bundle.length], [11, from + 10_001], [12, from + 12_000],
]));
const signedCommitment = coseSign(commitmentPayload, key("operator"), media.commitment);
const commitmentHash = commitmentDigest(signedCommitment);
const inclusions = ordered.map((x, i) => {
  const payload = encode(new Map<number, unknown>([
    [1, 1], [2, operatorId(receiptKey)], [3, Buffer.from(x.digest, "hex")],
    [4, Buffer.from(commitmentHash, "hex")], [5, digests.length], [6, i],
    [7, inclusionPath(digests, i)], [8, from + 10_002],
  ]));
  return { observationDigest: x.digest,
    signedReceipt: coseSign(payload, key("operator"), media.receipt).toString("base64") };
});
const envelope = {
  version: 1, context: hex(eventId), operatorPublicKey: receiptKey.toString("base64"),
  admission: {
    signedDefinition: signedDefinition.toString("base64"), encodedKeySet: keyset.toString("base64"),
    anchorRegistration: { eventId: hex(eventId), registrar: hex(registrar), operator: hex(operator),
      keySetDigest: hex(keysetHash), registeredAt: from - 100 },
    definitionAnchor: { eventId: hex(eventId), sequence: 1, previousDefinitionDigest: "00".repeat(32),
      definitionDigest: hex(defDigest), validFrom: from, validUntil: until, anchoredAt: from - 50 },
  },
  page: { cursor: null, nextCursor: null, limit: 16 },
  commitments: [{
    signedCommitment: signedCommitment.toString("base64"), bundle: null,
    anchor: { eventId: hex(eventId), sequence: 1, previousCommitmentDigest: "00".repeat(32),
      commitmentDigest: commitmentHash, committedAt: from + 10_001 },
    inclusions, observationCursor: null, nextObservationCursor: null,
  }],
  observations: ordered.map(x => ({ observationDigest: x.digest, signedObservation: x.bytes.toString("base64") })),
};
const participants = ["A", "B", "C", "M1", "M2", "M3", "D"] as const;
const attestationSeed = key("Alcor Ed25519 attestation");
const credentialsPublicKey = hex0(ed25519.getPublicKey(attestationSeed));
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
const credentials = participants.map((label, i) => {
  const challenge = sha(Buffer.from("Mizar challenge: " + label));
  const digest = bindingDigest(eventId, challenge);
  const signature = new SigningKey(hex0(key(label))).sign(hex0(digest)).serialized;
  const unsigned = {
    eventKey: hex0(pub(label)), eventKeyAddress: eventKeyAddress(pub(label)),
    nullifierHash: label.startsWith("M") ? "0x" + "ab".repeat(32) : hex0(sha(Buffer.from("Mizar nullifier: " + label))),
    verifiedAt: new Date((from + i) * 1000).toISOString(), challenge: hex0(challenge), appSignature: signature,
    proofDigest: hex0(sha(Buffer.from("Mizar synthetic proof: " + label))),
  };
  const message = Buffer.from("alcor/credential/v1\0" + canonical(unsigned));
  return { ...unsigned, attestation: {
    algorithm: "Ed25519" as const, publicKey: credentialsPublicKey,
    signature: hex0(ed25519.sign(message, attestationSeed)),
  } };
}).filter((_, i) => !comparison || ![4, 5].includes(i));
const params = {
  evaluatorVersion: "mizar-eval/1", eventId: hex0(eventId), chainId: 11155111,
  minPartners: 2, minWindowsPerPartner: 2,
  credentialsPublicKey,
  evidenceSource: "envelopes.json", credentialsSource: "credentials.json",
  anchorBlocksSource: "anchor-blocks.json",
  ...(!comparison ? { pendingSource: "pending.json" } : { comparison: {
    provenance: "recorded-synthetic",
    cases: [
      { label: "Honest attendees", addresses: ["A", "B", "C"].map(label => eventKeyAddress(pub(label))) },
      { label: "Mallory: one human, three phones", addresses: ["M1", "M2", "M3"].map(label => eventKeyAddress(pub(label))) },
      { label: "Walk-in: credential, no encounters", addresses: [eventKeyAddress(pub("D"))] },
    ],
  } }),
  snapshot: { id: 1, cutoffBlock: 100, cutoffTimestamp: from + 10_001 },
};
const threeAddresses = ["A", "B", "C"].map(label => eventKeyAddress(pub(label)))
  .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
const threeTree = StandardMerkleTree.of(threeAddresses.map(address => [address]), ["address"], { sortLeaves: true });
const threeAddressVector = {
  description: "Deterministic TEST VECTOR ONLY: OpenZeppelin StandardMerkleTree address leaves, default hash sorting",
  addresses: threeAddresses, root: threeTree.root,
  proofs: Object.fromEntries(threeAddresses.map((address, i) => [address, threeTree.getProof(i)])),
};
mkdirSync(output, { recursive: true });
for (const [name, value] of Object.entries({
  "envelopes.json": [envelope], "credentials.json": { eventId: params.eventId, credentials },
  "anchor-blocks.json": { [commitmentHash]: 90 }, "params.json": params,
  ...(!comparison ? { "pending.json": { kind: "synthetic-pending-fixture", eventId: params.eventId,
    evidenceSource: "envelopes.json", anchorBlocksSource: "anchor-blocks.json" },
  "merkle-3-address.json": threeAddressVector } : {}),
})) writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
console.log(JSON.stringify({ fixture: output, ...(comparison ? { provenance: "recorded-synthetic" } : {}),
  observations: ordered.length, credentials: credentials.length,
  eventId: params.eventId, commitment: commitmentHash }));
