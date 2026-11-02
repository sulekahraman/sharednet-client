import type { InstanceId, RoomId } from "../protocol/index.ts";
import type { SeatTaken } from "./repository.ts";

/**
 * The cloud Room grant queue: a SharedOS Cloud agent seated in a Room is to be
 * granted the Room on the console, as its owner, when the seating was the
 * owner's own doing. The kernel opens a turn for an agent in a Room only
 * against a grant on that Room, so a seat without one sits silent.
 *
 * Why a queue: the grant is a call to another service. Asked once, after the
 * seat is written, a console that is down or refusing left the agent seated
 * and mute, with two lines in a log nobody reads. The intent is now written
 * in the seating's own transaction, so membership and the promise to grant
 * stand or fall together; it is tried at once after the commit and again by
 * the minute tick until it is through or given up on, and what is not through
 * is shown to the owner.
 *
 * The same row carries the grant's end. When the seat is removed, leaves, or
 * its Instance ends while the grant is through, the row turns into the intent
 * to revoke that grant on the console, by its id, tried the same way: at once
 * after the commit and again by the tick. The kernel sweeps a grant whose seat
 * is gone by itself every twenty seconds, but leaves one under two minutes old
 * alone, and within that window a seat somebody else takes again would still
 * be woken on the owner's old word. Revoking it here closes that window to the
 * moment between the removal and the console's answer.
 *
 * One attempt at a time, per seat. A seat taken again while an attempt is out
 * does not write over the row: the lease cannot recall a call already made,
 * and a revoke landing after a new grant had been recorded on the same name
 * would leave the row saying granted over no grant. The seating only binds the
 * row to itself; the attempt settles the row, finds the seat standing, and the
 * grant is asked afresh. Afresh only on a definitive end: a revoke the console
 * answered, or refused, is over; one that timed out, or that the console's own
 * call to the kernel lost, may yet land, so it is tried again until the
 * console says where it stands, and the grant is asked only then. Attempts
 * spent, an unknown end is still unknown: the row is failed, as a revoke, and
 * stays so, shown to the owner and said in the Room, and nothing asks the
 * grant by itself, since the last DELETE may land after any POST. The owner
 * removing the seat and taking it again tries the revoke anew.
 *
 * An unknown end is the row's, not the attempt's. Once one DELETE of a revoke
 * has gone out without its end learned, the row is marked lost, and a later
 * DELETE the console refuses settles nothing: the refusal is that call's, and
 * says nothing of the lost one, which may yet land after a grant asked on the
 * refusal's word. Only the console saying the grant is revoked, or gone, is an
 * answer about the grant itself; that alone clears the mark and lets the grant
 * be asked.
 */

export type CloudRoomGrantState = "pending" | "processing" | "granted" | "revoked" | "failed" | "superseded";

/** What the row is out to do: have the Room granted to the seat, or have that grant taken back once the seat is gone. */
export type CloudRoomGrantIntent = "grant" | "revoke";

/** The seat a grant is for: the Room and the Instance seated in it. */
export type CloudRoomGrantSeat = { room_id: RoomId; instance_id: InstanceId };

/** A grant as the console named it: its id, and the agent's handle on the machine, which is how the console's revoke route takes it. */
export type CloudRoomGrantHeld = { grant_id: string; agent_handle: string };

/**
 * The seating a promise is bound to: the membership's `joined_at`, which a seat
 * left and taken again gets anew. A promise is the owner's word for one
 * seating; one that outlives it, because the seat left and somebody else
 * seated the agent again, must grant nothing. So the promise is void when the
 * membership it was made for is no longer the active one, whether the leaving
 * went through the repository (which voids it then) or the row is read later.
 */
export function seatStillHeld<T extends Date | string>(grant: { seated_at: T }, membership: { state: string; joined_at: T } | null | undefined): boolean {
  return membership?.state === "active" && membership.joined_at.valueOf() === grant.seated_at.valueOf();
}

/**
 * How an attempt failed: `refused`, the console answered and said no, so the
 * call did nothing and will not; `unknown`, no answer came (the call timed
 * out, or the console could not reach the kernel), so the call may yet take
 * effect. The two part only for a revoke whose seat is taken again: a refusal
 * lets the grant be asked at once, an unknown end has the revoke tried again
 * first, since a DELETE still landing would take the new grant back, and when
 * the attempts are spent leaves the row failed, never a grant. And an unknown
 * end marks the row: a refusal after it settles nothing either, since it is
 * the later call's answer, not the lost one's.
 */
export type CloudRoomGrantFailure = "refused" | "unknown";

/** One row claimed for an attempt: whose key asks, which machine, the lease the attempt holds, and what to ask: the grant, or the end of the grant named. */
export type CloudRoomGrantClaim = CloudRoomGrantSeat & { machine: string; auth_user_id: string; leaseToken: string; attempts: number } & ({ intent: "grant" } | ({ intent: "revoke" } & CloudRoomGrantHeld));

/**
 * What is not through, as the owner sees it: still being tried, or given up on
 * with the console's last words. The intent says what: a grant the console has
 * not given, or a revoke of the old grant whose end is not known, which stands
 * between a seat taken again and its grant.
 */
export type CloudRoomGrantView = CloudRoomGrantSeat & {
  room_name: string;
  machine: string;
  intent: CloudRoomGrantIntent;
  state: "pending" | "processing" | "failed";
  attempts: number;
  /** The console's words from the last attempt that failed; null before the first. */
  last_refusal: string | null;
  since: string;
};

/** Attempts a minute, two, four apart and so on, an hour at most, giving up after ten: about five hours of a console being down. */
export const CLOUD_ROOM_GRANT_MAX_ATTEMPTS = 10;
export const cloudRoomGrantRetryMs = (attempts: number) => Math.min(60_000 * 2 ** (attempts - 1), 3_600_000);
export function cloudRoomGrantLeaseMs(value = 60_000): number {
  if (!Number.isInteger(value) || value < 1000 || value > 300_000) throw new Error("A cloud Room grant lease must be between 1000 and 300000 milliseconds.");
  return value;
}
/** The console's words are kept for the owner to read, cut to a line. */
export function cloudRoomGrantRefusal(value: string): string {
  const said = value.trim().replace(/\s+/g, " ");
  return said ? said.slice(0, 500) : "SharedOS Cloud gave no reason.";
}

/** What decides a grant, read for the seat: where it runs and whose account is behind it. */
export type SeatFacts = {
  /** The machine a SharedOS Cloud agent runs on; null for every other Instance, and for a seat that has ended. */
  machine: string | null;
  /** The account behind the seat's Principal; null for an anonymous one. */
  auth_user_id: string | null;
};

export type SeatGrantReason = "not_a_cloud_seat" | "the_seats_own_direct_room" | "not_the_owners_doing" | "no_account_behind_it";

export type SeatGrantDecision = { grant: true; machine: string; auth_user_id: string } | { grant: false; because: SeatGrantReason };

/**
 * Whose word: anyone who knows the id can seat a public Instance in a Room of
 * theirs without asking. That seating grants nothing, since the delegated key
 * acts for the owner on the owner's word alone. The owner's word is the
 * owner's Principal doing the seating: their dashboard or MCP seat, any
 * Instance of theirs (the agent itself included, when it joins by itself), or
 * their acceptance of a request to seat it. The direct Room a seat is born
 * with is the kernel's to grant, from the seat answer that names it.
 */
export function decideSeatGrant(seat: SeatTaken, facts: SeatFacts | null): SeatGrantDecision {
  if (!facts?.machine) return { grant: false, because: "not_a_cloud_seat" };
  if (seat.room_kind === "direct") return { grant: false, because: "the_seats_own_direct_room" };
  if (seat.by_principal_id !== seat.principal_id) return { grant: false, because: "not_the_owners_doing" };
  if (!facts.auth_user_id) return { grant: false, because: "no_account_behind_it" };
  return { grant: true, machine: facts.machine, auth_user_id: facts.auth_user_id };
}

/** A SharedOS Cloud agent's seat is the Instance the console seated it as: runtime kind sharedos, its machine in the metadata. */
export function cloudMachineOf(instance: { runtime_kind: string; runtime_metadata: Record<string, string>; active: boolean }): string | null {
  return instance.runtime_kind === "sharedos" && instance.active && typeof instance.runtime_metadata.machine === "string" ? instance.runtime_metadata.machine : null;
}

/**
 * What the Room is told, by its owner's clock seat, so the people waiting on
 * the agent learn why it is silent and the owner how to mend it: once when the
 * first attempt fails, once when the attempts are spent, and once when a grant
 * that had failed is through; and once when the attempts of a revoke are spent
 * with its end unknown while the seat is taken again, since that seat is as
 * silent as one refused. It addresses nobody, so it wakes nobody: the
 * line is written with no mentions, and an @ in the console's words is set
 * apart as "(at)", since a CLI reading the Room applies the mention rule to
 * the text itself.
 */
export type CloudRoomGrantNoticeKind = "asking" | "gave_up" | "unresolved" | "through";

export function cloudRoomGrantNotice(kind: CloudRoomGrantNoticeKind, agent: { id: string; handle: string | null }, refusal: string | null): string {
  const name = agent.handle ? `the ${agent.handle} (${agent.id})` : agent.id;
  const Name = name[0]!.toUpperCase() + name.slice(1);
  const said = refusal ? ` The console said: "${refusal.replaceAll("@", "(at)")}"` : "";
  switch (kind) {
    case "asking":
      return `${Name} is in this Room but SharedOS Cloud has not granted it the Room yet, so it cannot answer here. SharedNet is asking again; once it is through, say your message again.${said}`;
    case "gave_up":
      return `SharedOS Cloud would not grant ${name} this Room, so it cannot answer here.${said} Its owner can ask once more by removing it from this Room and adding it back, or look at its machine on SharedOS Cloud.`;
    case "unresolved":
      return `${Name} is in this Room but cannot answer here: SharedNet could not learn from SharedOS Cloud whether its earlier grant on this Room was taken back, so it has not asked for a new one.${said} Its owner can try once more by removing it from this Room and adding it back, or look at its machine on SharedOS Cloud.`;
    case "through":
      return `${Name} can answer here now. Say your message again if it went unanswered.`;
  }
}
