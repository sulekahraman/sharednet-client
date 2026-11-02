/**
 * Protocol conformance gate.
 *
 * The typed-coordination protocol has exactly one definition: the reference semantics in the
 * research repository (runtime-coordination/protocol). It publishes fixtures — sequences of
 * canonical events with the admission outcome and projection digest the reference produces — and
 * this package vendors them. Three things are enforced here:
 *
 *  1. the vendored files are byte-identical to what FIXTURES.lock.json pins, so a silent edit on
 *     either side fails CI instead of drifting;
 *  2. every event type the schema allows is either implemented by this server or explicitly listed
 *     as reserved for V2 — no third state;
 *  3. room.test.ts replays every canonical fixture, compares every outcome/digest and restores
 *     its admitted log. compiled-room-e2e.mjs exercises the authenticated /acts boundary over
 *     real HTTP and PostgreSQL, with actual stored artifacts and reviewer execution.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "fixtures");
const read = (name: string) => readFileSync(join(dir, name));
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const lock = JSON.parse(read("FIXTURES.lock.json").toString()) as Record<string, string>;
const schema = JSON.parse(read("envelope.schema.json").toString());
const eventSchema = JSON.parse(read("event.schema.json").toString()) as EventSchema;
const conformance = JSON.parse(read("conformance.json").toString()) as { protocol: string; fixtures: { name: string; events: unknown[]; outcomes: unknown[]; digest: string }[] };
const fuzz = JSON.parse(read("fuzz.json").toString()) as { protocol: string; logs: { seed: number; events: unknown[]; outcomes: unknown[]; digest: string }[] };

/** Public /acts implements the lifecycle; clock ticks remain service-reserved. */
const IMPLEMENTED: readonly string[] = [
  "message",
  "work.request", "work.accept", "work.decline", "work.result", "work.cancel", "work.resolve",
  "verification.pass", "verification.fail", "human.approve", "human.reject",
];
const RESERVED_FOR_SERVICE: readonly string[] = ["clock.tick"];

describe("protocol fixtures are pinned", () => {
  it.each(["conformance.json", "fuzz.json", "envelope.schema.json", "event.schema.json"])("%s matches FIXTURES.lock.json", (name) => {
    expect(sha256(read(name))).toBe(lock[name]);
  });
  it("both fixture files describe the same protocol version", () => {
    expect(conformance.protocol).toBe(lock.protocol);
    expect(fuzz.protocol).toBe(lock.protocol);
  });
});

describe("every schema event type is implemented or reserved", () => {
  const types: string[] = schema.properties.type.enum;
  it("has no type outside the two lists", () => {
    expect([...types].sort()).toEqual([...IMPLEMENTED, ...RESERVED_FOR_SERVICE].sort());
  });
  it("ordinary messages remain a supported nonbinding type", () => {
    expect(IMPLEMENTED).toContain("message");
  });
});

/**
 * The canonical event schema, validated with the subset of JSON Schema it actually uses. No ajv:
 * the schema is deliberately loose in the two places that matter, and a validator small enough to
 * read is worth more here than a dependency.
 */
type TypeName = "string" | "object" | "array" | "null";
type FieldSchema = {
  type?: TypeName | TypeName[];
  enum?: unknown[];
  minLength?: number;
  items?: FieldSchema & { required?: string[]; properties?: Record<string, FieldSchema> };
};
type EventSchema = {
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, FieldSchema>;
};

function typeErrors(value: unknown, spec: FieldSchema, where: string): string[] {
  const errs: string[] = [];
  if (spec.type !== undefined) {
    const allowed = Array.isArray(spec.type) ? spec.type : [spec.type];
    const matches = allowed.some((name) =>
      name === "null" ? value === null
        : name === "string" ? typeof value === "string"
        : name === "array" ? Array.isArray(value)
        : typeof value === "object" && value !== null && !Array.isArray(value));
    if (!matches) errs.push(`${where}: not one of ${allowed.join("|")}`);
  }
  if (spec.minLength !== undefined && typeof value === "string" && value.length < spec.minLength) {
    errs.push(`${where}: shorter than minLength`);
  }
  return errs;
}

function schemaErrors(event: unknown, schema: EventSchema = eventSchema): string[] {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return ["event: not an object"];
  const record = event as Record<string, unknown>;
  const errs: string[] = [];
  for (const key of schema.required) if (!(key in record)) errs.push(`event.${key}: required but absent`);
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) if (!(key in schema.properties)) errs.push(`event.${key}: not allowed`);
  }
  for (const [key, value] of Object.entries(record)) {
    const spec = schema.properties[key];
    if (!spec) continue;
    if (spec.enum && !spec.enum.includes(value)) errs.push(`event.${key}: ${String(value)} not in enum`);
    errs.push(...typeErrors(value, spec, `event.${key}`));
    if (spec.type === "array" && Array.isArray(value)) {
      const item = spec.items ?? {};
      value.forEach((element, i) => {
        const where = `event.${key}[${i}]`;
        errs.push(...typeErrors(element, item, where));
        if (item.type === "object" && typeof element === "object" && element !== null) {
          const inner = element as Record<string, unknown>;
          for (const req of item.required ?? []) if (!(req in inner)) errs.push(`${where}.${req}: required but absent`);
          for (const [name, sub] of Object.entries(item.properties ?? {})) {
            if (name in inner) errs.push(...typeErrors(inner[name], sub, `${where}.${name}`));
          }
        }
      });
    }
  }
  return errs;
}

const allEvents: unknown[] = [
  ...conformance.fixtures.flatMap((f) => f.events),
  ...fuzz.logs.flatMap((l) => l.events),
];

describe("every fixture event is the shape event.schema.json describes", () => {
  it(`validates all ${allEvents.length} canonical events`, () => {
    expect(allEvents.flatMap((event) => schemaErrors(event))).toEqual([]);
  });
});

describe("event.schema.json constrains, and stops where admission begins", () => {
  const base = conformance.fixtures[0].events[0] as Record<string, unknown>;
  const mutate = (fn: (e: Record<string, unknown>) => void) => {
    const event = structuredClone(base);
    fn(event);
    return event;
  };

  it("the base event validates, or nothing below means anything", () => {
    expect(schemaErrors(base)).toEqual([]);
  });

  // A schema that accepts everything would pass the block above and be worthless.
  it.each<[string, (e: Record<string, unknown>) => void]>([
    ["missing actor", (e) => delete e.actor],
    ["missing clauses", (e) => delete e.clauses],
    ["actor not a string", (e) => { e.actor = 7; }],
    ["actor empty", (e) => { e.actor = ""; }],
    ["work_id a list", (e) => { e.work_id = ["W1"]; }],
    ["to not a list", (e) => { e.to = "B"; }],
    ["to holds a number", (e) => { e.to = ["B", 3]; }],
    ["parents holds an object", (e) => { e.parents = [{}]; }],
    ["payload a list", (e) => { e.payload = []; }],
    ["type outside the vocabulary", (e) => { e.type = "work.teleport"; }],
    ["unknown top-level field", (e) => { e.actor_name = "A"; }],
    ["clause without kind", (e) => { e.clauses = [{ verifier: "C" }]; }],
    ["clause not an object", (e) => { e.clauses = ["verify"]; }],
    ["idempotency_key a number", (e) => { e.idempotency_key = 1; }],
    ["version a number", (e) => { e.version = 2; }],
  ])("rejects %s", (_name, fn) => {
    expect(schemaErrors(mutate(fn))).not.toEqual([]);
  });

  // These are well-formed on purpose: admission rejects them, not the schema. Constraining
  // `version` or `clauses[].kind` here would stop the fixtures that carry them ever reaching
  // admission, and UNSUPPORTED_PROTOCOL and UNKNOWN_TYPED_CLAUSE could never be reproduced.
  it.each<[string, (e: Record<string, unknown>) => void]>([
    ["an unknown clause kind", (e) => { e.clauses = [{ kind: "priority", level: "high" }]; }],
    ["any protocol version", (e) => { e.version = "sha256:protocol-v9"; }],
    ["work_id null", (e) => { e.work_id = null; }],
    ["to empty", (e) => { e.to = []; }],
  ])("accepts %s, leaving it to admission", (_name, fn) => {
    expect(schemaErrors(mutate(fn))).toEqual([]);
  });
});

// Exact canonical conformance belongs to room.test.ts: abstract fixture actors, placeholder
// artifacts and service clock events cannot be submitted verbatim through an authenticated
// public endpoint. Its real boundary is covered by compiled-handler.test.ts and the HTTP/PG
// compiled E2E. Do not weaken authentication/artifact checks to imitate raw fixture transport.
