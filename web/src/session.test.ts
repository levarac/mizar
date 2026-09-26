import { secp256k1 } from "@noble/curves/secp256k1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, hexToBytes, sha256, toHex, type Hex } from "viem";
import { addressFromCompressedKey, claimMessageBytes, type CallbackFragment } from "./codec";
import { claimPageConfig } from "./config";
import { clearClaimIfDifferent, loadSession, saveSession, type Session } from "./session";

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

describe("claim callback session persistence", () => {
  function signedCallback(testKey: number): CallbackFragment {
    // Deterministic, public test keys only.
    const privateKey = new Uint8Array(32);
    privateKey[31] = testKey;
    const compressedKey = toHex(secp256k1.getPublicKey(privateKey, true));
    const message = claimMessageBytes({
      eventId: claimPageConfig.eventId,
      chainId: BigInt(claimPageConfig.chainId),
      claimContract: claimPageConfig.claimContract,
      recipient,
    });
    const signature = secp256k1.sign(hexToBytes(sha256(message)), privateKey);
    return {
      a: addressFromCompressedKey(compressedKey),
      k: compressedKey,
      sig: toHex(new Uint8Array([...signature.toCompactRawBytes(), signature.recovery + 27])),
      st: "pending-state",
    };
  }

  const previous = signedCallback(1);
  const incoming = signedCallback(2);

  function prepare(fragment: CallbackFragment, pending = true) {
    vi.resetModules();
    const storage = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem });
    const stored: Session = {
      eventKeyAddress: previous.a,
      pending: pending ? { state: "pending-state", recipient } : undefined,
      claim: {
        recipient,
        eventKeyAddress: previous.a,
        signature: previous.sig,
        compressedKey: previous.k,
      },
    };
    saveSession(stored);
    const before = [...storage.entries()];
    setItem.mockClear();

    const elements = new Map([
      "#status", "#event-key", "#eligibility", "#recipient", "#recipient-grouped",
      "#sign", "#submit", "#signature",
    ].map((id) => [id, {
      textContent: "", value: "", disabled: false,
      classList: { toggle: vi.fn() }, addEventListener: vi.fn(),
    }]));
    vi.stubGlobal("document", { querySelector: (selector: string) => elements.get(selector) });
    vi.stubGlobal("window", {
      location: { hash: `#${new URLSearchParams(fragment)}`, pathname: "/claim", search: "" },
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    return { storage, before, stored, setItem, elements };
  }

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["wrong state", { ...incoming, st: "wrong-state" }, true, "state mismatch"],
    ["key/address mismatch", { ...incoming, k: previous.k }, true, "event key address does not match a"],
    ["signature mismatch", { ...incoming, sig: previous.sig }, true, "recovered signer does not match a"],
    ["missing pending request", incoming, false, "No pending app request"],
    ["malformed signature", { ...incoming, sig: "0x11" as Hex }, true, "sig must be 65 bytes"],
  ])("preserves the stored claim for a %s callback", async (_name, fragment, pending, error) => {
    const { storage, before, stored, setItem, elements } = prepare(fragment, pending);
    await import("./main");
    await vi.waitFor(() => expect(elements.get("#status")?.textContent).toContain(error));
    expect([...storage.entries()]).toEqual(before);
    expect(loadSession()).toEqual(JSON.parse(JSON.stringify(stored)));
    expect(setItem).not.toHaveBeenCalled();
    expect(elements.get("#signature")?.textContent).toContain("Signature stored for");
  });

  it("replaces the stored claim after a valid callback from a different key", async () => {
    const { setItem, elements } = prepare(incoming);
    await import("./main");
    await vi.waitFor(() => expect(elements.get("#status")?.textContent).toBe("App callback accepted."));
    expect(loadSession()).toEqual({
      eventKeyAddress: incoming.a,
      claim: {
        recipient,
        eventKeyAddress: incoming.a,
        signature: incoming.sig,
        compressedKey: incoming.k,
      },
    });
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});
