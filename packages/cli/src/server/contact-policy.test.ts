// @vitest-environment node
import { describe, expect, it } from "vitest";
import { configuredContactPrincipals } from "./contact-policy.ts";
describe("trusted contact configuration",()=>{
  it("defaults to legacy compatibility and rejects malformed IDs",()=>{
    expect(configuredContactPrincipals({})).toEqual([]);
    expect(configuredContactPrincipals({SHAREDNET_CONTACT_PRINCIPALS:" p_1234567890,p_abcdefghij,p_1234567890 "})).toEqual(["p_1234567890","p_abcdefghij"]);
    expect(()=>configuredContactPrincipals({SHAREDNET_CONTACT_PRINCIPALS:"all"})).toThrow("Invalid SHAREDNET_CONTACT_PRINCIPALS");
    expect(()=>configuredContactPrincipals({SHAREDNET_CONTACT_PRINCIPALS:"p_1234567890,"})).toThrow();
  });
});
