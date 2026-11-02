/**
 * Envelope to canonical event.
 *
 * An agent posts an envelope (`fixtures/envelope.schema.json`); a Room turns it into the canonical
 * event the reference semantics admit or reject (`fixtures/event.schema.json`). This is a port of
 * `rac/rooms/envelope.py` in the research repository, which owns the protocol — behaviour is
 * copied, not designed, so that the same envelope becomes the same event on both sides.
 *
 * Two things here are easy to get wrong and are load-bearing:
 *
 *  - `actor` is never read from the envelope. The Room supplies it from the authenticated sender,
 *    which is why an agent cannot claim to have been someone else. The wire schema has no `actor`
 *    property and forbids unknown ones, so an envelope carrying it fails validation rather than
 *    being quietly ignored.
 *  - The conversion is *not* a pure function of the envelope. Four verification types read
 *    `refs.result_ref` out of the Room's current projection, so the projection is a parameter.
 */
import { referenceEnvelopeSchema } from "./envelope-schema.ts";

// Static import keeps the pinned schema available in both native Node and deployed bundles.
const REFERENCE_ENVELOPE_SCHEMA = referenceEnvelopeSchema as unknown as JsonSchema;

// Service extensions are kept separate from the pinned external reference fixtures.
const ENVELOPE_SCHEMA: JsonSchema = {
  ...REFERENCE_ENVELOPE_SCHEMA,
  properties: {
    ...REFERENCE_ENVELOPE_SCHEMA.properties,
    result_ref: { type: "string" },
    parents: { type: "array", items: { type: "string" } },
  },
};

/**
 * The keywords this validator implements. Anything else in the schema is a keyword we do not
 * enforce, so it fails closed rather than passing silently the day the schema grows one.
 */
const KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type", "required", "properties",
  "oneOf", "enum", "const", "pattern", "additionalProperties", "items", "minItems", "minimum",
]);

type JsonSchema = {
  $ref?: string;
  oneOf?: JsonSchema[];
  type?: "object" | "array" | "string" | "integer";
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  minItems?: number;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  $defs?: Record<string, JsonSchema>;
  [key: string]: unknown;
};

export class EnvelopeError extends Error {
  readonly code: string = "INVALID_ENVELOPE";
}

/** Well-formed on the wire, but with no canonical meaning. Distinct from a malformed envelope. */
export class UnsupportedEnvelopeError extends EnvelopeError {
  override readonly code = "UNSUPPORTED_ENVELOPE";
}

function resolveRef(ref: string): JsonSchema {
  let target: unknown = ENVELOPE_SCHEMA;
  for (const key of ref.replace(/^#\//, "").split("/")) {
    target = (target as Record<string, unknown>)[key];
  }
  return target as JsonSchema;
}

/** Validate against the checked-in wire schema, implementing the vocabulary that schema uses. */
export function validateEnvelope(value: unknown, schema: JsonSchema = ENVELOPE_SCHEMA, path = "envelope"): void {
  const unknown = Object.keys(schema).filter((key) => !KEYWORDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported envelope schema keywords: ${unknown.sort().join(", ")}`);
  }
  if (schema.$ref) {
    validateEnvelope(value, resolveRef(schema.$ref), path);
    return;
  }
  if (schema.oneOf) {
    let matches = 0;
    for (const choice of schema.oneOf) {
      try {
        validateEnvelope(value, choice, path);
        matches += 1;
      } catch (error) {
        if (!(error instanceof EnvelopeError)) throw error;
      }
    }
    if (matches !== 1) throw new EnvelopeError(`${path} must match exactly one schema alternative`);
  }
  if (schema.type) {
    const ok = schema.type === "object"
      ? typeof value === "object" && value !== null && !Array.isArray(value)
      : schema.type === "array" ? Array.isArray(value)
      : schema.type === "string" ? typeof value === "string"
      : Number.isInteger(value);
    if (!ok) throw new EnvelopeError(`${path} must be ${schema.type}`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new EnvelopeError(`${path} is not an allowed value`);
  if ("const" in schema && value !== schema.const) throw new EnvelopeError(`${path} must be ${String(schema.const)}`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value as string)) {
    throw new EnvelopeError(`${path} has an invalid format`);
  }
  if (schema.minimum !== undefined && (value as number) < schema.minimum) {
    throw new EnvelopeError(`${path} is below ${schema.minimum}`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const missing = (schema.required ?? []).filter((key) => !Object.hasOwn(record, key)).sort();
    if (missing.length > 0) throw new EnvelopeError(`${path} missing ${missing.join(", ")}`);
    const properties = schema.properties ?? {};
    const extra = schema.additionalProperties ?? true;
    for (const [key, item] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) validateEnvelope(item, properties[key]!, `${path}.${key}`);
      else if (extra === false) throw new EnvelopeError(`${path} has unknown field ${key}`);
      else if (typeof extra === "object") validateEnvelope(item, extra, `${path}.${key}`);
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) {
      throw new EnvelopeError(`${path} needs at least ${schema.minItems} items`);
    }
    value.forEach((item, i) => validateEnvelope(item, schema.items ?? {}, `${path}[${i}]`));
  }
}

export type Clause = { kind: string; [key: string]: unknown };

export type CanonicalEvent = {
  type: string;
  actor: string;
  work_id: string | null;
  to: string[];
  payload: Record<string, unknown>;
  refs: Record<string, unknown>;
  clauses: Clause[];
  parents: string[];
  idempotency_key: string | null;
};

/** What the four verification types read out of: `work[work_id].result`. */
export type Projection = { work: Record<string, { result?: unknown } | undefined> };

const VERIFICATION_TYPES = new Set(["verification.pass", "verification.fail", "human.approve", "human.reject"]);

/**
 * `actor` is the authenticated sender, never the envelope. `projection` is the Room's current
 * projection, read only by the verification types for `refs.result_ref`.
 */
export function toCanonicalEvent(
  actor: string, envelope: unknown, projection: Projection,
  // Production mode requires both evidence and the exact reviewed result. Defaults preserve
  // the external reference adapter for conformance callers; service callers must opt in.
  options: { requireEvidence?: boolean } = {},
): CanonicalEvent {
  validateEnvelope(envelope);
  const env = structuredClone(envelope) as Record<string, unknown>;
  const type = env.type as string;

  // Reserved rather than rejected as malformed: the wire schema has no field for the clock's `t`,
  // so an agent cannot express one. Rooms emit these as canonical service events themselves.
  if (type === "clock.tick") {
    throw new UnsupportedEnvelopeError(
      "clock.tick is reserved: the wire schema has no clock t field; use canonical service events",
    );
  }

  const clauses = (env.requires ?? []) as Clause[];
  for (const clause of clauses) {
    if (clause.kind === "verified_by") {
      if ("deadline" in clause) {
        throw new UnsupportedEnvelopeError(
          "verified_by.deadline has no canonical semantics; use an explicit expire clause",
        );
      }
      // The agent-facing name and the canonical one meet here, and nowhere else.
      clause.kind = "verify";
      clause.id = `verify:${String(clause.verifier)}`;
    }
  }

  const refs: Record<string, unknown> = {};
  for (const key of ["artifacts", "supersedes"] as const) {
    if (key in env) refs[key] = env[key];
  }
  if (VERIFICATION_TYPES.has(type)) {
    if (options.requireEvidence && (typeof env.evidence !== "string" || !env.evidence.trim())) {
      throw new EnvelopeError("review requires explicit evidence");
    }
    if (options.requireEvidence && (typeof env.result_ref !== "string" || !env.result_ref.trim())) {
      throw new EnvelopeError("review requires an explicit result_ref");
    }
    const workId = env.work_id as string;
    refs.result_ref = env.result_ref ?? (Object.hasOwn(projection.work, workId) ? projection.work[workId]?.result : null) ?? null;
    refs.requirement = env.requirement || `verify:${actor}`;
    refs.evidence = env.evidence || "sha256:review-note";
  }

  const payload: Record<string, unknown> = {};
  for (const key of ["task", "note", "text"] as const) {
    if (key in env) payload[key] = env[key];
  }

  return {
    type,
    actor,
    work_id: (env.work_id as string | undefined) ?? null,
    to: env.to ? [env.to as string] : [],
    payload,
    refs,
    clauses,
    parents: (env.parents as string[] | undefined) ?? [],
    idempotency_key: (env.idempotency_key as string | undefined) ?? null,
  };
}
