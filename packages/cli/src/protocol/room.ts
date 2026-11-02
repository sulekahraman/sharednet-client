/**
 * SharedNet V1 reference semantics, ported from `rac/protocol/protocol.py`.
 *
 * Admission (Eq. 5), the lifecycle projection (Tables 3 and 4), the closed predicate language,
 * deterministic replay (Eq. 6), and the content digest of the projection. A single-process model
 * of one Room: authentication is modelled by membership, and the canonical order is the order in
 * which events are ingested.
 *
 * The externally generated fixtures are the oracle. Every behaviour here is copied from the
 * reference rather than derived, because 2,493 events and 77 digests decide whether the copy is
 * right, and a "cleaner" rule that disagrees with them is simply wrong.
 */
import { createHash } from "node:crypto";

import type { CanonicalEvent } from "./envelope.ts";

export const PROTOCOL_V1 = "sha256:protocol-v1-d680a891c4c8063b";

const TERMINAL = new Set(["DECLINED", "REJECTED", "CANCELLED", "EXPIRED", "RESOLVED"]);
const LIFECYCLE_TYPES = new Set([
  "work.request", "work.accept", "work.decline", "work.result", "work.cancel",
  "work.resolve", "verification.pass", "verification.fail", "human.approve",
  "human.reject", "clock.tick",
]);
const ALL_TYPES = new Set([...LIFECYCLE_TYPES, "message"]);
const KNOWN_CLAUSES = new Set([
  "deliverables", "verify", "human_review", "quorum", "veto", "expire", "escalate",
  "cancel_if", "resolve_if",
]);
const VERIFY_TYPES = new Set(["verification.pass", "verification.fail", "human.approve", "human.reject"]);

export type RejectionCode =
  | "NOT_MEMBER" | "UNSUPPORTED_PROTOCOL" | "UNKNOWN_TYPE" | "MISSING_PARENT"
  | "UNKNOWN_TYPED_CLAUSE" | "ILLEGAL_TRANSITION" | "TARGET_MISMATCH" | "STALE_COMMITMENT"
  | "MISSING_EVIDENCE" | "DUPLICATE_VOTE" | "DUPLICATE_WORK" | "BAD_PREDICATE"
  | "CLOCK_NOT_MONOTONE" | "DUPLICATE" | "IDEMPOTENCY_CONFLICT" | "INVALID_EVENT";

export type Predicate =
  | { op: "and"; args: Predicate[] }
  | { op: "resolved" | "hasResult"; work: string }
  | { op: "satisfied"; work: string; requirement: string }
  | { op: "clock_ge"; t: number };

export type Requirement = {
  kind: string; eligible: string[]; q: number; predicate: Predicate | null;
  pos: string[]; neg: string[]; status: "open" | "satisfied" | "failed";
};
export type Guard =
  | { kind: "resolve_if" | "cancel_if"; predicate: Predicate }
  | { kind: "expire"; t: number; outcome: string }
  | { kind: "escalate"; target: string; predicate: Predicate };

export type Work = {
  state: string; requester: string; assignee_addressed: string[];
  responsible: string | null; accepted_by: string | null; result: string | null;
  artifacts: Record<string, unknown>; deliverables: string[];
  requirements: Record<string, Requirement>; veto: string[]; guards: Guard[];
  supersedes: unknown; resolver: unknown;
};
export type Projection = { work: Record<string, Work>; clock: number };
export type Result = {
  accepted: boolean; seq: number | null; code: RejectionCode | null;
  detail: string; binding: boolean; digest: string | null;
};

const reject = (code: RejectionCode, detail = ""): Result =>
  ({ accepted: false, seq: null, code, detail, binding: false, digest: null });
const accept = (): Result =>
  ({ accepted: true, seq: null, code: null, detail: "", binding: false, digest: null });

/**
 * Python's `json.dumps(obj, sort_keys=True, default=list)`, which is what the reference hashes.
 * Three details decide whether a digest matches: keys are sorted, the separators carry a space
 * (`", "` and `": "`) where `JSON.stringify` has none, and non-ASCII is escaped. Getting any of
 * them wrong produces a digest that is stable, plausible, and different from every fixture's.
 */
export function pythonJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    let out = "";
    for (const char of JSON.stringify(value).slice(1, -1).split("")) {
      const code = char.charCodeAt(0);
      out += code >= 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : char;
    }
    return `"${out}"`;
  }
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value instanceof Set) return pythonJson([...value]);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareCodePoints(a, b));
  return `{${entries.map(([k, v]) => `${pythonJson(k)}: ${pythonJson(v)}`).join(", ")}}`;
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const put = <T>(record: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
};

export const contentHash = (value: unknown): string =>
  "sha256:" + createHash("sha256").update(pythonJson(value)).digest("hex").slice(0, 24);

export const emptyProjection = (): Projection => ({ work: {}, clock: 0 });

const clone = <T>(value: T): T => structuredClone(value);

export function newWork(event: CanonicalEvent): Work {
  const requirements: Record<string, Requirement> = {};
  let deliverables: string[] = [];
  const veto = new Set<string>();
  const guards: Guard[] = [];
  event.clauses.forEach((clause, i) => {
    const kind = clause.kind;
    const rid = (clause.id as string | undefined) || `${kind}#${i}`;
    const predicate = (clause.predicate as Predicate | undefined) ?? null;
    if (kind === "deliverables") deliverables = [...(clause.names as string[])];
    else if (kind === "verify") {
      put(requirements, rid, { kind: "verify", eligible: [clause.verifier as string], q: 1, predicate, pos: [], neg: [], status: "open" });
    } else if (kind === "human_review") {
      put(requirements, rid, { kind: "human_review", eligible: [...((clause.scope as string[]) ?? [])], q: 1, predicate, pos: [], neg: [], status: "open" });
    } else if (kind === "quorum") {
      put(requirements, rid, { kind: "quorum", eligible: [...(clause.eligible as string[])], q: Number(clause.q), predicate, pos: [], neg: [], status: "open" });
    } else if (kind === "veto") for (const who of clause.eligible as string[]) veto.add(who);
    else if (kind === "resolve_if" || kind === "cancel_if") guards.push({ kind, predicate: clause.predicate as Predicate });
    else if (kind === "expire") guards.push({ kind: "expire", t: Number(clause.t), outcome: (clause.outcome as string) ?? "EXPIRED" });
    else if (kind === "escalate") guards.push({ kind: "escalate", target: clause.target as string, predicate: clause.predicate as Predicate });
  });
  return {
    state: "OPEN", requester: event.actor, assignee_addressed: [...event.to],
    responsible: null, accepted_by: null, result: null, artifacts: {},
    deliverables, requirements, veto: [...veto].sort(), guards,
    supersedes: event.refs.supersedes ?? null, resolver: event.payload.resolver ?? null,
  };
}

export function evalPredicate(proj: Projection, p: Predicate | null | undefined): boolean {
  if (p === null || p === undefined) return true;
  if (p.op === "and") return p.args.every((q) => evalPredicate(proj, q));
  if (p.op === "resolved") { const w = own(proj.work, p.work); return !!w && w.state === "RESOLVED"; }
  if (p.op === "hasResult") { const w = own(proj.work, p.work); return !!w && w.result !== null; }
  if (p.op === "satisfied") { const w = own(proj.work, p.work); return !!w && own(w.requirements, p.requirement)?.status === "satisfied"; }
  if (p.op === "clock_ge") return proj.clock >= Number(p.t);
  throw new Error(`unknown predicate op ${(p as { op: string }).op}`);
}

/** A predicate may only name items that already exist, or the item being created. */
export function predicateWellformed(proj: Projection, p: Predicate | null | undefined, selfId?: string | null): boolean {
  if (p === null || p === undefined) return true;
  if (!record(p)) return false;
  const op = p.op;
  if (op === "and") return Array.isArray(p.args) && p.args.every((q: unknown) =>
    record(q) && predicateWellformed(proj, q as Predicate, selfId));
  if (op === "resolved" || op === "hasResult" || op === "satisfied") {
    if (typeof p.work !== "string") return false;
    if (op === "satisfied" && typeof p.requirement !== "string") return false;
    return Object.hasOwn(proj.work, p.work) || p.work === selfId;
  }
  if (op === "clock_ge") return Number.isFinite(p.t);
  return false;
}

export function canResolve(proj: Projection, workId: string): boolean {
  const w = own(proj.work, workId);
  if (!w || w.state !== "REVIEW" || w.result === null) return false;
  if (Object.values(w.requirements).some((r) => r.status !== "satisfied")) return false;
  for (const g of w.guards) if (g.kind === "resolve_if" && !evalPredicate(proj, g.predicate)) return false;
  return true;
}

/** Table 3 preconditions. */
export function legal(proj: Projection, e: CanonicalEvent, roomService = "room_service"): Result {
  const W = proj.work;
  const w = e.work_id ? own(W, e.work_id) : undefined;
  const t = e.type;

  if (t === "clock.tick") {
    if (e.actor !== roomService) return reject("TARGET_MISMATCH", "clock.tick must come from the room service");
    if (Number(e.payload.t ?? -1) < proj.clock) return reject("CLOCK_NOT_MONOTONE");
    return accept();
  }

  if (t === "work.request") {
    if (!e.work_id || Object.hasOwn(W, e.work_id)) return reject("DUPLICATE_WORK", `work id ${e.work_id} already exists`);
    if (e.to.length === 0) return reject("TARGET_MISMATCH", "request needs an addressed assignee");
    const sup = e.refs.supersedes as string | undefined | null;
    if (sup !== undefined && sup !== null && (!Object.hasOwn(W, sup) || !TERMINAL.has(W[sup]!.state))) {
      return reject("STALE_COMMITMENT", "superseded item must exist and be terminal");
    }
    for (const c of e.clauses) {
      if ("predicate" in c && !predicateWellformed(proj, c.predicate as Predicate, e.work_id)) {
        return reject("BAD_PREDICATE");
      }
    }
    return accept();
  }

  if (!w) return reject("ILLEGAL_TRANSITION", "unknown work item");
  if (TERMINAL.has(w.state)) return reject("STALE_COMMITMENT", `item is terminal (${w.state})`);

  if (t === "work.accept" || t === "work.decline") {
    if (w.state !== "OPEN") return reject("ILLEGAL_TRANSITION", `proposal not live (${w.state})`);
    if (!w.assignee_addressed.includes(e.actor)) return reject("TARGET_MISMATCH", "only the addressed assignee may accept or decline");
    return accept();
  }

  if (t === "work.result") {
    if (w.state !== "COMMITTED") return reject("ILLEGAL_TRANSITION", `${e.work_id} is ${w.state}`);
    if (e.actor !== w.responsible) return reject("TARGET_MISMATCH", "only the responsible actor may attach a result");
    if (w.result !== null) return reject("ILLEGAL_TRANSITION", "item already has a result");
    const arts = (e.refs.artifacts as Record<string, unknown>) ?? {};
    const missing = w.deliverables.filter((n) => !Object.hasOwn(arts, n));
    if (missing.length > 0) return reject("MISSING_EVIDENCE", "missing deliverables: " + missing.join(","));
    return accept();
  }

  if (VERIFY_TYPES.has(t)) {
    if (w.state !== "REVIEW") return reject("ILLEGAL_TRANSITION", `${e.work_id} is ${w.state}, not in REVIEW`);
    if (e.refs.result_ref !== w.result) return reject("STALE_COMMITMENT", "evidence must reference the current result");
    const req = own(w.requirements, e.refs.requirement as string);
    if (!req || req.status !== "open") return reject("ILLEGAL_TRANSITION", "named requirement is not open");
    const human = t.startsWith("human.");
    if (human !== (req.kind === "human_review")) return reject("ILLEGAL_TRANSITION", "event kind does not match requirement kind");
    if (req.eligible.length > 0 && !req.eligible.includes(e.actor)) return reject("TARGET_MISMATCH", `only ${req.eligible} may verify`);
    if (req.pos.includes(e.actor) || req.neg.includes(e.actor)) return reject("DUPLICATE_VOTE");
    if (!human && !e.refs.evidence) return reject("MISSING_EVIDENCE", "verification needs bound evidence");
    return accept();
  }

  if (t === "work.resolve") {
    if (w.state !== "REVIEW") return reject("ILLEGAL_TRANSITION", "item not in REVIEW");
    if (e.actor !== w.requester && e.actor !== w.resolver) return reject("TARGET_MISMATCH", "only the requester may resolve");
    if (!canResolve(proj, e.work_id!)) return reject("MISSING_EVIDENCE", "resolve guard is false");
    return accept();
  }

  if (t === "work.cancel") {
    if (e.actor !== w.requester && e.actor !== w.resolver) return reject("TARGET_MISMATCH", "sender is neither requester nor coordinator");
    return accept();
  }

  return reject("UNKNOWN_TYPE");
}

/** Apply an already-accepted event. `hash` is the accepted event's own content hash. */
export function replayStep(projection: Projection, e: CanonicalEvent & { hash?: string }): Projection {
  const proj = clone(projection);
  const W = proj.work;
  const t = e.type;
  if (t === "message") return proj;
  if (t === "clock.tick") {
    proj.clock = Number(e.payload.t);
    for (const w of Object.values(W)) {
      if (TERMINAL.has(w.state)) continue;
      for (const g of w.guards) {
        if (g.kind === "expire" && proj.clock >= g.t) { w.state = g.outcome; w.responsible = null; }
        else if (g.kind === "cancel_if" && evalPredicate(proj, g.predicate)) { w.state = "CANCELLED"; w.responsible = null; }
      }
    }
    return proj;
  }
  if (t === "work.request") { put(W, e.work_id!, newWork(e)); return proj; }
  const w = W[e.work_id!]!;
  if (t === "work.accept") { w.state = "COMMITTED"; w.responsible = e.actor; w.accepted_by = e.actor; }
  else if (t === "work.decline") w.state = "DECLINED";
  else if (t === "work.result") {
    w.result = e.hash ?? contentHash(canonical(e));
    w.artifacts = { ...((e.refs.artifacts as Record<string, unknown>) ?? {}) };
    w.state = "REVIEW";
  } else if (t === "verification.pass" || t === "human.approve") {
    const req = w.requirements[e.refs.requirement as string]!;
    req.pos.push(e.actor);
    if (req.pos.length >= req.q && evalPredicate(proj, req.predicate)) req.status = "satisfied";
  } else if (t === "verification.fail" || t === "human.reject") {
    const req = w.requirements[e.refs.requirement as string]!;
    req.neg.push(e.actor);
    const failFast = req.kind === "verify" || req.kind === "human_review" || w.veto.includes(e.actor);
    const exhausted = req.eligible.length > 0 ? req.neg.length >= req.eligible.length - req.q + 1 : false;
    if (failFast || exhausted) { req.status = "failed"; w.state = "REJECTED"; w.responsible = null; }
  } else if (t === "work.resolve") { w.state = "RESOLVED"; w.responsible = null; }
  else if (t === "work.cancel") { w.state = "CANCELLED"; w.responsible = null; }

  // cancel_if guards react to lifecycle changes on other items.
  for (const other of Object.values(W)) {
    if (TERMINAL.has(other.state)) continue;
    for (const g of other.guards) {
      if (g.kind === "cancel_if" && evalPredicate(proj, g.predicate)) { other.state = "CANCELLED"; other.responsible = null; }
    }
  }
  return proj;
}

/** What the reference hashes for an event: its canonical fields, `version` included. */
function canonical(e: CanonicalEvent & { version?: string }): Record<string, unknown> {
  return {
    type: e.type, actor: e.actor, work_id: e.work_id, to: [...e.to],
    payload: e.payload, refs: e.refs, clauses: e.clauses,
    parents: [...e.parents], version: e.version ?? PROTOCOL_V1,
  };
}

export class Room {
  readonly members: Set<string>;
  readonly version: string;
  readonly roomService: string;
  readonly log: StoredEvent[] = [];
  private readonly hashes = new Set<string>();
  private readonly idem = new Map<string, { seq: number; body: string }>();
  projection: Projection = emptyProjection();

  constructor(members: string[], version = PROTOCOL_V1, roomService = "room_service") {
    this.members = new Set(members);
    this.version = version;
    this.roomService = roomService;
  }

  /** Restore admitted history; current membership applies only to future admission. */
  static restore(members: string[], events: readonly StoredEvent[], version = PROTOCOL_V1, roomService = "room_service"): Room {
    const room = new Room(members, version, roomService);
    room.projection = replayEvents(events);
    for (const event of events) {
      if ((event.version ?? PROTOCOL_V1) !== version) throw new Error("stored event protocol mismatch");
      room.log.push(clone(event));
      room.hashes.add(event.hash);
      if (event.idempotency_key) room.idem.set(idempotencyScope(event), { seq: event.seq, body: pythonJson(canonical(event)) });
    }
    return room;
  }

  digest(): string {
    return contentHash(this.projection);
  }

  /** Eq. 5, in the reference's order: membership, protocol, type, parents, clauses, then Table 3. */
  admit(e: CanonicalEvent & { version?: string }): Result {
    if (!validEventShape(e)) return reject("INVALID_EVENT");
    if (!this.members.has(e.actor) && !(e.type === "clock.tick" && e.actor === this.roomService)) {
      return reject("NOT_MEMBER");
    }
    if ((e.version ?? PROTOCOL_V1) !== this.version) return reject("UNSUPPORTED_PROTOCOL");
    if (!ALL_TYPES.has(e.type)) return reject("UNKNOWN_TYPE");
    for (const p of e.parents) if (!this.hashes.has(p)) return reject("MISSING_PARENT", p);
    for (const c of e.clauses) if (!KNOWN_CLAUSES.has(c.kind)) return reject("UNKNOWN_TYPED_CLAUSE", String(c.kind));
    if (e.type === "message") return accept();
    return legal(this.projection, e, this.roomService);
  }

  ingest(e: CanonicalEvent & { version?: string }): Result {
    if (!validEventShape(e)) return reject("INVALID_EVENT");
    if (!this.members.has(e.actor) && !(e.type === "clock.tick" && e.actor === this.roomService)) {
      return reject("NOT_MEMBER");
    }
    if ((e.version ?? PROTOCOL_V1) !== this.version) return reject("UNSUPPORTED_PROTOCOL");
    const key = idempotencyScope(e);
    const body = pythonJson(canonical(e));
    const previous = e.idempotency_key ? this.idem.get(key) : undefined;
    if (previous) {
      if (previous.body !== body) return reject("IDEMPOTENCY_CONFLICT", "idempotency key already used for another body");
      return { accepted: true, seq: previous.seq, code: "DUPLICATE",
               detail: "idempotent replay; not re-applied", binding: false, digest: this.digest() };
    }
    const res = this.admit(e);
    if (!res.accepted) return res;
    const before = this.digest();
    const seq = this.log.length + 1;
    const hash = contentHash({ seq, ...canonical(e) });
    const stored = clone({ ...e, seq, hash });
    const projection = replayStep(this.projection, stored);
    this.log.push(stored);
    this.hashes.add(hash);
    if (e.idempotency_key) this.idem.set(key, { seq, body });
    this.projection = projection;
    const after = this.digest();
    return { accepted: true, seq, code: null, detail: "", binding: before !== after, digest: after };
  }
}

export type StoredEvent = CanonicalEvent & { seq: number; hash: string; version?: string };

/** Fold persisted canonical records in their admitted order, without authorizing past actors. */
export function replayEvents(events: readonly StoredEvent[]): Projection {
  let projection = emptyProjection();
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1) throw new Error("stored event sequence is not contiguous");
    if (!validEventShape(event)) throw new Error("invalid stored event shape");
    if (event.hash !== contentHash({ seq: event.seq, ...canonical(event) })) throw new Error("stored event hash mismatch");
    projection = replayStep(projection, event);
  }
  return projection;
}

function idempotencyScope(event: CanonicalEvent): string {
  return JSON.stringify([event.actor, event.idempotency_key]);
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Runtime boundary for callers that do not pass through the envelope adapter. */
function validEventShape(event: unknown): event is CanonicalEvent & { version?: string } {
  if (!record(event) || typeof event.type !== "string" || typeof event.actor !== "string" ||
      !(event.work_id === null || typeof event.work_id === "string") || !strings(event.to) ||
      !record(event.payload) || !record(event.refs) || !strings(event.parents) ||
      !(event.idempotency_key === null || typeof event.idempotency_key === "string") ||
      !(event.version === undefined || typeof event.version === "string") || !Array.isArray(event.clauses)) return false;
  for (const key of ["supersedes", "result_ref", "requirement", "evidence"]) {
    const value = event.refs[key];
    if (value !== undefined && value !== null && typeof value !== "string") return false;
  }
  if (event.refs.artifacts !== undefined && !record(event.refs.artifacts)) return false;
  if (event.type === "clock.tick" && !Number.isFinite(event.payload.t)) return false;
  return event.clauses.every((clause: unknown) => {
    if (!record(clause) || typeof clause.kind !== "string") return false;
    if (clause.id !== undefined && typeof clause.id !== "string") return false;
    switch (clause.kind) {
      case "deliverables": return strings(clause.names);
      case "verify": return typeof clause.verifier === "string";
      case "human_review": return clause.scope === undefined || strings(clause.scope);
      case "quorum": return strings(clause.eligible) && Number.isInteger(clause.q) && Number(clause.q) >= 1;
      case "veto": return strings(clause.eligible);
      case "expire": return Number.isFinite(clause.t) && (clause.outcome === undefined || typeof clause.outcome === "string");
      case "escalate": return typeof clause.target === "string";
      default: return true;
    }
  });
}
