import { describe, expect, it } from "vitest";

import {
  EnvelopeError,
  UnsupportedEnvelopeError,
  toCanonicalEvent,
  validateEnvelope,
  type Projection,
} from "./envelope.ts";

const EMPTY: Projection = { work: {} };
const convert = (envelope: unknown, actor = "A", projection: Projection = EMPTY) =>
  toCanonicalEvent(actor, envelope, projection);

describe("the wire schema decides what is an envelope at all", () => {
  it("refuses an envelope that supplies actor, rather than ignoring it", () => {
    // The Room fills `actor` from the credential. The schema has no such property and forbids
    // unknown ones, so a forged sender is rejected at the door instead of silently dropped.
    expect(() => convert({ type: "message", text: "hi", actor: "B" })).toThrow(EnvelopeError);
    expect(() => convert({ type: "message", text: "hi", actor: "B" })).toThrow(/unknown field actor/);
  });

  it.each([
    ["no type", {}],
    ["a type outside the vocabulary", { type: "work.teleport" }],
    ["to as a list", { type: "work.request", to: ["B"] }],
    ["work_id that is not an id", { type: "work.request", work_id: "" }],
    ["text that is not a string", { type: "message", text: 7 }],
    ["artifacts holding a number", { type: "work.result", artifacts: { patch: 1 } }],
    ["requires that is not a list", { type: "work.request", requires: {} }],
  ])("refuses %s", (_name, envelope) => {
    expect(() => convert(envelope)).toThrow(EnvelopeError);
  });

  it("fails closed when the schema grows a keyword this validator does not implement", () => {
    // Not an EnvelopeError: the envelope may be fine and we simply cannot tell any more.
    expect(() => validateEnvelope({ type: "message" }, { type: "object", maxProperties: 1 } as never))
      .toThrow(/unsupported envelope schema keywords: maxProperties/);
  });
});

describe("every clause kind the wire schema defines", () => {
  const withClause = (clause: unknown) => convert({ type: "work.request", work_id: "W1", requires: [clause] });

  it.each([
    ["deliverables", { kind: "deliverables", names: ["patch"] }],
    ["human_review", { kind: "human_review", scope: ["C"] }],
    ["quorum", { kind: "quorum", q: 2, eligible: ["C", "D"] }],
    ["veto", { kind: "veto", eligible: ["E"] }],
    ["expire", { kind: "expire", t: 5, outcome: "EXPIRED" }],
    ["escalate", { kind: "escalate", target: "D", predicate: { op: "resolved", work: "W1" } }],
    ["cancel_if", { kind: "cancel_if", predicate: { op: "resolved", work: "W1" } }],
    ["resolve_if", { kind: "resolve_if", predicate: { op: "resolved", work: "W1" } }],
  ])("accepts %s and carries it through unchanged", (_name, clause) => {
    expect(withClause(clause).clauses).toEqual([clause]);
  });

  it.each([
    ["deliverables without names", { kind: "deliverables" }],
    ["deliverables with an empty names list", { kind: "deliverables", names: [] }],
    ["quorum without eligible", { kind: "quorum", q: 2 }],
    ["quorum with q below one", { kind: "quorum", q: 0, eligible: ["C"] }],
    ["veto without eligible", { kind: "veto" }],
    ["expire without t", { kind: "expire" }],
    ["escalate without a predicate", { kind: "escalate", target: "D" }],
    ["a kind the schema does not define", { kind: "priority", level: "high" }],
    ["an unknown field on a known kind", { kind: "veto", eligible: ["E"], why: "because" }],
  ])("refuses %s", (_name, clause) => {
    expect(() => withClause(clause)).toThrow(EnvelopeError);
  });

  it("renames verified_by to verify and gives it the id the canonical form carries", () => {
    const event = withClause({ kind: "verified_by", verifier: "C" });
    expect(event.clauses).toEqual([{ kind: "verify", verifier: "C", id: "verify:C" }]);
  });

  it("refuses verified_by.deadline as unsupported rather than malformed", () => {
    // It validates against the wire schema; it simply has no canonical meaning.
    const call = () => withClause({ kind: "verified_by", verifier: "C", deadline: 5 });
    expect(call).toThrow(UnsupportedEnvelopeError);
    expect(call).toThrow(/use an explicit expire clause/);
  });

  it("does not mutate the caller's envelope while renaming", () => {
    const envelope = { type: "work.request", work_id: "W1", requires: [{ kind: "verified_by", verifier: "C" }] };
    convert(envelope);
    expect(envelope.requires[0]).toEqual({ kind: "verified_by", verifier: "C" });
  });
});

describe("every predicate shape the wire schema defines", () => {
  const withPredicate = (predicate: unknown) =>
    convert({ type: "work.request", work_id: "W1", requires: [{ kind: "resolve_if", predicate }] });

  it.each([
    ["resolved", { op: "resolved", work: "W1" }],
    ["hasResult", { op: "hasResult", work: "W1" }],
    ["satisfied", { op: "satisfied", work: "W1", requirement: "verify:C" }],
    ["clock_ge", { op: "clock_ge", t: 3 }],
    ["and", { op: "and", args: [{ op: "resolved", work: "W1" }, { op: "hasResult", work: "W2" }] }],
  ])("accepts %s", (_name, predicate) => {
    expect(withPredicate(predicate).clauses[0]!.predicate).toEqual(predicate);
  });

  it.each([
    ["an unknown op", { op: "maybe", work: "W1" }],
    ["resolved without work", { op: "resolved" }],
    ["satisfied without requirement", { op: "satisfied", work: "W1" }],
    ["clock_ge with a non-integer t", { op: "clock_ge", t: 1.5 }],
    ["and without args", { op: "and" }],
    ["and holding a malformed arg", { op: "and", args: [{ op: "resolved" }] }],
  ])("refuses %s", (_name, predicate) => {
    expect(() => withPredicate(predicate)).toThrow(EnvelopeError);
  });
});

describe("the mapping onto the canonical shape", () => {
  it("maps the RAC envelope that is in production today, so the trailer can move as it is", () => {
    // From a recorded compiled Room. `to` is a role name, and stays an opaque string.
    const event = convert({ type: "work.request", work_id: "W1", to: "builder-1", task: "…" });
    expect(event).toEqual({
      type: "work.request",
      actor: "A",
      work_id: "W1",
      to: ["builder-1"],
      payload: { task: "…" },
      refs: {},
      clauses: [],
      parents: [],
      idempotency_key: null,
    });
  });

  it("turns the single to into a one-element list, and its absence into an empty one", () => {
    expect(convert({ type: "work.request", work_id: "W1", to: "B" }).to).toEqual(["B"]);
    expect(convert({ type: "work.request", work_id: "W1" }).to).toEqual([]);
  });

  it("splits the flat envelope into payload and refs", () => {
    const event = convert({
      type: "work.result",
      work_id: "W1",
      note: "done",
      artifacts: { patch: "sha256:abc" },
      supersedes: "W0",
      idempotency_key: "k1",
    });
    expect(event.payload).toEqual({ note: "done" });
    expect(event.refs).toEqual({ artifacts: { patch: "sha256:abc" }, supersedes: "W0" });
    expect(event.idempotency_key).toBe("k1");
  });

  it("takes actor from the sender and never from the body", () => {
    expect(convert({ type: "message", text: "hi" }, "room_service").actor).toBe("room_service");
  });

  it("reserves clock.tick, which no envelope can express", () => {
    const call = () => convert({ type: "clock.tick" });
    expect(call).toThrow(UnsupportedEnvelopeError);
    expect(call).toThrow(/reserved/);
  });
});

describe("the four verification types read the Room's projection", () => {
  const projection: Projection = { work: { W1: { result: "sha256:result-of-W1" } } };

  it.each(["verification.pass", "verification.fail", "human.approve", "human.reject"])(
    "%s takes result_ref from the projection and defaults requirement and evidence",
    (type) => {
      const event = convert({ type, work_id: "W1" }, "C", projection);
      expect(event.refs).toEqual({
        result_ref: "sha256:result-of-W1",
        requirement: "verify:C",
        evidence: "sha256:review-note",
      });
    },
  );

  it("prefers what the envelope states over the defaults", () => {
    const event = convert(
      { type: "verification.pass", work_id: "W1", requirement: "verify:D", evidence: "sha256:ran-the-suite" },
      "C",
      projection,
    );
    expect(event.refs.requirement).toBe("verify:D");
    expect(event.refs.evidence).toBe("sha256:ran-the-suite");
  });

  it("yields a null result_ref when the work has none yet, rather than dropping the key", () => {
    expect(convert({ type: "verification.pass", work_id: "W9" }, "C", projection).refs.result_ref).toBeNull();
  });

  it("leaves refs alone for every other type", () => {
    expect(convert({ type: "work.accept", work_id: "W1" }, "B", projection).refs).toEqual({});
  });
});

describe("service envelope extensions and strict evidence", () => {
  it("preserves explicit result references and causal parents", () => {
    const event = convert({ type: "verification.pass", work_id: "W1", result_ref: "sha256:old", parents: ["sha256:parent"], evidence: "report" }, "C", { work: { W1: { result: "sha256:new" } } });
    expect(event.refs.result_ref).toBe("sha256:old");
    expect(event.parents).toEqual(["sha256:parent"]);
  });

  it.each(["verification.pass", "verification.fail", "human.approve", "human.reject"])("requires real evidence in strict service conversion for %s", (type) => {
    expect(() => toCanonicalEvent("C", { type, work_id: "W1" }, EMPTY, { requireEvidence: true })).toThrow(EnvelopeError);
    expect(() => toCanonicalEvent("C", { type, work_id: "W1", evidence: "   " }, EMPTY, { requireEvidence: true })).toThrow(EnvelopeError);
    expect(toCanonicalEvent("C", { type, work_id: "W1", evidence: "report", result_ref: "sha256:result" }, EMPTY, { requireEvidence: true }).refs.evidence).toBe("report");
  });

  it.each([{ type: "message", result_ref: 1 }, { type: "message", parents: "parent" }, JSON.parse('{"type":"message","__proto__":{}}'), { type: "message", constructor: "evil" }])("refuses malformed extensions and unknown prototype field (%j)", (envelope) => {
    expect(() => convert(envelope)).toThrow(EnvelopeError);
  });

  it("does not accept inherited required fields", () => {
    expect(() => convert(Object.create({ type: "message" }))).toThrow(EnvelopeError);
  });
});

it("strict service reviews require an explicit result reference", () => {
  expect(() => toCanonicalEvent("C", { type: "verification.pass", work_id: "W1", evidence: "report" }, EMPTY, { requireEvidence: true })).toThrow(/result_ref/);
});
