import { describe, expect, it } from "vitest";
import { sha256 } from "viem";
import { parseRuleConfig, verifyParameters } from "./rule-card";

const params = {
  eventId: `0x${"12".repeat(32)}`,
  minPartners: 2,
  minWindowsPerPartner: 2,
  credentialsSource: "https://credentials.example/credentials",
  credentialsPublicKey: `0x${"34".repeat(32)}`,
};
const bytes = new TextEncoder().encode(JSON.stringify(params));
const config = {
  paramsUrl: "https://example.org/params.json",
  paramsSha256: sha256(bytes).slice(2),
  eventId: params.eventId,
};

describe("read-only published parameters", () => {
  it("accepts explicit URL and SHA-256 configuration", () => {
    expect(parseRuleConfig(config)).toEqual(config);
  });
  it.each([
    {},
    { ...config, paramsUrl: "" },
    { ...config, paramsUrl: "javascript:alert(1)" },
    { ...config, paramsUrl: "http://example.org/params.json" },
    { ...config, paramsSha256: "" },
    { ...config, paramsSha256: "f".repeat(63) },
  ])("rejects missing or invalid configuration", (raw) => {
    expect(() => parseRuleConfig(raw)).toThrow();
  });
  it.each([
    { ...config, slotSeconds: 0 },
    { ...config, slotSeconds: 2.5 },
    { ...config, eventStart: "invalid" },
    { ...config, eventStart: "2026-09-26T05:30:00Z" },
    {
      ...config,
      eventStart: "2026-09-26T12:00:00Z",
      eventEnd: "2026-09-26T11:00:00Z",
    },
    {
      ...config,
      eventStart: "2026-02-30T12:00:00Z",
      eventEnd: "2026-03-02T11:00:00Z",
    },
  ])("rejects invalid optional reference fields", (raw) => {
    expect(() => parseRuleConfig(raw)).toThrow();
  });
  it("keeps reference timing separate from verified parameters", () => {
    const reference = {
      ...config,
      slotSeconds: 300,
      eventStart: "2026-09-26T05:30:00Z",
      eventEnd: "2026-09-27T15:00:00Z",
    };
    expect(parseRuleConfig(reference)).toEqual(reference);
    expect(verifyParameters(bytes, reference)).not.toHaveProperty(
      "slotSeconds",
    );
  });
  it("verifies exact bytes and does not invent absent timing values", () => {
    expect(verifyParameters(bytes, config)).toMatchObject({
      minPartners: 2,
      minWindowsPerPartner: 2,
    });
    expect(verifyParameters(bytes, config)).not.toHaveProperty("slotSeconds");
    expect(verifyParameters(bytes, config)).not.toHaveProperty("eventStart");
  });
  it("rejects equivalent JSON with different bytes", () => {
    expect(() =>
      verifyParameters(
        new TextEncoder().encode(JSON.stringify(params, null, 2)),
        config,
      ),
    ).toThrow(/digest/i);
  });
  it("rejects verified bytes belonging to a different event", () => {
    expect(() =>
      verifyParameters(bytes, { ...config, eventId: `0x${"ab".repeat(32)}` }),
    ).toThrow(/event/i);
  });
  it.each([
    { ...params, minPartners: -1 },
    { ...params, minWindowsPerPartner: 1.5 },
    { ...params, credentialsSource: "javascript:alert(1)" },
    { ...params, credentialsPublicKey: "0x123" },
  ])("rejects invalid values even with a matching digest", (raw) => {
    const data = new TextEncoder().encode(JSON.stringify(raw));
    expect(() =>
      verifyParameters(data, {
        ...config,
        paramsSha256: sha256(data).slice(2),
      }),
    ).toThrow();
  });
});
