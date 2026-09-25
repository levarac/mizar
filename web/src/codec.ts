import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  isAddress,
  isHex,
  recoverAddress,
  sha256,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";

export const CLAIM_PURPOSE = 0x02;
const DOMAIN_TAG = "beid/event-key-sign/v1";

export const claimAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "snapshotId", type: "uint64" },
      { name: "eventKeyAddress", type: "address" },
      { name: "proof", type: "bytes32[]" },
      { name: "recipient", type: "address" },
      { name: "appSignature", type: "bytes" },
    ],
    outputs: [{ name: "uid", type: "bytes32" }],
  },
] as const;

export type CallbackFragment = {
  sig: Hex;
  k: Hex;
  a: Address;
  st: string;
};

export class StateMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`state mismatch: expected ${expected}, got ${actual}`);
    this.name = "StateMismatchError";
  }
}

function uint256Bytes(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error("chainId does not fit in 32 bytes");
  }
  const out = new Uint8Array(32);
  let rest = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function addressBytes(address: Address): Uint8Array {
  return hexToBytes(getAddress(address));
}

/** body = chainId (32) || claimContract (20) || recipient (20) */
export function claimBodyBytes(chainId: bigint, claimContract: Address, recipient: Address): Uint8Array {
  const body = new Uint8Array(72);
  body.set(uint256Bytes(chainId), 0);
  body.set(addressBytes(claimContract), 32);
  body.set(addressBytes(recipient), 52);
  return body;
}

/** M = 0xFF || tag || 0x00 || purpose || eventId || body */
export function claimMessageBytes(args: {
  eventId: Hex;
  chainId: bigint;
  claimContract: Address;
  recipient: Address;
}): Uint8Array {
  if (!isHex(args.eventId) || hexToBytes(args.eventId).length !== 32) {
    throw new Error("eventId must be 32 bytes");
  }
  const tag = toBytes(DOMAIN_TAG);
  const message = new Uint8Array(1 + tag.length + 1 + 1 + 32 + 72);
  message[0] = 0xff;
  message.set(tag, 1);
  message[1 + tag.length] = 0x00;
  message[1 + tag.length + 1] = CLAIM_PURPOSE;
  message.set(hexToBytes(args.eventId), 1 + tag.length + 2);
  message.set(claimBodyBytes(args.chainId, args.claimContract, args.recipient), 1 + tag.length + 2 + 32);
  return message;
}

export function claimAppLink(args: {
  eventId: Hex;
  chainId: bigint;
  claimContract: Address;
  recipient: Address;
  state: string;
}): string {
  const body = toHex(claimBodyBytes(args.chainId, args.claimContract, args.recipient));
  const params = new URLSearchParams({
    v: "1",
    p: "02",
    e: args.eventId,
    b: body,
    st: args.state,
  });
  return `beid://event-key-sign?${params.toString()}`;
}

/**
 * Opens the app so it returns the event key address in the callback.
 * The signature on this link is not a claim and is never submitted.
 * b is a 32-byte nonce, the same width as a human-check challenge.
 */
export function keyReadLink(args: { eventId: Hex; nonce: Hex; state: string }): string {
  if (!isHex(args.nonce) || hexToBytes(args.nonce).length !== 32) {
    throw new Error("nonce must be 32 bytes");
  }
  const params = new URLSearchParams({
    v: "1",
    p: "01",
    e: args.eventId,
    b: args.nonce,
    st: args.state,
  });
  return `beid://event-key-sign?${params.toString()}`;
}

export function parseCallbackFragment(fragment: string): CallbackFragment {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const params = new URLSearchParams(raw);
  const sig = params.get("sig");
  const k = params.get("k");
  const a = params.get("a");
  const st = params.get("st");
  if (sig === null || k === null || a === null || st === null) {
    throw new Error("callback fragment is missing sig, k, a, or st");
  }
  if (!isHex(sig) || (hexToBytes(sig).length !== 65)) {
    throw new Error("sig must be 65 bytes");
  }
  if (!isHex(k) || hexToBytes(k).length !== 33) {
    throw new Error("k must be a 33-byte compressed key");
  }
  if (!isAddress(a)) {
    throw new Error("a is not an address");
  }
  if (st.length === 0) {
    throw new Error("st is empty");
  }
  return { sig, k, a: getAddress(a), st };
}

export function assertCallbackState(expected: string, fragment: CallbackFragment): void {
  if (expected !== fragment.st) {
    throw new StateMismatchError(expected, fragment.st);
  }
}

export type ClaimCall = {
  snapshotId: bigint;
  eventKeyAddress: Address;
  proof: Hex[];
  recipient: Address;
  appSignature: Hex;
};

export function encodeClaimCalldata(call: ClaimCall): Hex {
  return encodeFunctionData({
    abi: claimAbi,
    functionName: "claim",
    args: [call.snapshotId, call.eventKeyAddress, call.proof, call.recipient, call.appSignature],
  });
}

export async function recoverClaimSigner(message: Uint8Array, signature: Hex): Promise<Address> {
  const digest = sha256(toHex(message));
  return recoverAddress({ hash: digest, signature });
}

export function decodeClaimCalldata(data: Hex): ClaimCall {
  const decoded = decodeFunctionData({ abi: claimAbi, data });
  if (decoded.functionName !== "claim") {
    throw new Error("not a claim call");
  }
  const [snapshotId, eventKeyAddress, proof, recipient, appSignature] = decoded.args;
  return { snapshotId, eventKeyAddress, proof: [...proof], recipient, appSignature };
}

/** Full address, checksummed, shown in groups of four hex characters. */
export function groupAddress(address: Address): string {
  const checksum = getAddress(address);
  const groups = checksum.slice(2).match(/.{4}/g);
  if (!groups || groups.length !== 10) {
    throw new Error("address is not 20 bytes");
  }
  return `0x${groups.join(" ")}`;
}
