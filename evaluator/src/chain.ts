import { AbiCoder, JsonRpcProvider, id, toBeHex, zeroPadValue } from "ethers";
import type { Envelope } from "./evidence.js";

const commitmentEvent = id("ObservationCommitmentRecorded(bytes32,uint64,bytes32,bytes32,address,uint64)");
const registrationEvent = id("EventRegistered(bytes32,address,address,bytes32,uint64)");
const definitionEvent = id("EventDefinitionAnchored(bytes32,uint64,bytes32,bytes32,uint64,uint64,uint64)");
export async function checkAdmissionRegistries(rpcUrl: string, chainId: number,
  eventRegistry: string, definitionRegistry: string, eventId: string,
  cutoffBlock: number, pages: Envelope[]) {
  const admission = pages[0]?.admission;
  if (!admission || pages.some(page => JSON.stringify(page.admission) !== JSON.stringify(admission)))
    throw new Error("inconsistent envelope admission");
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const eventTopic = zeroPadValue(eventId, 32);
  const registrations = await provider.getLogs({
    address: eventRegistry, topics: [registrationEvent, eventTopic],
    fromBlock: 0, toBlock: cutoffBlock,
  });
  if (registrations.length !== 1) throw new Error("event registration unavailable");
  const registration = admission.anchorRegistration;
  const [keySetDigest, registeredAt] = AbiCoder.defaultAbiCoder()
    .decode(["bytes32", "uint64"], registrations[0].data);
  if (registrations[0].topics[2].slice(-40).toLowerCase() !== registration.registrar.toLowerCase() ||
      registrations[0].topics[3].slice(-40).toLowerCase() !== registration.operator.toLowerCase() ||
      String(keySetDigest).slice(2).toLowerCase() !== registration.keySetDigest.toLowerCase() ||
      Number(registeredAt) !== registration.registeredAt)
    throw new Error("event registration differs from chain");
  const anchor = admission.definitionAnchor;
  const definitions = await provider.getLogs({
    address: definitionRegistry,
    topics: [definitionEvent, eventTopic, zeroPadValue(toBeHex(anchor.sequence), 32),
      zeroPadValue("0x" + anchor.definitionDigest, 32)],
    fromBlock: 0, toBlock: cutoffBlock,
  });
  if (definitions.length !== 1) throw new Error("definition anchor unavailable");
  const [previous, validFrom, validUntil, anchoredAt] = AbiCoder.defaultAbiCoder()
    .decode(["bytes32", "uint64", "uint64", "uint64"], definitions[0].data);
  if (String(previous).slice(2).toLowerCase() !== anchor.previousDefinitionDigest.toLowerCase() ||
      Number(validFrom) !== anchor.validFrom || Number(validUntil) !== anchor.validUntil ||
      Number(anchoredAt) !== anchor.anchoredAt)
    throw new Error("definition anchor differs from chain");
}
export async function readAnchorsFromRegistry(rpcUrl: string, registry: string,
  eventId: string, chainId: number, cutoffBlock: number, pages: Envelope[]) {
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(chainId)) throw new Error("RPC chain ID mismatch");
  const block = await provider.getBlock(cutoffBlock);
  if (!block) throw new Error("cutoff block unavailable");
  const logs = await provider.getLogs({
    address: registry, topics: [commitmentEvent, zeroPadValue(eventId, 32)],
    fromBlock: 0, toBlock: "latest",
  });
  const records = new Map<string, { sequence: number; previous: string; committedAt: number; block: number }>();
  for (const log of logs) {
    const sequence = Number(BigInt(log.topics[2]));
    const digest = log.topics[3].slice(2).toLowerCase();
    const [previous, , committedAt] = AbiCoder.defaultAbiCoder()
      .decode(["bytes32", "address", "uint64"], log.data);
    if (records.has(digest)) throw new Error("duplicate on-chain commitment digest");
    records.set(digest, { sequence, previous: String(previous).slice(2).toLowerCase(),
      committedAt: Number(committedAt), block: log.blockNumber });
  }
  const mapping: Record<string, number> = {};
  for (const page of pages) for (const item of page.commitments) {
    const digest = item.anchor.commitmentDigest.toLowerCase();
    const record = records.get(digest);
    if (!record || record.sequence !== item.anchor.sequence ||
        record.previous !== item.anchor.previousCommitmentDigest.toLowerCase() ||
        record.committedAt !== item.anchor.committedAt)
      throw new Error("commitment anchor not backed by registry event");
    mapping[digest] = record.block;
  }
  for (const [digest, record] of records)
    if (record.block <= cutoffBlock && !(digest in mapping))
      throw new Error("commitment anchored before cutoff missing from evidence");
  return { mapping, cutoffTimestamp: block.timestamp };
}
export async function readChainId(rpcUrl: string): Promise<number> {
  const provider = new JsonRpcProvider(rpcUrl);
  try { return Number((await provider.getNetwork()).chainId); } finally { provider.destroy(); }
}
export async function readPostedRoot(rpcUrl: string, contract: string, chainId: number,
  snapshotId: number, cutoffBlock: number) {
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const logs = await provider.getLogs({
    address: contract,
    topics: [id("RootPosted(uint64,bytes32,bytes32,uint64)"),
      zeroPadValue(toBeHex(snapshotId), 32)],
    fromBlock: cutoffBlock,
    toBlock: "latest",
  });
  if (logs.length !== 1) throw new Error("on-chain snapshot RootPosted event unavailable");
  const [root, manifestDigest, postedCutoff] = AbiCoder.defaultAbiCoder()
    .decode(["bytes32", "bytes32", "uint64"], logs[0].data);
  return { root: String(root), manifestDigest: String(manifestDigest), cutoffBlock: Number(postedCutoff) };
}
