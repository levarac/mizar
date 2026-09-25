// Ported from the pre-existing evidence-layer reference: Observation, commitment,
// receipt domains, admission fields, and the RFC 6962-style inclusion tree.
import { keccak256, AbiCoder } from "ethers";
import { b64, bytes, cosePayload, coseVerify, decode, domain, encode, fromHex, hex, map, sha, uint } from "./codec.js";

export interface Observation {
  digest: string;
  eventId: string;
  definitionDigest: string;
  observer: string;
  rpid: string;
  enin: number;
  observed: string[];
}
export interface InvalidObservation { digest: string; reason: string }
export interface EvidenceResult {
  observations: Observation[];
  invalid: InvalidObservation[];
  inputDigests: string[];
  commitmentDigests: string[];
  anchorRange: { first: number; last: number };
}
export interface Envelope {
  version: number;
  context: string;
  operatorPublicKey: string;
  admission: {
    signedDefinition: string; encodedKeySet: string;
    anchorRegistration: { eventId: string; registrar: string; operator: string; keySetDigest: string; registeredAt: number };
    definitionAnchor: { eventId: string; sequence: number; previousDefinitionDigest: string; definitionDigest: string;
      validFrom: number; validUntil: number; anchoredAt: number };
  };
  page: { cursor: string | null; nextCursor: string | null; limit: number };
  commitments: Array<{
    signedCommitment: string; bundle: string | null;
    anchor: { eventId: string; sequence: number; previousCommitmentDigest: string; commitmentDigest: string; committedAt: number };
    inclusions: Array<{ observationDigest: string; signedReceipt: string }>;
    observationCursor: string | null; nextObservationCursor: string | null;
  }>;
  observations: Array<{ observationDigest: string; signedObservation: string }>;
}
const media = {
  observation: "application/vnd.levarac.observation+cbor",
  definition: "application/vnd.levarac.event-definition+cbor",
  commitment: "application/vnd.levarac.observation-commitment+cbor",
  receipt: "application/vnd.levarac.inclusion-receipt+cbor",
};
export const observationDigest = (signed: Uint8Array) => hex(sha(domain("observation-digest"), signed));
export const definitionDigest = (signed: Uint8Array) => hex(sha(domain("event-definition-digest"), signed));
export const keySetDigest = (encoded: Uint8Array) => hex(sha(domain("event-key-set-digest"), encoded));
export const commitmentDigest = (signed: Uint8Array) => hex(sha(domain("commitment-digest"), signed));
export const operatorId = (pub: Uint8Array) => sha(domain("operator-id"), pub);
const leafHash = (value: Uint8Array) => sha(Buffer.from([0]), value);
const nodeHash = (a: Uint8Array, b: Uint8Array) => sha(Buffer.from([1]), a, b);
function split(size: number): number { let n = 1; while (n * 2 < size) n *= 2; return n; }
function rootHashes(hashes: Buffer[]): Buffer {
  if (!hashes.length) return sha(Buffer.alloc(0));
  if (hashes.length === 1) return hashes[0];
  const n = split(hashes.length);
  return nodeHash(rootHashes(hashes.slice(0, n)), rootHashes(hashes.slice(n)));
}
export const evidenceRoot = (digests: string[]) => rootHashes(digests.map(d => leafHash(fromHex(d, 32))));
export function inclusionPath(digests: string[], index: number): Buffer[] {
  const hashes = digests.map(d => leafHash(fromHex(d, 32)));
  const walk = (nodes: Buffer[], pos: number): Buffer[] => {
    if (nodes.length === 1) return [];
    const n = split(nodes.length);
    return pos < n ? [...walk(nodes.slice(0, n), pos), rootHashes(nodes.slice(n))]
      : [...walk(nodes.slice(n), pos - n), rootHashes(nodes.slice(0, n))];
  };
  return walk(hashes, index);
}
function verifyPath(digest: string, index: number, size: number, path: Buffer[], root: Buffer): boolean {
  let cursor = 0;
  const walk = (pos: number, count: number): Buffer => {
    if (count === 1) return leafHash(fromHex(digest, 32));
    const n = split(count);
    if (pos < n) return nodeHash(walk(pos, n), path[cursor++]);
    const right = walk(pos - n, count - n);
    return nodeHash(path[cursor++], right);
  };
  if (index < 0 || index >= size) return false;
  try { return walk(index, size).equals(root) && cursor === path.length; } catch { return false; }
}
function same(a: Uint8Array, b: string) { return hex(a) === b.toLowerCase().replace(/^0x/, ""); }
function addressWord(value: string): string { return AbiCoder.defaultAbiCoder().encode(["address"], [value]); }
function verifyAdmission(env: Envelope, eventId: string) {
  const admission = env.admission;
  const keySetBytes = b64(admission.encodedKeySet);
  const keys = map(decode(keySetBytes), [1, 2, 3]);
  if (keys.get(1) !== 1 || keys.get(3) !== 1 || !Array.isArray(keys.get(2))) throw new Error("invalid EventKeySet");
  const authorityKeys = (keys.get(2) as unknown[]).map(k => bytes(k, 33));
  if (!authorityKeys.length || keySetDigest(keySetBytes) !== admission.anchorRegistration.keySetDigest)
    throw new Error("EventKeySet anchor mismatch");
  const signed = b64(admission.signedDefinition);
  let payload: Buffer | undefined;
  for (const key of authorityKeys) {
    try { payload = coseVerify(signed, key, media.definition); break; } catch { /* try next authority */ }
  }
  if (!payload) throw new Error("invalid Event Definition authority signature");
  const d = map(decode(payload), Array.from({ length: 13 }, (_, i) => i + 1), [14, 15, 16]);
  if (d.get(1) !== 1 || !same(bytes(d.get(2), 32), eventId) ||
      !same(bytes(d.get(6), 32), keySetDigest(keySetBytes)) ||
      !same(bytes(d.get(2), 32), admission.anchorRegistration.eventId) ||
      !same(bytes(d.get(3), 20), admission.anchorRegistration.registrar) ||
      !same(bytes(d.get(4), 20), admission.anchorRegistration.operator))
    throw new Error("Event Definition registration mismatch");
  const expectedEventId = keccak256(Buffer.concat([
    fromHex(keccak256(Buffer.from("levarac:event:v1")), 32),
    fromHex(addressWord("0x" + hex(bytes(d.get(3), 20))), 32),
    fromHex(addressWord("0x" + hex(bytes(d.get(4), 20))), 32),
    bytes(d.get(5), 32), bytes(d.get(6), 32),
  ])).slice(2);
  if (expectedEventId !== eventId.toLowerCase().replace(/^0x/, "")) throw new Error("Event ID derivation mismatch");
  const da = admission.definitionAnchor;
  const digest = definitionDigest(signed);
  const validFrom = uint(d.get(12)), validUntil = uint(d.get(13));
  if (digest !== da.definitionDigest || !same(bytes(d.get(2), 32), da.eventId) ||
      uint(d.get(7)) !== da.sequence || !same(bytes(d.get(8), 32), da.previousDefinitionDigest) ||
      validFrom !== da.validFrom || validUntil !== da.validUntil ||
      da.anchoredAt < admission.anchorRegistration.registeredAt || da.anchoredAt >= validFrom)
    throw new Error("Event Definition anchor mismatch");
  const receiptKey = bytes(d.get(9), 33);
  if (!operatorId(receiptKey).equals(bytes(d.get(10), 32))) throw new Error("operator ID mismatch");
  if (env.operatorPublicKey !== receiptKey.toString("base64")) throw new Error("operator key hint mismatch");
  return { digest, receiptKey, validFrom, validUntil, keySetBytes, signed };
}
export function verifyEvidence(pages: Envelope[], eventId: string, cutoffBlock: number,
  anchorBlocks: Record<string, number>): EvidenceResult {
  if (!pages.length) throw new Error("no envelope pages");
  const observations: Observation[] = [], invalid: InvalidObservation[] = [];
  const inputDigests: string[] = [], commitmentDigests: string[] = [];
  const blocks: number[] = [];
  const seen = new Set<string>();
  for (const env of pages) {
    if (env.version !== 1 || env.context !== eventId.replace(/^0x/, "").toLowerCase())
      throw new Error("envelope event mismatch");
    if (env.page.nextCursor !== null || env.commitments.some(c => c.nextObservationCursor !== null))
      throw new Error("incomplete envelope pagination");
    const admission = verifyAdmission(env, eventId);
    const byDigest = new Map(env.observations.map(o => [o.observationDigest, o]));
    for (const item of env.commitments) {
      const signed = b64(item.signedCommitment);
      const digest = commitmentDigest(signed);
      if (digest !== item.anchor.commitmentDigest || item.anchor.eventId !== env.context)
        throw new Error("commitment anchor mismatch");
      const block = anchorBlocks[digest];
      if (!Number.isSafeInteger(block) || block < 0) throw new Error("missing trusted anchor block mapping");
      if (block > cutoffBlock) continue;
      blocks.push(block); commitmentDigests.push(digest);
      const c = map(decode(coseVerify(signed, admission.receiptKey, media.commitment)),
        Array.from({ length: 12 }, (_, i) => i + 1));
      if (c.get(1) !== 1 || !bytes(c.get(2), 32).equals(operatorId(admission.receiptKey)) ||
          !same(bytes(c.get(3), 32), eventId) || uint(c.get(4)) !== item.anchor.sequence ||
          !same(bytes(c.get(5), 32), item.anchor.previousCommitmentDigest) ||
          uint(c.get(11)) > item.anchor.committedAt ||
          uint(c.get(11)) < admission.validFrom || item.anchor.committedAt > admission.validUntil)
        throw new Error("invalid signed commitment");
      const count = uint(c.get(8)), root = bytes(c.get(7), 32);
      if (count !== item.inclusions.length) throw new Error("incomplete commitment inclusions");
      const ordered: string[] = new Array(count);
      for (const inc of item.inclusions) {
        const r = map(decode(coseVerify(b64(inc.signedReceipt), admission.receiptKey, media.receipt)),
          Array.from({ length: 8 }, (_, i) => i + 1));
        const index = uint(r.get(6)), size = uint(r.get(5));
        if (r.get(1) !== 1 || !bytes(r.get(2), 32).equals(operatorId(admission.receiptKey)) ||
            !same(bytes(r.get(3), 32), inc.observationDigest) ||
            !same(bytes(r.get(4), 32), digest) || size !== count || ordered[index] !== undefined ||
            !verifyPath(inc.observationDigest, index, size, (r.get(7) as unknown[]).map(x => bytes(x, 32)), root))
          throw new Error("invalid Merkle inclusion");
        ordered[index] = inc.observationDigest;
      }
      if (ordered.some(x => x === undefined) || !evidenceRoot(ordered).equals(root))
        throw new Error("commitment Merkle root mismatch");
      const signedObservations = ordered.map(d => {
        const o = byDigest.get(d);
        if (!o) throw new Error("missing envelope Observation");
        return b64(o.signedObservation);
      });
      const rebuilt = encode(new Map<number, unknown>([
        [1, 1], [2, fromHex(eventId, 32)], [3, uint(c.get(4))], [4, signedObservations],
        [5, []], [6, admission.keySetBytes], [7, [admission.signed]],
      ]));
      if (!sha(rebuilt).equals(bytes(c.get(9), 32)) || rebuilt.length !== uint(c.get(10)))
        throw new Error("commitment bundle mismatch");
      for (let i = 0; i < ordered.length; i++) {
        const declared = ordered[i], signedObservation = signedObservations[i];
        if (seen.has(declared)) throw new Error("duplicate Observation digest");
        seen.add(declared); inputDigests.push(declared);
        try {
          if (observationDigest(signedObservation) !== declared) throw new Error("observation_digest_mismatch");
          const raw = map(decode(cosePayload(signedObservation)), [1, 2, 3, 4, 5, 6, 7, 8]);
          const observer = bytes(raw.get(5), 33);
          coseVerify(signedObservation, observer, media.observation);
          if (raw.get(1) !== 1 || bytes(raw.get(2), 16).length !== 16 ||
              raw.get(3) !== "levarac.mutual-sensing/v1" || !same(bytes(raw.get(4), 32), eventId))
            throw new Error("observation_context_or_profile");
          const observedAt = uint(raw.get(6));
          if (observedAt < admission.validFrom || observedAt > admission.validUntil)
            throw new Error("observation_outside_definition_window");
          const rpid = bytes(raw.get(7), 17);
          if (rpid[0] !== 1) throw new Error("invalid_rpid");
          const p = map(decode(bytes(raw.get(8))), [1, 2, 3, 4, 5]);
          if (!same(bytes(p.get(1), 32), admission.digest)) throw new Error("definition_digest_mismatch");
          const rpids = p.get(3);
          if (!Array.isArray(rpids)) throw new Error("invalid_observed_rpids");
          const observed = rpids.map(x => {
            const b = bytes(x, 17); if (b[0] !== 1) throw new Error("invalid_rpid"); return hex(b);
          });
          if (observed.some((x, j) => j > 0 && x <= observed[j - 1])) throw new Error("unsorted_observed_rpids");
          if (p.get(4) !== null && !(p.get(4) instanceof Uint8Array)) throw new Error("invalid_rpid_claim");
          if (p.get(5) !== null) bytes(p.get(5), 32);
          observations.push({ digest: declared, eventId: env.context, definitionDigest: admission.digest,
            observer: hex(observer), rpid: hex(rpid), enin: uint(p.get(2)), observed });
        } catch (error) {
          invalid.push({ digest: declared, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  inputDigests.sort(); commitmentDigests.sort();
  return { observations, invalid, inputDigests, commitmentDigests,
    anchorRange: { first: Math.min(...blocks), last: Math.max(...blocks) } };
}
