import { describe, expect, it } from "vitest";
import { getAddress, hexToBytes, toHex, type Hex } from "viem";
import vector from "../../docs/design/test-vectors/app-signature-v1.json";
import {
  StateMismatchError,
  assertCallbackState,
  claimBodyBytes,
  claimMessageBytes,
  decodeClaimCalldata,
  encodeClaimCalldata,
  groupAddress,
  parseCallbackFragment,
  recoverClaimSigner,
} from "./codec";

const claim = vector.claim;
const eventId = vector.eventId as Hex;
const recipient = getAddress(claim.recipient);
const claimContract = getAddress(claim.claimContract);
const eventKeyAddress = getAddress(vector.eventKeyAddress);

describe("claim link body", () => {
  it("matches the golden claim message body bytes", () => {
    const message = hexToBytes(claim.message as Hex);
    const built = claimMessageBytes({
      eventId,
      chainId: BigInt(claim.chainId),
      claimContract,
      recipient,
    });
    expect(toHex(built)).toBe(claim.message);
    const body = claimBodyBytes(BigInt(claim.chainId), claimContract, recipient);
    expect(body.length).toBe(72);
    expect(toHex(body)).toBe(toHex(message.slice(message.length - 72)));
    expect(toHex(built.slice(built.length - 72))).toBe(toHex(body));
  });
});

describe("callback fragment", () => {
  const fragment =
    "#sig=0x3f710e304a2fce9324cfd5540b90966bbc8cdd1969d4461e51ae658404571dcb73b3866bb6649866d99b2f467f1e768c5144ce5e7126c1deb86c77ffb6dcf7581b&k=0x02157f569f4ba8298dc31bf69aaac9efc75c16f9f8fb1630cf06443610e6e26581&a=0x05e8bdca0d0523483bc1a2f490a2f03cb00b776d&st=pending-state";

  it("parses sig, k, a, and st", () => {
    const parsed = parseCallbackFragment(fragment);
    expect(parsed.sig).toBe(claim.signature);
    expect(parsed.k).toBe(vector.eventKeyCompressed);
    expect(parsed.a).toBe(eventKeyAddress);
    expect(parsed.st).toBe("pending-state");
  });

  it("rejects a state that does not match the stored value", () => {
    const parsed = parseCallbackFragment(fragment);
    expect(() => assertCallbackState("other-state", parsed)).toThrow(StateMismatchError);
    expect(() => assertCallbackState("pending-state", parsed)).not.toThrow();
  });
});

describe("claim calldata", () => {
  it("encodes the golden claim and recovers the event key", async () => {
    const proof = [
      "0x7104ea3210fc9d3b6ac26f0820ac8309fa7f5c3e3ffe28c38140a2222aae3108",
    ] as Hex[];
    const data = encodeClaimCalldata({
      snapshotId: 1n,
      eventKeyAddress,
      proof,
      recipient,
      appSignature: claim.signature as Hex,
    });
    const decoded = decodeClaimCalldata(data);
    expect(decoded.snapshotId).toBe(1n);
    expect(decoded.eventKeyAddress).toBe(eventKeyAddress);
    expect(decoded.recipient).toBe(recipient);
    expect(decoded.appSignature).toBe(claim.signature);
    expect(decoded.proof).toEqual(proof);

    const message = claimMessageBytes({
      eventId,
      chainId: BigInt(claim.chainId),
      claimContract,
      recipient,
    });
    const signer = await recoverClaimSigner(message, decoded.appSignature);
    expect(signer).toBe(eventKeyAddress);
  });
});

describe("groupAddress", () => {
  it("shows the full address in groups of four", () => {
    expect(groupAddress(recipient)).toBe("0x7099 7970 C518 12dc 3A01 0C7d 01b5 0e0d 17dc 79C8");
  });
});
