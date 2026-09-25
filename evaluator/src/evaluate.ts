import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { recoverAddress } from "ethers";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bindingDigest, eventKeyAddress, fromHex, hex, sha } from "./codec.js";
import type { EvidenceResult, Observation } from "./evidence.js";

export interface Parameters {
  evaluatorVersion: "mizar-eval/1";
  eventId: string; chainId: number; minPartners: number; minWindowsPerPartner: number;
  credentialsPublicKey: string;
  evidenceSource: string; credentialsSource: string; anchorBlocksSource: string;
  snapshot: { id: number; cutoffBlock: number; cutoffTimestamp: number };
}
export interface Credential {
  eventKey: string; eventKeyAddress: string; nullifierHash: string; verifiedAt: string;
  challenge: string; appSignature: string; proofDigest: string;
  attestation: { algorithm: "Ed25519"; publicKey: string; signature: string };
}
export interface CredentialList { eventId: string; credentials: Credential[] }
export type RejectionReason = "too_few_partners" | "too_few_windows" | "rpid_conflict" | "not_credentialed";
export interface EvaluationOptions { humanGate?: boolean; encounterRequirement?: boolean }
export interface Evaluation {
  root: string;
  eligible: Array<{ address: string; partners: Array<{ address: string; windows: number[] }> }>;
  rejected: Array<{ address: string; reason: RejectionReason; partnerCount: number; qualifyingPartners: number }>;
  proofs: Record<string, string[]>;
  rpidConflicts: Array<{ rpid: string; keys: string[] }>;
  invalidObservations: EvidenceResult["invalid"];
  invalidCredentials: Array<{ address: string; reason: string }>;
  credentialDigest: string;
}
const byAddress = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
const keyOf = (pub: string) => pub.toLowerCase().replace(/^0x/, "");
const addrKey = (addr: string) => addr.toLowerCase();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function verifyCredentials(list: CredentialList, params: Parameters) {
  const valid: Credential[] = [], invalid: Evaluation["invalidCredentials"] = [];
  if (list.eventId.toLowerCase() !== params.eventId.toLowerCase() || !Array.isArray(list.credentials))
    throw new Error("credential list event mismatch");
  const trustedKey = fromHex(params.credentialsPublicKey, 32);
  if (!Number.isSafeInteger(params.snapshot.cutoffTimestamp)) throw new Error("missing cutoff timestamp");
  for (const item of list.credentials) {
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(item.nullifierHash) ||
          !/^0x[0-9a-fA-F]{64}$/.test(item.proofDigest)) throw new Error("invalid_credential_shape");
      const verifiedAt = Date.parse(item.verifiedAt);
      if (!Number.isFinite(verifiedAt) || new Date(verifiedAt).toISOString() !== item.verifiedAt)
        throw new Error("invalid_verified_at");
      if (verifiedAt > params.snapshot.cutoffTimestamp * 1000) {
        invalid.push({ address: item.eventKeyAddress, reason: "credential_after_cutoff" });
        continue;
      }
      if (item.attestation?.algorithm !== "Ed25519" ||
          !fromHex(item.attestation.publicKey, 32).equals(trustedKey))
        throw new Error("attestation_public_key_mismatch");
      const { attestation, ...unsigned } = item;
      const message = Buffer.from("alcor/credential/v1\0" + canonical(unsigned));
      if (!ed25519.verify(fromHex(attestation.signature, 64), message, trustedKey))
        throw new Error("invalid_attestation_signature");
      const address = eventKeyAddress(fromHex(item.eventKey, 33));
      if (addrKey(address) !== addrKey(item.eventKeyAddress)) throw new Error("event_key_address_mismatch");
      const digest = bindingDigest(fromHex(params.eventId, 32), fromHex(item.challenge, 32));
      const sig = fromHex(item.appSignature, 65);
      const s = BigInt("0x" + hex(sig.subarray(32, 64)));
      if (s > BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0"))
        throw new Error("high-S binding signature");
      if (addrKey(recoverAddress("0x" + hex(digest), item.appSignature)) !== addrKey(address))
        throw new Error("invalid_binding_signature");
      valid.push(item);
    } catch (error) {
      invalid.push({ address: item.eventKeyAddress,
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  // Tie-breakers prevent input ordering from changing which key owns a nullifier.
  valid.sort((a, b) => Date.parse(a.verifiedAt) - Date.parse(b.verifiedAt) ||
    byAddress(a.eventKeyAddress, b.eventKeyAddress));
  const accepted = new Map<string, Credential>(), usedNullifiers = new Set<string>();
  for (const item of valid) {
    const nullifier = item.nullifierHash.toLowerCase();
    if (usedNullifiers.has(nullifier) || accepted.has(addrKey(item.eventKeyAddress))) {
      invalid.push({ address: item.eventKeyAddress, reason: "duplicate_nullifier_or_key" });
      continue;
    }
    usedNullifiers.add(nullifier);
    accepted.set(addrKey(item.eventKeyAddress), item);
  }
  return { accepted, invalid };
}
export function deriveRelations(observations: Observation[]) {
  const groups = new Map<string, Map<string, Set<string>>>();
  const claims = new Map<string, Set<string>>();
  for (const obs of observations) {
    const owner = keyOf(obs.observer), rpid = obs.rpid.toLowerCase();
    if (!claims.has(rpid)) claims.set(rpid, new Set());
    claims.get(rpid)!.add(owner);
    const id = `${obs.eventId}:${obs.definitionDigest}:${obs.enin}`;
    if (!groups.has(id)) groups.set(id, new Map());
    const group = groups.get(id)!;
    if (!group.has(rpid)) group.set(rpid, new Set());
    for (const heard of obs.observed) group.get(rpid)!.add(heard.toLowerCase());
  }
  const conflicts = [...claims].filter(([, owners]) => owners.size > 1)
    .map(([rpid, owners]) => ({ rpid, keys: [...owners].sort() }))
    .sort((a, b) => a.rpid.localeCompare(b.rpid));
  const conflictRpids = new Set(conflicts.map(c => c.rpid));
  const pairs = new Map<string, Set<number>>();
  for (const [id, reporters] of groups) {
    const enin = Number(id.split(":").at(-1));
    const rpids = [...reporters.keys()].sort();
    for (let i = 0; i < rpids.length; i++) for (let j = i + 1; j < rpids.length; j++) {
      const a = rpids[i], b = rpids[j];
      if (!reporters.get(a)!.has(b) || !reporters.get(b)!.has(a) ||
          conflictRpids.has(a) || conflictRpids.has(b)) continue;
      const aa = [...claims.get(a)!][0], bb = [...claims.get(b)!][0];
      if (aa === bb) continue;
      const pair = [aa, bb].sort().join(":");
      if (!pairs.has(pair)) pairs.set(pair, new Set());
      pairs.get(pair)!.add(enin);
    }
  }
  return { pairs, conflicts, claims };
}
export function evaluateRule(params: Parameters, evidence: EvidenceResult, list: CredentialList,
  options: EvaluationOptions = {}): Evaluation {
  if (params.evaluatorVersion !== "mizar-eval/1" ||
      !Number.isSafeInteger(params.minPartners) || params.minPartners < 1 ||
      !Number.isSafeInteger(params.minWindowsPerPartner) || params.minWindowsPerPartner < 1)
    throw new Error("invalid evaluation parameters");
  const { accepted, invalid } = verifyCredentials(list, params);
  const { pairs, conflicts, claims } = deriveRelations(evidence.observations);
  const ownerToAddress = new Map<string, string>();
  for (const obs of evidence.observations) ownerToAddress.set(keyOf(obs.observer),
    eventKeyAddress(fromHex(obs.observer, 33)));
  for (const credential of list.credentials) {
    try { ownerToAddress.set(keyOf(credential.eventKey), eventKeyAddress(fromHex(credential.eventKey, 33))); }
    catch { /* invalid credentials are reported above */ }
  }
  const candidateKeys = new Set<string>(options.humanGate === false
    ? ownerToAddress.keys() : [...accepted.values()].map(c => keyOf(c.eventKey)));
  const partnerWindows = new Map<string, Map<string, Set<number>>>();
  for (const [pair, windows] of pairs) {
    const [a, b] = pair.split(":");
    if (!candidateKeys.has(a) || !candidateKeys.has(b)) continue;
    for (const [self, other] of [[a, b], [b, a]]) {
      if (!partnerWindows.has(self)) partnerWindows.set(self, new Map());
      partnerWindows.get(self)!.set(other, windows);
    }
  }
  const eligible: Evaluation["eligible"] = [], rejected: Evaluation["rejected"] = [];
  const allKeys = new Set([...ownerToAddress.keys(), ...candidateKeys]);
  for (const owner of allKeys) {
    const address = ownerToAddress.get(owner);
    if (!address) continue;
    const partners = [...(partnerWindows.get(owner) ?? new Map())]
      .map(([other, windows]) => ({ address: ownerToAddress.get(other)!, windows: [...windows].sort((a, b) => a - b) }))
      .sort((a, b) => byAddress(a.address, b.address));
    const qualifying = partners.filter(p => p.windows.length >= params.minWindowsPerPartner);
    const qualifies = options.encounterRequirement === false || qualifying.length >= params.minPartners;
    if (candidateKeys.has(owner) && qualifies) {
      eligible.push({ address, partners });
    } else {
      const hasConflict = conflicts.some(c => c.keys.includes(owner));
      const reason: RejectionReason = !candidateKeys.has(owner) ? "not_credentialed" :
        hasConflict && partners.length < params.minPartners ? "rpid_conflict" :
        partners.length >= params.minPartners ? "too_few_windows" : "too_few_partners";
      rejected.push({ address, reason, partnerCount: partners.length, qualifyingPartners: qualifying.length });
    }
  }
  eligible.sort((a, b) => byAddress(a.address, b.address));
  rejected.sort((a, b) => byAddress(a.address, b.address));
  const tree = eligible.length ? StandardMerkleTree.of(eligible.map(x => [x.address]), ["address"]) : null;
  const proofs: Record<string, string[]> = {};
  eligible.forEach((entry, i) => { proofs[entry.address] = tree!.getProof(i); });
  return { root: tree?.root ?? "0x" + "00".repeat(32), eligible, rejected, proofs,
    rpidConflicts: conflicts, invalidObservations: evidence.invalid, invalidCredentials: invalid,
    credentialDigest: hex(sha(Buffer.from(JSON.stringify(list)))) };
}
