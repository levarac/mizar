// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../index.html?raw";
import config from "../public/claim-config.json";
import params from "./fixtures/params.json?raw";
import { loadRules } from "./rule-card";

const status = () => document.querySelector<HTMLElement>("#rules-status")!;

beforeEach(() => {
  document.body.innerHTML = html
    .match(/<body>([\s\S]*?)<\/body>/)![1]
    .replace(/<script[\s\S]*?<\/script>/g, "");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(params).buffer,
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("rule verification status", () => {
  it("starts without a verified status", () => {
    expect(status().classList.contains("verified")).toBe(false);
    expect(document.querySelector<HTMLElement>("#rules-content")!.hidden).toBe(true);
  });
  it("marks verified only after the exact-byte hash check succeeds", async () => {
    const loading = loadRules(config);
    expect(status().classList.contains("verified")).toBe(false);
    await loading;
    expect(status().classList.contains("verified")).toBe(true);
    expect(status().classList.contains("error")).toBe(false);
  });
  it("never marks a digest mismatch as verified", async () => {
    await loadRules({ ...config, paramsSha256: "0".repeat(64) });
    expect(status().classList.contains("verified")).toBe(false);
    expect(status().classList.contains("error")).toBe(true);
  });
  it("removes an earlier verified status when a subsequent check fails", async () => {
    await loadRules(config);
    expect(status().classList.contains("verified")).toBe(true);
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    await loadRules(config);
    expect(status().classList.contains("verified")).toBe(false);
    expect(status().classList.contains("error")).toBe(true);
    expect(document.querySelector<HTMLElement>("#rules-content")!.hidden).toBe(true);
  });
});
