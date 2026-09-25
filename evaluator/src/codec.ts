// Ported from the pre-existing evidence-layer reference: wire domains and canonical COSE rules.
// This implementation is independent and intentionally limited to the objects Mizar verifies.
import { createHash } from "node:crypto";
import cbor from "cbor";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { getAddress, keccak256 } from "ethers";

export const sha = (...parts: Uint8Array[]) =>
  createHash("sha256").update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
export const domain = (name: string) => Buffer.from(`levarac:${name}:v1\0`);
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export const fromHex = (value: string, size?: number) => {
  if (!/^(0x)?(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("invalid hex");
  const out = Buffer.from(value.replace(/^0x/, ""), "hex");
  if (size !== undefined && out.length !== size) throw new Error(`expected ${size} bytes`);
  return out;
};
export const b64 = (value: string) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("invalid base64");
  return Buffer.from(value, "base64");
};
export function encode(value: unknown): Buffer {
  const bytes = cbor.encodeOne(value, { canonical: true, highWaterMark: 16 * 1024 * 1024 } as never) as Buffer;
  if (cbor.decodeAllSync(bytes, { preferMap: true }).length !== 1) throw new Error("truncated CBOR encode");
  return bytes;
}
export function decode(bytes: Uint8Array): unknown {
  const values = cbor.decodeAllSync(Buffer.from(bytes), { preferMap: true });
  if (values.length !== 1 || !encode(values[0]).equals(Buffer.from(bytes))) throw new Error("non-canonical CBOR");
  return values[0];
}
export function map(value: unknown, required: number[], optional: number[] = []): Map<number, unknown> {
  if (!(value instanceof Map)) throw new Error("expected CBOR map");
  for (const key of required) if (!value.has(key)) throw new Error(`missing CBOR field ${key}`);
  for (const key of value.keys()) if (!required.includes(key) && !optional.includes(key)) throw new Error(`unknown CBOR field ${key}`);
  return value;
}
export function bytes(value: unknown, size?: number): Buffer {
  if (!(value instanceof Uint8Array)) throw new Error("expected bytes");
  if (size !== undefined && value.length !== size) throw new Error(`expected ${size} bytes`);
  return Buffer.from(value);
}
export function uint(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expected uint");
  return value;
}
export function coseSign(payload: Uint8Array, key: Uint8Array, mediaType: string): Buffer {
  const pub = Buffer.from(secp256k1.getPublicKey(key, true));
  const protectedBytes = encode(new Map<number, unknown>([[1, -47], [3, mediaType], [4, sha(domain("cose-kid"), pub).subarray(0, 8)]]));
  const signedBytes = encode(["Signature1", protectedBytes, Buffer.alloc(0), Buffer.from(payload)]);
  const signature = Buffer.from(secp256k1.sign(sha(signedBytes), key, { prehash: false, lowS: true, format: "compact" }));
  return encode(new cbor.Tagged(18, [protectedBytes, new Map(), Buffer.from(payload), signature]));
}
export function coseVerify(signed: Uint8Array, pub: Uint8Array, mediaType: string): Buffer {
  const tagged = decode(signed);
  if (!(tagged instanceof cbor.Tagged) || tagged.tag !== 18 || !Array.isArray(tagged.value) || tagged.value.length !== 4)
    throw new Error("invalid COSE_Sign1");
  const [protectedBytes, unprotected, payload, signature] = tagged.value;
  if (!(unprotected instanceof Map) || unprotected.size !== 0) throw new Error("COSE unprotected headers");
  const headers = map(decode(bytes(protectedBytes)), [1, 3, 4]);
  if (headers.get(1) !== -47 || headers.get(3) !== mediaType ||
      !bytes(headers.get(4), 8).equals(sha(domain("cose-kid"), pub).subarray(0, 8)))
    throw new Error("COSE protected headers");
  const compact = bytes(signature, 64);
  if (secp256k1.Signature.fromBytes(compact, "compact").hasHighS()) throw new Error("high-S signature");
  const message = sha(encode(["Signature1", bytes(protectedBytes), Buffer.alloc(0), bytes(payload)]));
  if (!secp256k1.verify(compact, message, pub, { prehash: false, lowS: true, format: "compact" }))
    throw new Error("invalid_signature");
  return bytes(payload);
}
export function cosePayload(signed: Uint8Array): Buffer {
  const tagged = decode(signed);
  if (!(tagged instanceof cbor.Tagged) || tagged.tag !== 18 || !Array.isArray(tagged.value) || tagged.value.length !== 4)
    throw new Error("invalid COSE_Sign1");
  return bytes(tagged.value[2]);
}
export function eventKeyAddress(pub: Uint8Array): string {
  const point = secp256k1.Point.fromBytes(bytes(pub, 33));
  return getAddress(keccak256(point.toBytes(false).subarray(1)).slice(-40));
}
export function bindingDigest(eventId: Uint8Array, challenge: Uint8Array): Buffer {
  return sha(Buffer.concat([Buffer.from([0xff]), Buffer.from("beid/event-key-sign/v1"), Buffer.from([0, 1]),
    bytes(eventId, 32), bytes(challenge, 32)]));
}
