// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { InstanceId, Message, MessageId, PrincipalId, RoomId } from "../protocol/index.ts";
import {
  REPLY_FRESH_MS,
  REPLY_LEASE_MS,
  REPLY_TURN_MS,
  replyingSeats,
  type SeatMarks,
  waitingForDeliverySeats,
} from "./replying.ts";

const ROOM = "rom_ReplyRoom1" as RoomId;
const HOST = "i_ReplyHost1" as InstanceId;
const AGENT = "i_ReplyAgnt1" as InstanceId;
const OTHER = "i_ReplyOthr1" as InstanceId;
const PRINCIPAL = "p_ReplyOwnr1" as PrincipalId;
const NOW = new Date("2026-10-08T09:00:00.000Z");

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function line(sequence: number, from: InstanceId, mentions: InstanceId[], saidAgo = 5_000): Message {
  return {
    id: `msg_Seq${String(sequence).padStart(7, "0")}` as MessageId,
    room_id: ROOM,
    sequence,
    sender_principal_id: PRINCIPAL,
    sender_agent_id: null,
    sender_instance_id: from,
    sender: { kind: "instance", member_id: from, name: null } as Message["sender"],
    type: "message",
    content: mentions.map((seat) => `@${seat}`).join(" ") + " a question",
    mentions,
    reply_to_message_id: null,
    created_at: ago(saidAgo),
  };
}

const marks = (entries: Array<[InstanceId, SeatMarks]>) => new Map(entries);

describe("who is replying, derived from subscriptions", () => {
  it("names a seat that was handed the line addressing it and has not acknowledged it yet", () => {
    const log = [line(1, HOST, [AGENT])];
    const replying = replyingSeats(log, marks([[AGENT, { delivered_through: 1, acked_through: 0, moved_at: ago(3_000) }]]), NOW);
    expect(replying[AGENT]).toEqual({ message_id: log[0]!.id, sequence: 1, since: log[0]!.created_at });
  });

  it("keeps naming a seat whose resumed turn is still running long after the line was said", () => {
    const log = [line(1, HOST, [AGENT], REPLY_TURN_MS - 60_000)];
    const replying = replyingSeats(log, marks([[AGENT, { delivered_through: 1, acked_through: 0, moved_at: ago(REPLY_TURN_MS - 60_000) }]]), NOW);
    expect(replying[AGENT]?.sequence).toBe(1);
  });

  it("stops naming a seat whose turn outlived the turn limit, as a crashed connector's would", () => {
    const log = [line(1, HOST, [AGENT], REPLY_TURN_MS + 1_000)];
    const replying = replyingSeats(log, marks([[AGENT, { delivered_through: 1, acked_through: 0, moved_at: ago(REPLY_TURN_MS + 1_000) }]]), NOW);
    expect(replying).toEqual({});
  });

  it("uses a claimed span's short lease instead of the legacy activity window", () => {
    const log = [line(1, HOST, [AGENT], REPLY_TURN_MS - 60_000)];
    const explicit = (expiresAgo: number): SeatMarks => ({
      delivered_through: 1,
      acked_through: 0,
      moved_at: ago(1_000),
      active_through: 1,
      active_expires_at: ago(expiresAgo),
    });
    expect(replyingSeats(log, marks([[AGENT, explicit(-REPLY_LEASE_MS)]]), NOW)[AGENT]?.sequence).toBe(1);
    // Its legacy timestamp remains fresh, but an expired explicit lease suppresses that heuristic.
    expect(replyingSeats(log, marks([[AGENT, explicit(1)]]), NOW)).toEqual({});
    // An old span cannot make the current delivered span appear active.
    expect(replyingSeats(log, marks([[AGENT, { ...explicit(-REPLY_LEASE_MS), delivered_through: 2 }]]), NOW)).toEqual({});
  });

  it("names a seat that took the line moments ago through a plain wait and has not answered", () => {
    const log = [line(1, HOST, [AGENT], 10_000)];
    const replying = replyingSeats(log, marks([[AGENT, { delivered_through: 1, acked_through: 1, moved_at: ago(9_000) }]]), NOW);
    expect(replying[AGENT]?.sequence).toBe(1);
  });

  it("does not name a seat that already answered, or one that took the line too long ago", () => {
    const answered = [line(1, HOST, [AGENT], 10_000), line(2, AGENT, [HOST], 2_000)];
    const settled = marks([[AGENT, { delivered_through: 1, acked_through: 1, moved_at: ago(9_000) }]]);
    expect(replyingSeats(answered, settled, NOW)).toEqual({});

    const stale = [line(1, HOST, [AGENT], REPLY_FRESH_MS + 1_000)];
    expect(replyingSeats(stale, marks([[AGENT, { delivered_through: 1, acked_through: 1, moved_at: ago(REPLY_FRESH_MS) }]]), NOW)).toEqual({});
  });

  it("does not name a seat that has not been handed the line, nor one with no subscription at all", () => {
    const log = [line(1, HOST, [AGENT]), line(2, HOST, [OTHER])];
    expect(replyingSeats(log, marks([[AGENT, { delivered_through: 0, acked_through: 0, moved_at: ago(1_000) }]]), NOW)).toEqual({});
  });

  it("ignores a line that is not addressed to the seat, and a seat addressing itself", () => {
    const log = [line(1, HOST, []), line(2, AGENT, [AGENT])];
    expect(replyingSeats(log, marks([[AGENT, { delivered_through: 2, acked_through: 0, moved_at: ago(1_000) }]]), NOW)).toEqual({});
  });

  it("answers with the latest line the seat is working on, and names each addressed seat once", () => {
    const log = [line(1, HOST, [AGENT]), line(2, OTHER, [AGENT, HOST]), line(3, HOST, [AGENT])];
    const replying = replyingSeats(
      log,
      marks([
        [AGENT, { delivered_through: 2, acked_through: 0, moved_at: ago(1_000) }],
        [HOST, { delivered_through: 3, acked_through: 1, moved_at: ago(1_000) }],
      ]),
      NOW,
    );
    expect(replying[AGENT]?.sequence).toBe(2);
    expect(replying[HOST]?.sequence).toBe(2);
    expect(Object.keys(replying)).toHaveLength(2);
  });
});

describe("who is still waiting for delivery", () => {
  it("names the latest addressed line until that exact line is handed to the seat", () => {
    const log = [line(1, HOST, [AGENT]), line(2, HOST, [AGENT])];
    const waiting = waitingForDeliverySeats(
      log,
      marks([[AGENT, { delivered_through: 1, acked_through: 1, moved_at: ago(1_000) }]]),
      new Set([AGENT]),
    );
    expect(waiting[AGENT]).toEqual({ message_id: log[1]!.id, sequence: 2, since: log[1]!.created_at });

    expect(
      waitingForDeliverySeats(
        log,
        marks([[AGENT, { delivered_through: 2, acked_through: 1, moved_at: ago(1_000) }]]),
        new Set([AGENT]),
      ),
    ).toEqual({});
  });

  it("keeps exact delivery status even when the seat later speaks through another path", () => {
    const unanswered = [line(1, HOST, [AGENT])];
    expect(waitingForDeliverySeats(unanswered, new Map(), new Set([AGENT]))[AGENT]?.sequence).toBe(1);

    const answered = [...unanswered, line(2, AGENT, [HOST])];
    expect(waitingForDeliverySeats(answered, new Map(), new Set([AGENT]))[AGENT]?.sequence).toBe(1);
  });

  it("does not project a mention for a seat that is not an active deliverable Agent", () => {
    const log = [line(1, HOST, [AGENT])];
    expect(waitingForDeliverySeats(log, new Map(), new Set())).toEqual({});
  });

  it("keeps an older delivered reply distinct from a newer undelivered mention", () => {
    const log = [line(1, HOST, [AGENT]), line(2, HOST, [AGENT])];
    const seatMarks = marks([[AGENT, { delivered_through: 1, acked_through: 0, moved_at: ago(1_000) }]]);
    expect(replyingSeats(log, seatMarks, NOW)[AGENT]?.sequence).toBe(1);
    expect(waitingForDeliverySeats(log, seatMarks, new Set([AGENT]))[AGENT]?.sequence).toBe(2);
  });
});

it("projects a reply from worker to message author without exposing another Room or a departed target", async () => {
  const { networkReplies } = await import("./replying.ts");
  const msg = line(1, HOST, [AGENT]);
  const active = new Map([[ROOM, [HOST, AGENT]]]);
  const cursor = () => ({ delivered_through: 1, acked_through: 0, moved_at: ago(1000) });
  expect(networkReplies([msg], active, cursor, NOW)).toEqual([{ source_id: AGENT, target_id: HOST, room_id: ROOM, message_id: msg.id, sequence: 1 }]);
  expect(networkReplies([msg], new Map(), cursor, NOW)).toEqual([]);
  expect(networkReplies([msg], new Map([[ROOM, [AGENT]]]), cursor, NOW)).toEqual([]);
  expect(networkReplies([msg], active, cursor, new Date(NOW.getTime() + REPLY_TURN_MS))).toEqual([]);
});
