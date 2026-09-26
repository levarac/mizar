import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import eligibleJson from "./fixtures/evaluator/eligible.json";
import proofJson from "./fixtures/evaluator/proofs/0x4ca63cdf34a0fefffab20834fd69be3b88d5c6de.json";
import { findEligible, parseEligibleFile, parseProofFile, proofsUrlFor } from "./eligibility";

const eligible = parseEligibleFile(eligibleJson);

describe("evaluator eligible.json", () => {
  it("parses the evaluator output and points at the lowercase proof file", () => {
    expect(eligible.addresses).toHaveLength(4);
    const address = getAddress("0x4Ca63cDF34a0fEfFFaB20834Fd69BE3b88d5C6De");
    const entry = findEligible(eligible, address);
    expect(entry?.partners[0]).toEqual({
      address: getAddress("0x78488fB96739A6188E7de7219ca0D11e3869b738"),
      windows: [1, 2],
    });
    const url = proofsUrlFor("https://example.invalid/out/eligible.json", address);
    expect(url).toBe(`https://example.invalid/out/proofs/${address.toLowerCase()}.json`);
    const proof = parseProofFile(proofJson);
    expect(proof.address).toBe(address);
    expect(proof.root).toBe("0x4e663e1d45553efdf5247a720b30f569a340fe2e7c4294501d04608160230fe9");
    expect(proof.proof.length).toBeGreaterThan(0);
  });
});
