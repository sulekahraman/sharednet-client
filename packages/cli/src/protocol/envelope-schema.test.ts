import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { referenceEnvelopeSchema } from "./envelope-schema.ts";

describe("the reference envelope schema", () => {
  it("is the pinned fixtures/envelope.schema.json, value for value", () => {
    const pinned = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "envelope.schema.json"), "utf8"));
    expect(referenceEnvelopeSchema).toEqual(pinned);
  });
});
