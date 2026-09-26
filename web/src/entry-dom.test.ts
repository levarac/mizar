// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../index.html?raw";
import deployment from "../public/claim-config.json";

const valid = {
  ...deployment,
  eligibleJsonUrl: "/snapshots/1/eligible.json",
  expectedRoot: `0x${"22".repeat(32)}`,
  snapshotId: 1,
};
vi.mock("./rule-card", () => ({
  loadRules: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = html
    .match(/<body>([\s\S]*?)<\/body>/)![1]
    .replace(/<script[\s\S]*?<\/script>/g, "");
});
afterEach(() => {
  vi.doUnmock("./main");
  vi.doUnmock("../public/claim-config.json");
});

describe("startup error presentation", () => {
  it("does not classify a failed module as missing configuration", async () => {
    vi.doMock("../public/claim-config.json", () => ({ default: valid }));
    vi.doMock("./main", () => {
      throw new Error("Module failed");
    });
    await import("./entry");
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>("#claim-panel")!.dataset.state,
      ).toBe("error"),
    );
    expect(document.querySelector("#state-status")!.textContent).not.toContain(
      "configuration",
    );
    expect(document.querySelector<HTMLElement>("#sign")!.hidden).toBe(true);
  });
  it("shows configuration errors before initializing the claim module", async () => {
    vi.doMock("../public/claim-config.json", () => ({
      default: { ...valid, expectedRoot: "REPLACE_ROOT" },
    }));
    const initialize = vi.fn(() => ({}));
    vi.doMock("./main", initialize);
    await import("./entry");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      document.querySelector<HTMLElement>("#claim-panel")!.dataset.state,
    ).toBe("unconfigured");
    expect(initialize).not.toHaveBeenCalled();
  });
});
