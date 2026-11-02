/**
 * A seat's doorbell (decision 2026-10-05, wait PR 7). When something the seat has not handled is
 * said, the service POSTs a ring to the address the seat gave, signed with the seat's doorbell
 * secret, and rings again until the seat acknowledges it. A ring carries no content: the seat looks
 * for itself, with its own token, so a forged or replayed ring can at most make it look.
 *
 * The service knocks on addresses other people chose, so it knocks only on the public internet:
 * https, and every address the name resolves to public, checked again at each ring because a name
 * can be pointed somewhere else after it was registered. Redirects are not followed.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { pushSignature, type InstanceId, type RoomId } from "../protocol/index.ts";
import { RepositoryError, type PushTarget, type SharedNetRepository } from "./repository.ts";

export interface PushOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Loopback and private addresses are refused unless this is set: a local dev server and tests only. */
  allowPrivate?: boolean;
  /** How a name is resolved; tests stand in for DNS. */
  resolve?: (host: string) => Promise<string[]>;
}

/** A ring must answer within this, or it counts as not got through. */
export const RING_TIMEOUT_MS = 5_000;
/** A ring that got through but was not acknowledged rings again after this. */
export const UNACKED_RERING_MS = 10 * 60_000;
/** After a ring that failed: 1, 2, 4 … minutes, at most an hour. */
export function ringBackoffMs(failures: number): number {
  return Math.min(2 ** Math.max(0, failures - 1) * 60_000, 60 * 60_000);
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

/** True for an address that is not on the public internet: loopback, private, link-local, shared, multicast, reserved. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    const inRange = (base: string, bits: number) => (value >>> (32 - bits)) === (ipv4Number(base) >>> (32 - bits));
    return (
      inRange("0.0.0.0", 8) ||
      inRange("10.0.0.0", 8) ||
      inRange("100.64.0.0", 10) ||
      inRange("127.0.0.0", 8) ||
      inRange("169.254.0.0", 16) ||
      inRange("172.16.0.0", 12) ||
      inRange("192.0.0.0", 24) ||
      inRange("192.168.0.0", 16) ||
      inRange("198.18.0.0", 15) ||
      value >= ipv4Number("224.0.0.0")
    );
  }
  const lowered = address.toLowerCase();
  return (
    lowered === "::" ||
    lowered === "::1" ||
    lowered.startsWith("fc") ||
    lowered.startsWith("fd") ||
    lowered.startsWith("fe8") ||
    lowered.startsWith("fe9") ||
    lowered.startsWith("fea") ||
    lowered.startsWith("feb") ||
    lowered.startsWith("ff")
  );
}

/** Refuses an address the service must not knock on: not https, or not on the public internet. */
export async function assertRingable(url: string, options: PushOptions = {}): Promise<void> {
  const parsed = new URL(url);
  if (options.allowPrivate) return;
  if (parsed.protocol !== "https:") throw new RepositoryError(422, "validation_failed", "A doorbell needs an https address.");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const resolve = options.resolve ?? (async (name: string) => (await lookup(name, { all: true })).map((entry) => entry.address));
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new RepositoryError(422, "validation_failed", "A doorbell must be on the public internet.");
  }
}

/** One ring: true when the seat's address answered 2xx within the time allowed. */
async function ring(target: PushTarget, now: Date, options: PushOptions): Promise<boolean> {
  await assertRingable(target.url, options);
  const body = JSON.stringify({ room_id: target.room_id, member_id: target.instance_id, through: target.through, acked_through: target.acked_through });
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const response = await (options.fetch ?? globalThis.fetch)(target.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "user-agent": "SharedNet-Doorbell/1",
      "x-sharednet-timestamp": timestamp,
      "x-sharednet-signature": `sha256=${pushSignature(target.secret, timestamp, body)}`,
    },
    body,
    signal: AbortSignal.timeout(RING_TIMEOUT_MS),
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status >= 200 && response.status < 300;
}

/**
 * Ring every doorbell in a Room that has something to ring for, but the speaker's. Never throws: a
 * ring that fails is recorded and rung again later, by the next line or by the tick.
 */
export async function ringRoom(
  repository: SharedNetRepository,
  roomId: RoomId,
  except: InstanceId | null,
  options: PushOptions = {},
): Promise<{ rung: number; failed: number }> {
  const now = options.now?.() ?? new Date();
  const targets = await repository.pushTargets(roomId, except, now).catch(() => []);
  const outcomes = await Promise.all(
    targets.map(async (target) => {
      const ok = await ring(target, now, options).catch(() => false);
      const retryAt = new Date(now.getTime() + (ok ? UNACKED_RERING_MS : ringBackoffMs(target.failures + 1)));
      await repository.notePush(target.instance_id, roomId, { ok, through: target.through, retryAt }).catch(() => undefined);
      return ok;
    }),
  );
  return { rung: outcomes.filter(Boolean).length, failed: outcomes.filter((ok) => !ok).length };
}

/**
 * The tick, run every minute by a scheduler: say what timers have come due in Rooms nobody is
 * asking, and ring doorbells that are due again. With it, a timer is said on time and a lost ring
 * is rung again, though not one request comes from the seats.
 */
export async function tick(repository: SharedNetRepository, options: PushOptions = {}): Promise<{ rooms: number; said: number; rung: number; failed: number }> {
  const now = options.now?.() ?? new Date();
  const rooms = await repository.roomsDue(now, 200);
  let said = 0;
  let rung = 0;
  let failed = 0;
  for (const roomId of rooms) {
    said += await repository.fireDueTimers(roomId).catch(() => 0);
    const outcome = await ringRoom(repository, roomId, null, options);
    rung += outcome.rung;
    failed += outcome.failed;
  }
  return { rooms: rooms.length, said, rung, failed };
}
