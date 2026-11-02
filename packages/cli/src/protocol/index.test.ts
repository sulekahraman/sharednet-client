import { describe, expect, it } from "vitest";

import type { InstanceDirectoryResponse } from "./index.ts";

import {
  parseStartCliLoginRequest,
  CLI_LOGIN_CODE_PATTERN,
  normalizeCliLoginCode,
  generateCliLoginCode,
  HUMAN_RUNTIME_KIND,
  RUNNER_RUNTIME_KIND,
  fitSeatName,
  isServiceRuntimeKind,
  parseCloseRoomRequest,
  parseGoalTrigger,
  parseOwnerMessageRequest,
  parseStartGoalRequest,
  serviceGoalTriggers,
  KNOWN_RUNTIME_KINDS,
  parseRuntimeReport,
  encodeInboxCursor,
  parseInboxCursor,
  ROUTE_CATALOGUE,
  DISCOVERY_DOCUMENT,
  OPENAPI_DOCUMENT,
  parseJoinRoomWithInviteRequest,
  presenceFor,
  PUBLIC_ID_PATTERN,
  SAFE_ERROR_MESSAGES,
  SNI_SECRET_PATTERN,
  SNK_SECRET_PATTERN,
  ProtocolValidationError,
  createErrorEnvelope,
  digestSecret,
  generatePublicId,
  generateRequestId,
  generateSecret,
  isPublicId,
  parseCreateRoomRequest,
  parsePostMessageRequest,
  parseSubscriptionHeartbeatRequest,
  parseStartInstanceRequest,
  verifySecretDigest,
  redactSecrets,
  SHR_SECRET_PATTERN,
  runtimeMetadataFor,
  SHARED_RUNTIME_METADATA_KEYS,
  followingDue,
  isMentioned,
  mentionedSeats,
  nextCronUtc,
  parseCronExpression,
  timerSchedule,
} from "./index.ts";

describe("public IDs and credentials", () => {
  it.each(["p", "key", "a", "i", "rom", "msg", "dec"] as const)(
    "generates an opaque %s ID with the normative format",
    (prefix) => {
      const id = generatePublicId(prefix);

      expect(id).toMatch(PUBLIC_ID_PATTERN);
      expect(isPublicId(id, prefix)).toBe(true);
      expect(isPublicId(id, prefix === "p" ? "a" : "p")).toBe(false);
    },
  );

  it("generates a request ID and both 256-bit secret formats", () => {
    expect(generateRequestId()).toMatch(/^req_[0-9A-Za-z]{10}$/);
    expect(generateSecret("snk")).toMatch(SNK_SECRET_PATTERN);
    expect(generateSecret("sni")).toMatch(SNI_SECRET_PATTERN);
  });

  it("digests and compares a secret without retaining the raw value", () => {
    const secret = generateSecret("sni");
    const digest = digestSecret(secret);

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(secret);
    expect(verifySecretDigest(secret, digest)).toBe(true);
    expect(verifySecretDigest(generateSecret("sni"), digest)).toBe(false);
  });
});

describe("strict request parsing", () => {
  it("bounds active-turn heartbeats to the stored Room sequence domain", () => {
    expect(parseSubscriptionHeartbeatRequest({ through: 42 })).toEqual({ through: 42 });
    expect(() => parseSubscriptionHeartbeatRequest({ through: Number.MAX_SAFE_INTEGER })).toThrow(ProtocolValidationError);
    expect(() => parseSubscriptionHeartbeatRequest({ through: 42, active: true })).toThrow(ProtocolValidationError);
    expect(() => parseSubscriptionHeartbeatRequest({})).toThrow(ProtocolValidationError);
  });

  it("accepts only the bounded Instance registration payload", () => {
    expect(
      parseStartInstanceRequest({ runtime_kind: "codex", cli_version: "1.0.0" }),
    ).toEqual({ runtime_kind: "codex", cli_version: "1.0.0" });

    expect(() =>
      parseStartInstanceRequest({
        runtime_kind: "codex",
        cli_version: "1.0.0",
        provider_session_id: "must-not-be-uploaded",
      }),
    ).toThrow(ProtocolValidationError);
  });

  it("rejects unknown Room fields and normalizes only the Room name", () => {
    expect(parseCreateRoomRequest({ name: "  Team\u212A  ", description: " keep " })).toEqual({
      name: "TeamK",
      description: " keep ",
    });

    expect(() => parseCreateRoomRequest({ name: "room", visibility: "public" })).toThrow(
      ProtocolValidationError,
    );
  });

  it("preserves Message content while enforcing whitespace and UTF-8 byte limits", () => {
    const content = "  hello, agents  \n";
    expect(parsePostMessageRequest({ content })).toEqual({ content });
    expect(() => parsePostMessageRequest({ content: "\u2003\n\t" })).toThrow(
      ProtocolValidationError,
    );
    expect(() => parsePostMessageRequest({ content: "😀".repeat(8_193) })).toThrow(
      ProtocolValidationError,
    );
    expect(parsePostMessageRequest({ content: "😀".repeat(8_192) }).content).toHaveLength(
      16_384,
    );
  });
});

describe("safe errors and public documentation", () => {
  it("uses static messages and never reflects credential fragments", () => {
    const secret = generateSecret("snk");
    const requestId = generateRequestId();
    const envelope = createErrorEnvelope("invalid_credentials", requestId);
    const serialized = JSON.stringify(envelope);

    expect(envelope.error.message).toBe(SAFE_ERROR_MESSAGES.invalid_credentials);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secret.slice(0, 8));

    let validationError: unknown;
    try {
      parseStartInstanceRequest({
        runtime_kind: "codex",
        cli_version: "1.0.0",
        leaked_token: secret,
      });
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeInstanceOf(ProtocolValidationError);
    expect(String(validationError)).not.toContain(secret);
    expect(String(validationError)).not.toContain(secret.slice(0, 8));
  });

  it("publishes version-aligned discovery and OpenAPI documents", () => {
    expect(DISCOVERY_DOCUMENT.service).toBe("sharednet");
    expect(DISCOVERY_DOCUMENT.capabilities).toEqual([
      "identity.principal",
      "agents",
      "instances.lease",
      "rooms",
      "rooms.messages",
      "rooms.invites",
      "rooms.wait",
      "rooms.inbox",
      "decisions.approval",
      "decisions.text",
      "decisions.resolve",
      "instances.reach",
      "rooms.members",
      "network",
      "credits",
      "artifacts",
    ]);
    expect(DISCOVERY_DOCUMENT.limits.wait_max_seconds).toBe(25);
    expect(DISCOVERY_DOCUMENT.limits.invite_default_seconds).toBe(0);
    expect(OPENAPI_DOCUMENT.info.version).toBe(DISCOVERY_DOCUMENT.protocol_version);
    expect(OPENAPI_DOCUMENT["x-sharednet-capabilities"]).toEqual(
      DISCOVERY_DOCUMENT.capabilities,
    );
    expect(OPENAPI_DOCUMENT.paths[DISCOVERY_DOCUMENT.openapi_url]).toBeDefined();
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms/{room_id}/messages"]).toBeDefined();
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms/{room_id}/wait"].get.security).toEqual([
      { instanceToken: [] },
      { roomMemberToken: [] },
    ]);
  });

  it("publishes the caller-owned Instance directory contract", () => {
    const response = {
      instances: [
        {
          instance_id: "i_AbCdEfGhIj",
          name: "researcher",
          agent: { agent_id: "a_AbCdEfGhIj", name: "Researcher" },
          driver: "codex",
          state: "working",
          detail: "replying in Research",
          last_seen_at: "2026-10-19T08:00:00.000Z",
        },
      ],
    } satisfies InstanceDirectoryResponse;

    expect(response.instances[0]?.state).toBe("working");
    expect(ROUTE_CATALOGUE).toContainEqual({
      method: "GET",
      path: "/api/v1/instances",
      auth: "any",
      operationId: "listInstances",
    });

    const operation = OPENAPI_DOCUMENT.paths["/api/v1/instances"].get;
    expect(operation.security).toEqual([
      { accountApiKey: [] },
      { instanceToken: [] },
    ]);
    const schema = operation.responses["200"].content["application/json"].schema;
    expect(schema.required).toEqual(["instances"]);
    expect(schema.properties.instances.items.required).toEqual([
      "instance_id",
      "name",
      "agent",
      "driver",
      "state",
      "detail",
      "last_seen_at",
    ]);
    expect(schema.properties.instances.items.properties.state.enum).toEqual([
      "online",
      "working",
      "offline",
    ]);
  });

  it("round-trips an inbox cursor and rejects anything that is not one", () => {
    const position = {
      created_at: "2026-09-05T12:00:00.000Z",
      room_id: "rom_AbCdEfGhIj",
      sequence: 7,
    } as const;
    const cursor = encodeInboxCursor(position);
    expect(cursor).toMatch(/^ibx_[A-Za-z0-9_-]+$/);
    expect(parseInboxCursor(cursor)).toEqual(position);
    expect(parseInboxCursor("7")).toBeNull();
    expect(parseInboxCursor("ibx_")).toBeNull();
    expect(parseInboxCursor(`ibx_${Buffer.from("not-a-date\nrom_AbCdEfGhIj\n1").toString("base64url")}`)).toBeNull();
    expect(parseInboxCursor(`ibx_${Buffer.from("2026-09-05T12:00:00.000Z\nmsg_x\n1").toString("base64url")}`)).toBeNull();
    expect(parseInboxCursor(`ibx_${Buffer.from("2026-09-05T12:00:00.000Z\nrom_AbCdEfGhIj\n0").toString("base64url")}`)).toBeNull();
    expect(OPENAPI_DOCUMENT.paths["/api/v1/inbox"].get.security).toEqual([
      { instanceToken: [] },
      { roomMemberToken: [] },
    ]);
    expect(ROUTE_CATALOGUE.some((route) => route.operationId === "listInbox")).toBe(true);
  });

  it("derives presence from the last authenticated request, not a heartbeat", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    expect(presenceFor(null, now)).toBe("offline");
    expect(presenceFor("2026-09-05T11:59:30Z", now)).toBe("online");
    expect(presenceFor("2026-09-05T11:55:00Z", now)).toBe("away");
    expect(presenceFor("2026-09-05T11:00:00Z", now)).toBe("offline");
  });

  it("mints CLI login codes from an unambiguous alphabet and normalises what a human types", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateCliLoginCode()).toMatch(CLI_LOGIN_CODE_PATTERN);
    }
    expect(normalizeCliLoginCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(normalizeCliLoginCode(" abcd efgh ")).toBe("ABCD-EFGH");
    expect(normalizeCliLoginCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(normalizeCliLoginCode("ABCD-EFG0")).toBeNull();
    expect(normalizeCliLoginCode("ABC-DEFGH")).toBe("ABCD-EFGH");
    expect(normalizeCliLoginCode("ABCDEFG")).toBeNull();
    expect(parseStartCliLoginRequest(undefined)).toEqual({});
    expect(parseStartCliLoginRequest({ label: "  laptop ", seats: [`sni_${"a".repeat(43)}`] })).toEqual({
      label: "laptop",
      seats: [`sni_${"a".repeat(43)}`],
    });
    expect(() => parseStartCliLoginRequest({ seats: ["rit_nope"] })).toThrow();
    expect(() => parseStartCliLoginRequest({ label: "x".repeat(121) })).toThrow();
    expect(ROUTE_CATALOGUE.map((route) => route.operationId)).toEqual(
      expect.arrayContaining(["startCliLogin", "pollCliLogin"]),
    );
  });

  it("accepts any well-formed driver handle and a bounded runtime report", () => {
    expect(parseStartInstanceRequest({ runtime_kind: "opencode", cli_version: "1.0.0" }).runtime_kind).toBe("opencode");
    expect(() => parseStartInstanceRequest({ runtime_kind: "Claude Code", cli_version: "1.0.0" })).toThrow();
    expect(parseRuntimeReport({ kind: "claude-code", version: "0.3.260", entrypoint: "cli", source: "detected" })).toEqual({
      kind: "claude-code",
      version: "0.3.260",
      entrypoint: "cli",
      source: "detected",
    });
    expect(parseRuntimeReport({ kind: "codex" })).toEqual({ kind: "codex" });
    expect(() => parseRuntimeReport({ kind: "codex", source: "guessed" })).toThrow();
    expect(() => parseRuntimeReport({ kind: "codex", version: "x".repeat(65) })).toThrow();
    expect(() => parseRuntimeReport({ kind: "codex", extra: 1 })).toThrow();
    expect(KNOWN_RUNTIME_KINDS).toContain("openhands");
    expect(KNOWN_RUNTIME_KINDS).toEqual(expect.arrayContaining(["muse", "dot"]));
    // A declared harness reports through the same shape as a detected driver.
    expect(parseRuntimeReport({ kind: "dot", version: "2.1", entrypoint: null, source: "declared" })).toEqual({
      kind: "dot",
      version: "2.1",
      entrypoint: null,
      source: "declared",
    });
  });

  it("refuses an Agent that declares itself the human: only the service seats a person", () => {
    // A line from a `human` seat is drawn as the owner's own, on the right.
    // If a join or a registration could declare the kind, any Agent could.
    expect(() => parseStartInstanceRequest({ runtime_kind: HUMAN_RUNTIME_KIND, cli_version: "1.0.0" })).toThrow();
    expect(() => parseRuntimeReport({ kind: HUMAN_RUNTIME_KIND })).toThrow();
    expect(KNOWN_RUNTIME_KINDS).not.toContain(HUMAN_RUNTIME_KIND);
  });

  it("redacts every credential-shaped token from text bound for the public, and nothing else", () => {
    const invite = `rit_${"a".repeat(43)}`;
    const seat = `sni_${"b".repeat(43)}`;
    const text = `join with ROOM=rom_RedactRm01 TOKEN=${invite} then ${seat}; my key is snk_short and clp_${"c".repeat(20)}`;
    expect(redactSecrets(text)).toBe(
      "join with ROOM=rom_RedactRm01 TOKEN=rit_[redacted] then sni_[redacted]; my key is snk_short and clp_[redacted]",
    );
    expect(redactSecrets("nothing secret here, i_RedactIns1 and p_RedactPr01 stay")).toBe(
      "nothing secret here, i_RedactIns1 and p_RedactPr01 stay",
    );
    expect(SHR_SECRET_PATTERN.test(generateSecret("shr"))).toBe(true);
    expect(SHR_SECRET_PATTERN.test("rom_RedactRm01")).toBe(false);
  });

  it("accepts a guest name as display text only: trimmed, bounded, no control characters", () => {
    expect(parseJoinRoomWithInviteRequest({ name: "  claude-code  " })).toEqual({ name: "claude-code" });
    expect(() => parseJoinRoomWithInviteRequest({ name: "" })).toThrow();
    expect(() => parseJoinRoomWithInviteRequest({ name: "a".repeat(65) })).toThrow();
    expect(() => parseJoinRoomWithInviteRequest({ name: "bad\u0000name" })).toThrow();
    expect(() => parseJoinRoomWithInviteRequest({ name: "x", extra: 1 })).toThrow();
  });
});

describe("runtimeMetadataFor", () => {
  const owner = "p_OwnerAbcde" as const;
  const metadata = { hostname: "Alices-MacBook-Pro.local", workspace: "acme", os: "darwin", runtime_source: "detected", connector_label: "ChatGPT", added_by_a_future_cli: "x" };

  it("gives the owning Principal everything it reported", () => {
    expect(runtimeMetadataFor(owner, owner, metadata)).toEqual(metadata);
  });

  it("gives anyone else, and a reader with no Principal, only the driver fields", () => {
    for (const viewer of ["p_StrangerAb" as const, null]) {
      expect(runtimeMetadataFor(viewer, owner, metadata)).toEqual({ runtime_source: "detected", connector_label: "ChatGPT" });
    }
  });

  it("keeps a key it has never heard of private, so a new field starts out hidden", () => {
    expect(runtimeMetadataFor("p_StrangerAb", owner, metadata)).not.toHaveProperty("added_by_a_future_cli");
    expect(SHARED_RUNTIME_METADATA_KEYS).not.toContain("hostname");
    expect(SHARED_RUNTIME_METADATA_KEYS).not.toContain("workspace");
  });
});

describe("goal Rooms (decision 2026-10-05)", () => {
  it("reads end triggers in the words of wait --on, and says which the service enforces", () => {
    expect(parseGoalTrigger("count: 200")).toEqual({ label: "count 200", kind: "count", enforced: { kind: "count", label: "count 200", count: 200 } });
    expect(parseGoalTrigger("after 2h")).toMatchObject({ label: "after 2h", enforced: { kind: "after", ms: 7_200_000 } });
    expect(parseGoalTrigger("at 2026-10-06T09:00:00+08:00")).toMatchObject({ enforced: { kind: "at", time: Date.parse("2026-10-06T01:00:00Z") } });
    expect(parseGoalTrigger("check: pytest -q tests/hidden")).toEqual({ label: "check pytest -q tests/hidden", kind: "check", enforced: null });
    expect(parseGoalTrigger("idle 10m")).toMatchObject({ kind: "idle", enforced: null });
    expect(parseGoalTrigger("budget: $20")).toMatchObject({ label: "budget $20", enforced: null });
    expect(parseGoalTrigger("budget 5M tokens")).toMatchObject({ label: "budget 5M tokens" });
    expect(parseGoalTrigger("mention")).toMatchObject({ label: "mention" });
    // `at` carries its offset: the service cannot know the runner's clock.
    for (const raw of ["at 17:30", "at 2026-10-06T09:00", "closed", "every 10m", "cron 0 9 * * *", "count 0", "after soon", "budget twenty", "message now", "check", 42, `said ${"x".repeat(300)}`]) {
      expect(() => parseGoalTrigger(raw), String(raw)).toThrow();
    }
    expect(serviceGoalTriggers(["check make test", "count 5", "after 1h", "budget $3"]).map((trigger) => trigger.label)).toEqual(["count 5", "after 1h"]);
  });

  it("starts a goal only with a bound it cannot outrun, and keeps one copy of each trigger", () => {
    expect(parseStartGoalRequest({ content: "Ship it.", until: ["check: make test", "after: 2h", "after 2h"] })).toEqual({
      content: "Ship it.",
      until: ["check make test", "after 2h"],
    });
    for (const bound of ["count 50", "after 1h", "at 2026-10-06T09:00:00Z", "budget $5"]) {
      expect(() => parseStartGoalRequest({ content: "x", until: [bound] }), bound).not.toThrow();
    }
    expect(() => parseStartGoalRequest({ content: "x", until: ["check make test", "idle 5m"] })).toThrow(
      expect.objectContaining({ code: "goal_unbounded" }),
    );
    for (const body of [{ content: "x", until: [] }, { content: "x", until: Array.from({ length: 11 }, (_, index) => `count ${index + 1}`) }, { content: " ", until: ["after 1h"] }, { content: "x" }, { content: "x", until: ["after 1h"], extra: true }]) {
      expect(() => parseStartGoalRequest(body)).toThrow();
    }
  });

  it("says a line as the owner by default, or as the runner, and closes with an optional reason", () => {
    expect(parseOwnerMessageRequest({ content: "Hold the tests." })).toEqual({ content: "Hold the tests.", as: "owner" });
    expect(parseOwnerMessageRequest({ content: "check failed", as: "runner" })).toEqual({ content: "check failed", as: "runner" });
    expect(() => parseOwnerMessageRequest({ content: "x", as: "agent" })).toThrow();
    expect(parseCloseRoomRequest(undefined)).toEqual({ trigger: null, detail: null });
    expect(parseCloseRoomRequest({ trigger: "check: make test", detail: "27 passed" })).toEqual({ trigger: "check make test", detail: "27 passed" });
    expect(parseCloseRoomRequest({ detail: "   " })).toEqual({ trigger: null, detail: null });
    expect(() => parseCloseRoomRequest({ detail: "x".repeat(4_001) })).toThrow();
    expect(() => parseCloseRoomRequest({ reason: "done" })).toThrow();
  });

  it("keeps the runner's kind the service's, like the person's", () => {
    expect(isServiceRuntimeKind(RUNNER_RUNTIME_KIND)).toBe(true);
    expect(isServiceRuntimeKind(HUMAN_RUNTIME_KIND)).toBe(true);
    expect(isServiceRuntimeKind("codex")).toBe(false);
    expect(() => parseStartInstanceRequest({ runtime_kind: RUNNER_RUNTIME_KIND, cli_version: "1.0.0" })).toThrow();
    expect(() => parseRuntimeReport({ kind: RUNNER_RUNTIME_KIND, version: "1", entrypoint: null, source: "declared" })).toThrow();
  });

  it("fits an account's name to the seat-name rule", () => {
    expect(fitSeatName("  Ada\nLovelace ")).toBe("Ada Lovelace");
    expect(fitSeatName("x".repeat(60))).toBe("x".repeat(48));
    expect(fitSeatName("\u0007")).toBeNull();
    expect(fitSeatName(null)).toBeNull();
  });
});


describe("Room timers' schedules (wait PR 6)", () => {
  const NOW = Date.parse("2026-10-05T12:00:00.000Z"); // a Monday

  it("normalizes each kind, with or without a colon, and says when it first comes due", () => {
    expect(timerSchedule("every: 20m", NOW)).toMatchObject({ label: "every 20m", first: NOW + 20 * 60_000 });
    expect(timerSchedule("after 2h", NOW)).toMatchObject({ label: "after 2h", first: NOW + 2 * 3_600_000 });
    expect(timerSchedule('cron "0 9 * * 1-5"', NOW)).toMatchObject({ label: "cron 0 9 * * 1-5", first: Date.parse("2026-10-06T09:00:00.000Z") });
    // An at without an offset is UTC; one with an offset is that moment.
    expect(timerSchedule("at 2026-10-05T13:30", NOW)).toMatchObject({ label: "at 2026-10-05T13:30:00.000Z" });
    expect(timerSchedule("at 2026-10-05T21:30+08:00", NOW)).toMatchObject({ label: "at 2026-10-05T13:30:00.000Z" });
    for (const raw of ["every 59s", "every 0m", "after soon", "cron * * *", "at yesterday", "at 2026-10-05T11:59:00Z", "sometimes 5m"]) {
      expect(() => timerSchedule(raw, NOW), raw).toThrow();
    }
  });

  it("says a missed line once, moves a calendar to its next day, and spends a one-shot", () => {
    const every = timerSchedule("every 20m", NOW).schedule;
    // Due at 12:20, not asked until 14:05: the next is 14:20, not five lines at once.
    expect(followingDue(every, NOW + 20 * 60_000, NOW + 125 * 60_000)).toBe(NOW + 140 * 60_000);
    expect(followingDue(every, NOW + 20 * 60_000, NOW + 20 * 60_000)).toBe(NOW + 40 * 60_000);
    const weekdays = timerSchedule("cron 0 9 * * 1-5", NOW).schedule;
    // Friday 09:00 is followed by Monday 09:00.
    expect(followingDue(weekdays, Date.parse("2026-10-09T09:00:00Z"), Date.parse("2026-10-09T09:00:30Z"))).toBe(Date.parse("2026-10-12T09:00:00Z"));
    expect(followingDue(timerSchedule("after 1h", NOW).schedule, NOW + 3_600_000, NOW + 3_600_000)).toBeNull();
    expect(nextCronUtc(parseCronExpression("*/15 * * * *"), NOW)).toBe(NOW + 15 * 60_000);
  });
});

describe("addressing a seat with @ (wait PR 8)", () => {
  const BETA = "i_BetaBetaBe" as const;
  const seats = [
    { memberId: "i_AlphaAlpha" as const, name: "alpha" },
    { memberId: BETA, name: "beta" },
    { memberId: "i_GammaGamma" as const, name: null },
  ];

  it("names a seat by @name or @id, whatever the case, and not inside a longer name", () => {
    expect(isMentioned("@Beta please look", { memberId: BETA, name: "beta" })).toBe(true);
    expect(isMentioned(`ping @${BETA}`, { memberId: BETA, name: null })).toBe(true);
    expect(isMentioned("@beta, and you", { memberId: BETA, name: "beta" })).toBe(true);
    expect(isMentioned("@betamax is not beta", { memberId: BETA, name: "beta" })).toBe(false);
    expect(isMentioned("beta without the at", { memberId: BETA, name: "beta" })).toBe(false);
  });

  it("resolves the seats a line addresses, never its own speaker", () => {
    expect(mentionedSeats("@alpha and @beta, sync up", seats, "i_GammaGamma")).toEqual(["i_AlphaAlpha", BETA]);
    expect(mentionedSeats("@beta I will take it", seats, BETA)).toEqual([]);
    expect(mentionedSeats("no handles here", seats, BETA)).toEqual([]);
    // A seat listed by its name and by its tag is addressed once.
    expect(mentionedSeats("@reviewer and @beta", [...seats, { memberId: BETA, name: "reviewer" }], "i_GammaGamma")).toEqual([BETA]);
  });
});

describe("compiled Room wire contract", () => {
  it("accepts explicit modes, defaults by omission, and rejects protocol/version injection", () => {
    expect(parseCreateRoomRequest({ name: "Typed", type: "compiled" })).toEqual({name: "Typed", type: "compiled"});
    expect(parseCreateRoomRequest({ name: "Plain", type: "board" })).toEqual({name: "Plain", type: "board"});
    expect(parseCreateRoomRequest({ name: "Legacy" })).toEqual({name: "Legacy"});
    for (const body of [{name:"Bad",type:"workflow"},{name:"Bad",type:null},{name:"Bad",protocol_version:"fake"}]) {
      expect(() => parseCreateRoomRequest(body)).toThrow(ProtocolValidationError);
    }
  });
  it("publishes separate Instance-only acts and state routes while preserving hooks", () => {
    expect(ROUTE_CATALOGUE).toContainEqual({method:"POST",path:"/api/v1/rooms/{room_id}/acts",auth:"instance",operationId:"postAct"});
    expect(ROUTE_CATALOGUE).toContainEqual({method:"GET",path:"/api/v1/rooms/{room_id}/state",auth:"instance",operationId:"getCompiledState"});
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms/{room_id}/acts"].post.responses).toHaveProperty("422");
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms/{room_id}/events"].post.operationId).toBe("postEvent");
    expect(OPENAPI_DOCUMENT.paths["/api/v1/rooms"].post.requestBody.content["application/json"].schema.properties.type.enum).toEqual(["board","compiled"]);
  });
});
