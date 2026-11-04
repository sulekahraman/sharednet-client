/**
 * Who is answering a line that addressed them. It is derived when the Room is read, from each
 * seat's subscription (wait PR 5) and the log. A current driven `serve` renews a short lease while
 * its headless plugin delivery owns that Room span. Older clients retain the bounded legacy signal.
 *
 * A seat is replying to a line that @-addressed it when the service has handed it that line
 * (`delivered_through` reached it) and either
 *
 * - it has not finished handling it (`acked_through` is still below it) and either its exact driven
 *   span has an unexpired lease, or no lease-capable client has claimed the span and its legacy
 *   subscription activity is recent; or
 * - it took the line moments ago and has said nothing since: a plain `wait` acks as it hands the
 *   line over, so for a seat sitting in the Room the only sign of work is a recent line it has not
 *   answered yet.
 *
 * Both are bounded in time, so a seat that crashed mid-turn or chose to stay silent stops showing.
 */
import type { InstanceId, Message, MessageId, Timestamp } from "../protocol/index.ts";

/** How long an unacknowledged subscription may be inactive before it stops reading as a reply. */
export const REPLY_TURN_MS = 20 * 60_000;
/** Long enough to survive two missed 30-second pulses, short enough to clear a crashed driven turn. */
export const REPLY_LEASE_MS = 90_000;
/** How long a seat that already acked a line still reads as answering it. */
export const REPLY_FRESH_MS = 2 * 60_000;

/** A seat's two marks in a Room, and when the handover was last active. */
export interface SeatMarks {
  delivered_through: number;
  acked_through: number;
  moved_at: Timestamp;
  active_through?: number | null;
  active_expires_at?: Timestamp | null;
}

export interface Replying {
  /** The latest line that addressed the seat and that it is answering. */
  message_id: MessageId;
  sequence: number;
  /** When that line was said. */
  since: Timestamp;
}

export function replyingSeats(
  messages: readonly Pick<Message, "id" | "sender_instance_id" | "sequence" | "mentions" | "created_at">[],
  marks: ReadonlyMap<InstanceId, SeatMarks>,
  now: Date,
): Record<InstanceId, Replying> {
  const replying: Record<InstanceId, Replying> = {};
  const lastSaid = new Map<InstanceId, number>();
  for (const message of messages) {
    lastSaid.set(message.sender_instance_id, Math.max(lastSaid.get(message.sender_instance_id) ?? 0, message.sequence));
  }
  for (const message of [...messages].sort((a, b) => b.sequence - a.sequence)) {
    for (const seat of message.mentions) {
      if (seat === message.sender_instance_id || replying[seat]) continue;
      const kept = marks.get(seat);
      if (!kept || kept.delivered_through < message.sequence) continue;
      const leaseCapable = kept.active_through !== undefined && kept.active_through !== null;
      const explicitlyActive =
        leaseCapable &&
        kept.active_through === kept.delivered_through &&
        kept.active_expires_at !== undefined &&
        kept.active_expires_at !== null &&
        Date.parse(kept.active_expires_at) > now.getTime();
      const legacyActive = !leaseCapable && now.getTime() - Date.parse(kept.moved_at) < REPLY_TURN_MS;
      const inTurn = kept.acked_through < message.sequence && (explicitlyActive || legacyActive);
      const justTaken =
        (lastSaid.get(seat) ?? 0) < message.sequence && now.getTime() - Date.parse(message.created_at) < REPLY_FRESH_MS;
      if (inTurn || justTaken) {
        replying[seat] = { message_id: message.id, sequence: message.sequence, since: message.created_at };
      }
    }
  }
  return replying;
}

/**
 * The latest line addressed to each seat that has not reached that seat yet.
 *
 * This is deliberately separate from `replyingSeats`: delivery is the boundary after which the
 * service may truthfully say that a seat is replying. Before that boundary, callers can still show
 * that SharedNet is waiting for the listener instead of leaving an unexplained blank state.
 */
export function waitingForDeliverySeats(
  messages: readonly Pick<Message, "id" | "sender_instance_id" | "sequence" | "mentions" | "created_at">[],
  marks: ReadonlyMap<InstanceId, SeatMarks>,
  eligibleSeats: ReadonlySet<InstanceId>,
): Record<InstanceId, Replying> {
  const latest: Record<InstanceId, Replying> = {};
  for (const message of messages) {
    for (const seat of message.mentions) {
      if (seat === message.sender_instance_id || !eligibleSeats.has(seat)) continue;
      if ((latest[seat]?.sequence ?? 0) < message.sequence) {
        latest[seat] = { message_id: message.id, sequence: message.sequence, since: message.created_at };
      }
    }
  }
  const waiting: Record<InstanceId, Replying> = {};
  for (const [seat, mention] of Object.entries(latest)) {
    const kept = marks.get(seat as InstanceId);
    if (!kept || kept.delivered_through < mention.sequence) waiting[seat as InstanceId] = mention;
  }
  return waiting;
}

/** Only call with messages and active members of authorized Rooms. */
export function networkReplies(
  messages: readonly Pick<Message, "id" | "room_id" | "sender_instance_id" | "sequence" | "mentions" | "created_at">[],
  rooms: ReadonlyMap<Message["room_id"], readonly InstanceId[]>,
  marksFor: (room: Message["room_id"], seat: InstanceId) => SeatMarks | undefined,
  now: Date,
) {
  return [...rooms].flatMap(([room, members]) => {
    const log = messages.filter(m => m.room_id === room);
    const marks = new Map<InstanceId, SeatMarks>();
    for (const seat of members) { const mark = marksFor(room, seat); if (mark) marks.set(seat, mark); }
    return Object.entries(replyingSeats(log, marks, now)).flatMap(([source, reply]) => {
      const message = log.find(m => m.id === reply.message_id);
      if (!message || !members.includes(message.sender_instance_id)) return [];
      return [{ source_id: source as InstanceId, target_id: message.sender_instance_id, room_id: room, message_id: reply.message_id, sequence: reply.sequence }];
    });
  });
}
