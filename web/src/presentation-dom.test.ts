// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, zeroAddress } from "viem";
import html from "../index.html?raw";
import eligible from "./fixtures/evaluator/eligible.json";
import { showState, type ClaimView } from "./presentation";
import { loadSession, saveSession } from "./session";

vi.mock("./config", () => ({
  claimPageConfig: {
    chainId: 11155111,
    chainName: "Sepolia",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    claimContract: "0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC",
    eventId: `0x${"11".repeat(32)}`,
    eligibleJsonUrl: "/snapshots/1/eligible.json",
    expectedRoot: `0x${"22".repeat(32)}`,
    snapshotId: 1,
  },
}));

const key = getAddress(eligible.addresses[0]);
const originalRecipient = getAddress(eligible.addresses[1]);
const replacement = getAddress(eligible.addresses[2]);
const input = () => document.querySelector<HTMLInputElement>("#recipient")!;
const sign = () => document.querySelector<HTMLButtonElement>("#sign")!;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = html
    .match(/<body>([\s\S]*?)<\/body>/)![1]
    .replace(/<script[\s\S]*?<\/script>/g, "");
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => eligible }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("claim presentation preserves recipient corrections", () => {
  it.each(["idle", "signature", "ready"] as ClaimView[])(
    "keeps the recipient and sign action available in %s",
    (state) => {
      showState(state);
      expect(input().readOnly).toBe(false);
      expect(sign().hidden).toBe(false);
      expect(sign().disabled).toBe(false);
    },
  );
  it.each([
    "submitting",
    "submitted",
    "claimed",
    "already-claimed",
  ] as ClaimView[])("locks the recipient in %s", (state) => {
    showState(state);
    expect(input().readOnly).toBe(true);
    expect(sign().hidden).toBe(true);
  });
  it("re-signs with a changed recipient and clears the previous signature", async () => {
    saveSession({
      eventKeyAddress: key,
      claim: {
        eventKeyAddress: key,
        recipient: originalRecipient,
        signature: "0x11",
        compressedKey: "0x02",
      },
    });
    const navigate = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    await import("./main");
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>("#claim-panel")!.dataset.state,
      ).toBe("ready"),
    );
    expect(input().readOnly).toBe(false);
    expect(sign().hidden).toBe(false);
    input().value = replacement;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    sign().click();
    expect(loadSession().claim).toBeUndefined();
    expect(loadSession().pending?.recipient).toBe(replacement);
    expect(navigate).toHaveBeenCalledOnce();
    expect(
      new URL(navigate.mock.calls[0][0]).searchParams.get("b")?.slice(-40),
    ).toBe(replacement.slice(2).toLowerCase());
  });
  it("lets a user correct a pending recipient after returning without a callback", async () => {
    saveSession({
      pending: { state: "pending", recipient: originalRecipient },
    });
    const navigate = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    await import("./main");
    expect(input().readOnly).toBe(false);
    input().value = replacement;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    sign().click();
    expect(loadSession().pending?.recipient).toBe(replacement);
    expect(navigate).toHaveBeenCalledOnce();
  });
  it("keeps an edited pending recipient when eligibility finishes loading", async () => {
    saveSession({
      eventKeyAddress: key,
      pending: { state: "pending", recipient: originalRecipient },
    });
    let finish!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await import("./main");
    input().value = replacement;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    finish({ ok: true, json: async () => eligible });
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>("#claim-panel")!.dataset.state,
      ).toBe("signature"),
    );
    expect(input().value).toBe(replacement);
  });
  it("treats a malformed stored pending recipient as absent", async () => {
    localStorage.setItem(
      "mizar.claim.v1",
      JSON.stringify({ pending: { state: "pending", recipient: "invalid" } }),
    );
    await import("./main");
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>("#claim-panel")!.dataset.state,
      ).toBe("idle"),
    );
    expect(input().value).toBe("");
  });
  it("clears a zero-recipient error when a valid address is entered", async () => {
    await import("./main");
    input().value = zeroAddress;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector("#state-status")!.textContent).toContain(
      "zero address",
    );
    input().value = replacement;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector("#state-status")!.textContent).not.toContain(
      "zero address",
    );
    expect(
      document.querySelector<HTMLElement>("#claim-panel")!.dataset.state,
    ).toBe("idle");
  });
});
