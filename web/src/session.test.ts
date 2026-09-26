import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { clearClaimIfDifferent, type Session } from "./session";

const key = getAddress("0x05e8bDCA0D0523483Bc1a2F490A2F03cB00B776D");
const other = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const recipient = getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");

function session(): Session {
  return {
    eventKeyAddress: key,
    claim: {
      recipient,
      eventKeyAddress: key,
      signature: "0x11" as Hex,
      compressedKey: "0x02" as Hex,
    },
  };
}

describe("clearClaimIfDifferent", () => {
  it("drops a stored claim when the key or the recipient changes", () => {
    expect(clearClaimIfDifferent(session(), { eventKeyAddress: other }).claim).toBeUndefined();
    expect(clearClaimIfDifferent(session(), { recipient: other }).claim).toBeUndefined();
    expect(clearClaimIfDifferent(session(), { eventKeyAddress: key, recipient }).claim?.recipient).toBe(recipient);
  });
});
