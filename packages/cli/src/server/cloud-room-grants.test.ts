// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CLOUD_ROOM_GRANT_MAX_ATTEMPTS, cloudRoomGrantNotice, cloudRoomGrantRefusal, cloudRoomGrantRetryMs, decideSeatGrant, seatStillHeld, type SeatFacts } from "./cloud-room-grants.ts";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import type { CloudRoomGrantClaim, CloudRoomGrantSeat, SeatTaken } from "./repository.ts";

const OWNER_KEY = `snk_${"a".repeat(43)}`;
const STRANGER_KEY = `snk_${"s".repeat(43)}`;

/**
 * Two accounts with a Principal each, on a clock the test moves. The owner's
 * SharedOS Cloud agent is the Instance the console's seat route starts for it
 * (`seatCloudAgent`): runtime kind sharedos, its machine and handle in the
 * metadata, public reach as any Instance has unless told otherwise.
 */
async function world(options: { seated?: (seat: SeatTaken) => void | Promise<void>; unseated?: (seat: CloudRoomGrantSeat) => void | Promise<void> } = {}) {
  let clock = new Date("2026-10-28T12:00:00Z");
  const repository = new MemorySharedNetRepository({
    accounts: [
      { authUserId: "acct-owner", apiKey: OWNER_KEY, displayName: "Ada" },
      { authUserId: "acct-stranger", apiKey: STRANGER_KEY, displayName: "Sam" },
    ],
    now: () => clock,
    seated: options.seated,
    unseated: options.unseated,
  });
  const owner = (await repository.authenticateApiKey(OWNER_KEY))!;
  const stranger = (await repository.authenticateApiKey(STRANGER_KEY))!;
  const builder = await repository.startInstance(owner, { runtime_kind: "sharedos", cli_version: "sharedos", agent_id: null, runtime_metadata: { machine: "demo", handle: "builder", role: "agent" } });
  const builderAuth = (await repository.authenticateInstance(builder.token))!;
  const dashboard = (await repository.dashboardSeat("acct-owner")).auth;
  const strangers = await repository.startInstance(stranger, { runtime_kind: "claude-code", cli_version: "1.0.0", agent_id: null });
  const strangerAuth = (await repository.authenticateInstance(strangers.token))!;
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { repository, owner, stranger, builder: builder.instance, builderAuth, dashboard, strangers: strangers.instance, strangerAuth, advance };
}

describe("whether a seat taken is one to grant", () => {
  const seat = (over: Partial<SeatTaken> = {}): SeatTaken =>
    ({ room_id: "rom_room1", room_kind: "standard", instance_id: "i_builder1", principal_id: "p_owner", by_principal_id: "p_owner", ...over }) as unknown as SeatTaken;
  const cloudSeat: SeatFacts = { machine: "demo", auth_user_id: "acct-owner" };

  it("grants the owner's cloud agent a Room the owner seated it in", () => {
    expect(decideSeatGrant(seat(), cloudSeat)).toEqual({ grant: true, machine: "demo", auth_user_id: "acct-owner" });
  });

  it("leaves alone an Instance that is not a cloud agent, or one that is gone", () => {
    expect(decideSeatGrant(seat(), null)).toEqual({ grant: false, because: "not_a_cloud_seat" });
    expect(decideSeatGrant(seat(), { machine: null, auth_user_id: "acct-owner" })).toEqual({ grant: false, because: "not_a_cloud_seat" });
  });

  it("leaves the seat's own direct Room to the kernel, which grants it from the seat answer", () => {
    expect(decideSeatGrant(seat({ room_kind: "direct" }), cloudSeat)).toEqual({ grant: false, because: "the_seats_own_direct_room" });
  });

  it("grants nothing on a stranger's word: a public seat taken into somebody else's Room", () => {
    expect(decideSeatGrant(seat({ by_principal_id: "p_stranger" as never }), cloudSeat)).toEqual({ grant: false, because: "not_the_owners_doing" });
  });

  it("grants nothing for a Principal with no account behind it", () => {
    expect(decideSeatGrant(seat(), { machine: "demo", auth_user_id: null })).toEqual({ grant: false, because: "no_account_behind_it" });
  });

  it("waits a minute, then twice as long each time, an hour at most, and keeps the console's words to a line", () => {
    expect([1, 2, 3, 6, 7, 8].map(cloudRoomGrantRetryMs)).toEqual([60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000]);
    expect(cloudRoomGrantRefusal("  not_found:\n  No such machine. ")).toBe("not_found: No such machine.");
    expect(cloudRoomGrantRefusal("   ")).toBe("SharedOS Cloud gave no reason.");
    expect(cloudRoomGrantRefusal("x".repeat(600))).toHaveLength(500);
  });

  it("a promise stands for the seating it was made for alone: the same membership, still active", () => {
    const seated = new Date("2026-10-28T12:00:00Z");
    expect(seatStillHeld({ seated_at: seated }, { state: "active", joined_at: seated })).toBe(true);
    expect(seatStillHeld({ seated_at: seated }, { state: "left", joined_at: seated })).toBe(false);
    expect(seatStillHeld({ seated_at: seated }, { state: "active", joined_at: new Date(seated.getTime() + 1) })).toBe(false);
    expect(seatStillHeld({ seated_at: seated }, null)).toBe(false);
    expect(seatStillHeld({ seated_at: seated.toISOString() }, { state: "active", joined_at: seated.toISOString() })).toBe(true);
  });

  it("the notice quotes the console with its @s set apart, so the text addresses nobody wherever it is read", () => {
    expect(cloudRoomGrantNotice("asking", { id: "i_builder1", handle: "builder" }, "say @i_builder1 or @Ada to proceed")).toContain(
      `The console said: "say (at)i_builder1 or (at)Ada to proceed"`,
    );
    expect(cloudRoomGrantNotice("through", { id: "i_builder1", handle: null }, null)).toBe("I_builder1 can answer here now. Say your message again if it went unanswered.");
    expect(cloudRoomGrantNotice("unresolved", { id: "i_builder1", handle: "builder" }, "SharedOS Cloud could not be reached: TimeoutError")).toBe(
      `The builder (i_builder1) is in this Room but cannot answer here: SharedNet could not learn from SharedOS Cloud whether its earlier grant on this Room was taken back, so it has not asked for a new one. The console said: "SharedOS Cloud could not be reached: TimeoutError" Its owner can try once more by removing it from this Room and adding it back, or look at its machine on SharedOS Cloud.`,
    );
  });
});

describe("the cloud Room grant queue", () => {
  it("the owner opens a Room with the agent in it: the grant is queued with the seat, claimed, and settled as granted", async () => {
    const { repository, builder, dashboard } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([
      { room_id: room.id, instance_id: builder.id, room_name: "To-do", machine: "demo", intent: "grant", state: "pending", attempts: 0, last_refusal: null, since: "2026-10-28T12:00:00.000Z" },
    ]);
    const claim = (await repository.claimCloudRoomGrant({ seat }))!;
    expect(claim).toMatchObject({ room_id: room.id, instance_id: builder.id, machine: "demo", auth_user_id: "acct-owner", attempts: 1 });
    expect((await repository.cloudRoomGrantsForAccount("acct-owner"))[0]).toMatchObject({ state: "processing", attempts: 1 });
    // Held under a lease: nobody else claims it meanwhile.
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect(await repository.completeCloudRoomGrant(seat, claim.leaseToken)).toBe(true);
    expect(await repository.completeCloudRoomGrant(seat, claim.leaseToken)).toBe(false);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
  });

  it("queues nothing for a stranger's seating, for the seat's own direct Room, or for an Instance that is not a cloud agent", async () => {
    const { repository, builder, dashboard, strangerAuth } = await world();
    await repository.createRoom(strangerAuth, { name: "Sam's Room", with: [builder.id] });
    await repository.createRoom(dashboard, { name: "builder · direct", kind: "direct", with: [builder.id] });
    await repository.createRoom(dashboard, { name: "Humans only" });
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    expect(await repository.cloudRoomGrantsForAccount("acct-stranger")).toEqual([]);
  });

  it("the agent added later, or joining by itself, is queued the same; a sitting member's second join changes nothing", async () => {
    const { repository, builder, builderAuth, dashboard } = await world();
    const later = await repository.createRoom(dashboard, { name: "Later" });
    await repository.addRoomMembers(dashboard, later.room.id, { with: [builder.id] });
    const floor = await repository.createRoom(dashboard, { name: "Open floor" });
    await repository.joinRoom(builderAuth, floor.room.id);
    const first = (await repository.claimCloudRoomGrant())!;
    await repository.joinRoom(builderAuth, floor.room.id);
    const second = (await repository.claimCloudRoomGrant())!;
    expect([first.room_id, second.room_id].sort()).toEqual([later.room.id, floor.room.id].sort());
    expect(await repository.claimCloudRoomGrant()).toBeNull();
  });

  it("a refusal is kept in the console's words and the grant is due again later, until the attempts are spent", async () => {
    const { repository, builder, dashboard, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    for (let attempt = 1; attempt <= CLOUD_ROOM_GRANT_MAX_ATTEMPTS; attempt++) {
      const claim = (await repository.claimCloudRoomGrant())!;
      expect(claim.attempts).toBe(attempt);
      expect(await repository.failCloudRoomGrant(seat, claim.leaseToken, `cloud_unreachable: attempt ${attempt}`)).toBe(true);
      expect(await repository.failCloudRoomGrant(seat, claim.leaseToken, "again")).toBe(false);
      const [view] = await repository.cloudRoomGrantsForAccount("acct-owner");
      if (attempt < CLOUD_ROOM_GRANT_MAX_ATTEMPTS) {
        expect(view).toMatchObject({ state: "pending", attempts: attempt, last_refusal: `cloud_unreachable: attempt ${attempt}` });
        // Not due before its time.
        advance(cloudRoomGrantRetryMs(attempt) - 1);
        expect(await repository.claimCloudRoomGrant()).toBeNull();
        advance(1);
      } else {
        expect(view).toMatchObject({ state: "failed", attempts: attempt, last_refusal: `cloud_unreachable: attempt ${attempt}` });
      }
    }
    advance(24 * 3_600_000);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
  });

  it("a lease that runs out is claimed again with a new token, and the old token settles nothing", async () => {
    const { repository, builder, dashboard, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant({ leaseMs: 1000 }))!;
    advance(999);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    advance(1);
    const second = (await repository.claimCloudRoomGrant())!;
    expect(second.attempts).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await repository.completeCloudRoomGrant(seat, first.leaseToken)).toBe(false);
    expect(await repository.completeCloudRoomGrant(seat, second.leaseToken)).toBe(true);
  });

  it("a lease that ran out on the last attempt is failed, not tried again", async () => {
    const { repository, builder, dashboard, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    for (let attempt = 1; attempt < CLOUD_ROOM_GRANT_MAX_ATTEMPTS; attempt++) {
      const claim = (await repository.claimCloudRoomGrant())!;
      await repository.failCloudRoomGrant(seat, claim.leaseToken, "cloud_unreachable: down");
      advance(cloudRoomGrantRetryMs(attempt));
    }
    const last = (await repository.claimCloudRoomGrant({ leaseMs: 1000 }))!;
    expect(last.attempts).toBe(CLOUD_ROOM_GRANT_MAX_ATTEMPTS);
    advance(1000);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect((await repository.cloudRoomGrantsForAccount("acct-owner"))[0]).toMatchObject({ state: "failed", attempts: CLOUD_ROOM_GRANT_MAX_ATTEMPTS, last_refusal: "cloud_unreachable: down" });
  });

  it("a seat gone before the grant was through is superseded: the member removed, the seat left, or the Instance ended", async () => {
    const { repository, owner, builder, builderAuth, dashboard, strangerAuth } = await world();
    const removed = await repository.createRoom(dashboard, { name: "Removed", with: [builder.id] });
    await repository.removeRoomMember(owner.principalId, removed.room.id, builder.id);
    expect(await repository.claimCloudRoomGrant({ seat: { room_id: removed.room.id, instance_id: builder.id } })).toBeNull();
    // Joining Sam's Room by itself is the owner's word too, and leaving it voids the promise.
    const sams = await repository.createRoom(strangerAuth, { name: "Sam's Room" });
    await repository.joinRoom(builderAuth, sams.room.id);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([expect.objectContaining({ room_id: sams.room.id, state: "pending" })]);
    await repository.leaveRoom(owner.principalId, sams.room.id);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    expect(await repository.claimCloudRoomGrant({ seat: { room_id: sams.room.id, instance_id: builder.id } })).toBeNull();
    const ended = await repository.createRoom(dashboard, { name: "Ended", with: [builder.id] });
    await repository.endInstance(builderAuth);
    expect(await repository.claimCloudRoomGrant({ seat: { room_id: ended.room.id, instance_id: builder.id } })).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
  });

  it("a seat left and taken again is due again from the start; a revoke not yet through is settled first, then the grant asked", async () => {
    const { repository, owner, builder, dashboard } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant())!;
    await repository.failCloudRoomGrant(seat, first.leaseToken, "cloud_unreachable: down");
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    expect((await repository.cloudRoomGrantsForAccount("acct-owner"))[0]).toMatchObject({ state: "pending", attempts: 0, last_refusal: null });
    const again = (await repository.claimCloudRoomGrant())!;
    expect(again.attempts).toBe(1);
    expect(await repository.completeCloudRoomGrant(seat, again.leaseToken, { grant_id: "g1", agent_handle: "builder" })).toBe(true);
    // Granted, removed and seated again by the owner before the revoke went out: the revoke is bound to the seating and due now,
    // settled first; then the console is asked for the grant again, and answers already_granted or granted as the kernel has it.
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    const revoke = (await repository.claimCloudRoomGrant())!;
    expect(revoke).toMatchObject({ ...seat, intent: "revoke", grant_id: "g1", attempts: 1 });
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([expect.objectContaining({ ...seat, state: "processing" })]);
    expect(await repository.completeCloudRoomGrant(seat, revoke.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant()).toMatchObject({ ...seat, intent: "grant", attempts: 1 });
  });

  it("a revoke that got no answer while the seat is taken again is tried again, not let go: the DELETE may yet land; through at last, the grant is asked", async () => {
    const { repository, owner, builder, dashboard, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant())!;
    await repository.completeCloudRoomGrant(seat, first.leaseToken, { grant_id: "g1", agent_handle: "builder" });
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    const revoke = (await repository.claimCloudRoomGrant())!;
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    expect(await repository.failCloudRoomGrant(seat, revoke.leaseToken, "SharedOS Cloud could not be reached: TimeoutError", "unknown")).toBe(true);
    // Still the revoke, with the words kept and shown to the owner as waiting; nothing asks the grant yet.
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([expect.objectContaining({ ...seat, state: "pending", attempts: 1, last_refusal: "SharedOS Cloud could not be reached: TimeoutError" })]);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    advance(cloudRoomGrantRetryMs(1));
    const again = (await repository.claimCloudRoomGrant())!;
    expect(again).toMatchObject({ ...seat, intent: "revoke", grant_id: "g1", attempts: 2 });
    // Lost once more, then through: only then is the grant asked, from the start.
    expect(await repository.failCloudRoomGrant(seat, again.leaseToken, "unavailable: The kernel did not answer.", "unknown")).toBe(true);
    advance(cloudRoomGrantRetryMs(2));
    const third = (await repository.claimCloudRoomGrant())!;
    expect(third).toMatchObject({ intent: "revoke", attempts: 3 });
    expect(await repository.completeCloudRoomGrant(seat, third.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant()).toMatchObject({ ...seat, intent: "grant", attempts: 1 });
    expect((await repository.getRoomForPrincipal(owner.principalId, room.id)).messages).toEqual([]);
  });

  it("a revoke given up on with its end unknown and the seat the owner's again stays a failed revoke, whether the last attempt was lost or its lease ran out: no grant is asked, the owner and the Room are told, and removing and seating again tries the revoke anew; a revoke given up on and seated again later is tried again first", async () => {
    const { repository, owner, builder, dashboard, advance } = await world();
    const lost = await repository.createRoom(dashboard, { name: "Lost", with: [builder.id] });
    const ranOut = await repository.createRoom(dashboard, { name: "Ran out", with: [builder.id] });
    const later = await repository.createRoom(dashboard, { name: "Later", with: [builder.id] });
    for (const { room } of [lost, ranOut, later]) {
      const seat = { room_id: room.id, instance_id: builder.id };
      const first = (await repository.claimCloudRoomGrant({ seat }))!;
      await repository.completeCloudRoomGrant(seat, first.leaseToken, { grant_id: `g-${room.name}`, agent_handle: "builder" });
      await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    }
    const lostSeat = { room_id: lost.room.id, instance_id: builder.id }, ranOutSeat = { room_id: ranOut.room.id, instance_id: builder.id }, laterSeat = { room_id: later.room.id, instance_id: builder.id };
    for (let attempt = 1; attempt < CLOUD_ROOM_GRANT_MAX_ATTEMPTS; attempt++) {
      for (const seat of [lostSeat, ranOutSeat, laterSeat]) {
        const claim = (await repository.claimCloudRoomGrant({ seat }))!;
        expect(claim).toMatchObject({ intent: "revoke", attempts: attempt });
        await repository.failCloudRoomGrant(seat, claim.leaseToken, "SharedOS Cloud could not be reached: TimeoutError", "unknown");
      }
      advance(3_600_000);
    }
    // The last attempts out, the owner seats the agent again in two of the Rooms.
    const lastLost = (await repository.claimCloudRoomGrant({ seat: lostSeat }))!;
    const lastRanOut = (await repository.claimCloudRoomGrant({ seat: ranOutSeat }))!;
    const lastLater = (await repository.claimCloudRoomGrant({ seat: laterSeat }))!;
    // Hours have passed on the clock: the owner's dashboard seat is fetched again.
    const owners = async () => (await repository.dashboardSeat("acct-owner")).auth;
    await repository.addRoomMembers(await owners(), lost.room.id, { with: [builder.id] });
    await repository.addRoomMembers(await owners(), ranOut.room.id, { with: [builder.id] });
    // The last attempt lost too: the end of the revoke is still unknown, so the row is a failed revoke and no grant is asked,
    // since that last DELETE may land after any POST. The owner sees it, and the Room is told why its seat is silent.
    expect(await repository.failCloudRoomGrant(lostSeat, lastLost.leaseToken, "SharedOS Cloud could not be reached: TimeoutError", "unknown")).toBe(true);
    expect(await repository.claimCloudRoomGrant({ seat: lostSeat })).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toContainEqual(expect.objectContaining({ ...lostSeat, intent: "revoke", state: "failed", attempts: CLOUD_ROOM_GRANT_MAX_ATTEMPTS, last_refusal: "SharedOS Cloud could not be reached: TimeoutError" }));
    const lostSaid = (await repository.getRoomForPrincipal(owner.principalId, lost.room.id)).messages;
    expect(lostSaid).toHaveLength(1);
    expect(lostSaid[0]!.content).toContain(`The builder (${builder.id}) is in this Room but cannot answer here: SharedNet could not learn from SharedOS Cloud whether its earlier grant on this Room was taken back`);
    expect(await repository.failCloudRoomGrant(laterSeat, lastLater.leaseToken, "SharedOS Cloud could not be reached: TimeoutError", "unknown")).toBe(true);
    advance(3_600_000);
    // The lease ran out on the last attempt: the claim settles it the same way, a failed revoke, nothing to claim, the Room told.
    expect(lastRanOut.leaseToken).toBeTruthy();
    expect(await repository.claimCloudRoomGrant({ seat: ranOutSeat })).toBeNull();
    expect(await repository.claimCloudRoomGrant({ seat: ranOutSeat })).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toContainEqual(expect.objectContaining({ ...ranOutSeat, intent: "revoke", state: "failed", attempts: CLOUD_ROOM_GRANT_MAX_ATTEMPTS }));
    expect((await repository.getRoomForPrincipal(owner.principalId, ranOut.room.id)).messages.map((message) => message.content)).toEqual([expect.stringContaining("could not learn from SharedOS Cloud whether its earlier grant on this Room was taken back")]);
    // The owner's way out: removed and seated again, the revoke is tried anew, and only the console's word settles it.
    await repository.removeRoomMember(owner.principalId, lost.room.id, builder.id);
    expect((await repository.cloudRoomGrantsForAccount("acct-owner")).map((view) => view.room_id)).not.toContain(lost.room.id);
    advance(1_000);
    await repository.addRoomMembers(await owners(), lost.room.id, { with: [builder.id] });
    const anew = (await repository.claimCloudRoomGrant({ seat: lostSeat }))!;
    expect(anew).toMatchObject({ ...lostSeat, intent: "revoke", grant_id: "g-Lost", attempts: 1 });
    expect(await repository.completeCloudRoomGrant(lostSeat, anew.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant({ seat: lostSeat })).toMatchObject({ ...lostSeat, intent: "grant", attempts: 1 });
    // Given up on with the seat gone, the row is failed and nothing is said; seated again by the owner later, the revoke is tried again first.
    expect(await repository.claimCloudRoomGrant({ seat: laterSeat })).toBeNull();
    expect((await repository.cloudRoomGrantsForAccount("acct-owner")).map((view) => view.room_id)).not.toContain(later.room.id);
    expect((await repository.getRoomForPrincipal(owner.principalId, later.room.id)).messages).toEqual([]);
    await repository.addRoomMembers(await owners(), later.room.id, { with: [builder.id] });
    const retried = (await repository.claimCloudRoomGrant({ seat: laterSeat }))!;
    expect(retried).toMatchObject({ ...laterSeat, intent: "revoke", grant_id: "g-Later", attempts: 1 });
    // Refused now, it is still a revoke ten DELETEs of which went unanswered: the refusal settles nothing, the console's word on the grant does.
    expect(await repository.failCloudRoomGrant(laterSeat, retried.leaseToken, "forbidden: A grant is the owner's to revoke.", "refused")).toBe(true);
    expect(await repository.claimCloudRoomGrant({ seat: laterSeat })).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toContainEqual(expect.objectContaining({ ...laterSeat, intent: "revoke", state: "pending", attempts: 1, last_refusal: "forbidden: A grant is the owner's to revoke." }));
    advance(60_000);
    const answered = (await repository.claimCloudRoomGrant({ seat: laterSeat }))!;
    expect(answered).toMatchObject({ ...laterSeat, intent: "revoke", grant_id: "g-Later", attempts: 2 });
    expect(await repository.completeCloudRoomGrant(laterSeat, answered.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant({ seat: laterSeat })).toMatchObject({ ...laterSeat, intent: "grant", attempts: 1 });
  });

  it("a revoke refused after an earlier DELETE of it went unanswered settles nothing: the lost DELETE may yet land, so the row stays a revoke until the console says where the grant stands, and only then is the grant asked; refused until the attempts are spent, it stays a failed revoke and the Room is told", async () => {
    const { repository, owner, builder, dashboard, advance } = await world();
    const mixed = await repository.createRoom(dashboard, { name: "Mixed", with: [builder.id] });
    const spent = await repository.createRoom(dashboard, { name: "Spent", with: [builder.id] });
    const lease = await repository.createRoom(dashboard, { name: "Lease", with: [builder.id] });
    for (const { room } of [mixed, spent, lease]) {
      const seat = { room_id: room.id, instance_id: builder.id };
      const first = (await repository.claimCloudRoomGrant({ seat }))!;
      await repository.completeCloudRoomGrant(seat, first.leaseToken, { grant_id: `g-${room.name}`, agent_handle: "builder" });
      await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    }
    const mixedSeat = { room_id: mixed.room.id, instance_id: builder.id }, spentSeat = { room_id: spent.room.id, instance_id: builder.id }, leaseSeat = { room_id: lease.room.id, instance_id: builder.id };
    advance(1_000);
    for (const { room } of [mixed, spent, lease]) await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    // The first DELETE gets no answer; the second is refused. The refusal is the second call's: the first may still land, and
    // would take back a grant asked now, which the console would have answered already_granted. So no grant is asked.
    const lost = (await repository.claimCloudRoomGrant({ seat: mixedSeat }))!;
    expect(lost).toMatchObject({ intent: "revoke", grant_id: "g-Mixed", attempts: 1 });
    expect(await repository.failCloudRoomGrant(mixedSeat, lost.leaseToken, "SharedOS Cloud could not be reached: TimeoutError", "unknown")).toBe(true);
    advance(60_000);
    const refused = (await repository.claimCloudRoomGrant({ seat: mixedSeat }))!;
    expect(refused).toMatchObject({ intent: "revoke", grant_id: "g-Mixed", attempts: 2 });
    expect(await repository.failCloudRoomGrant(mixedSeat, refused.leaseToken, "rate_limited: Too many requests.", "refused")).toBe(true);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toContainEqual(expect.objectContaining({ ...mixedSeat, intent: "revoke", state: "pending", attempts: 2, last_refusal: "rate_limited: Too many requests." }));
    expect(await repository.claimCloudRoomGrant({ seat: mixedSeat })).toBeNull();
    expect((await repository.getRoomForPrincipal(owner.principalId, mixed.room.id)).messages).toEqual([]);
    // The console's word on the grant itself, gone: that settles it, and the grant is asked.
    advance(120_000);
    const answered = (await repository.claimCloudRoomGrant({ seat: mixedSeat }))!;
    expect(answered).toMatchObject({ intent: "revoke", grant_id: "g-Mixed", attempts: 3 });
    expect(await repository.completeCloudRoomGrant(mixedSeat, answered.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant({ seat: mixedSeat })).toMatchObject({ ...mixedSeat, intent: "grant", attempts: 1 });
    // A lease that ran out on a DELETE is an end never learned too: the refusal of the next one settles nothing either.
    const ranOut = (await repository.claimCloudRoomGrant({ seat: leaseSeat }))!;
    expect(ranOut).toMatchObject({ intent: "revoke", grant_id: "g-Lease", attempts: 1 });
    advance(60_000);
    const after = (await repository.claimCloudRoomGrant({ seat: leaseSeat }))!;
    expect(after).toMatchObject({ intent: "revoke", grant_id: "g-Lease", attempts: 2 });
    expect(await repository.failCloudRoomGrant(leaseSeat, after.leaseToken, "forbidden: A grant is the owner's to revoke.", "refused")).toBe(true);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toContainEqual(expect.objectContaining({ ...leaseSeat, intent: "revoke", state: "pending", attempts: 2 }));
    expect(await repository.claimCloudRoomGrant({ seat: leaseSeat })).toBeNull();
    // Refused at every attempt after the one that was lost, the row is given up on as a failed revoke, never a grant, and the Room is told why its seat is silent.
    const owners = async () => (await repository.dashboardSeat("acct-owner")).auth;
    const lostSpent = (await repository.claimCloudRoomGrant({ seat: spentSeat }))!;
    expect(await repository.failCloudRoomGrant(spentSeat, lostSpent.leaseToken, "SharedOS Cloud could not be reached: TimeoutError", "unknown")).toBe(true);
    for (let attempt = 2; attempt <= CLOUD_ROOM_GRANT_MAX_ATTEMPTS; attempt++) {
      advance(3_600_000);
      const claim = (await repository.claimCloudRoomGrant({ seat: spentSeat }))!;
      expect(claim).toMatchObject({ intent: "revoke", grant_id: "g-Spent", attempts: attempt });
      expect(await repository.failCloudRoomGrant(spentSeat, claim.leaseToken, "rate_limited: Too many requests.", "refused")).toBe(true);
    }
    advance(3_600_000);
    expect(await repository.claimCloudRoomGrant({ seat: spentSeat })).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toContainEqual(expect.objectContaining({ ...spentSeat, intent: "revoke", state: "failed", attempts: CLOUD_ROOM_GRANT_MAX_ATTEMPTS, last_refusal: "rate_limited: Too many requests." }));
    expect((await repository.getRoomForPrincipal(owner.principalId, spent.room.id)).messages.map((message) => message.content)).toEqual([
      expect.stringContaining(`The builder (${builder.id}) is in this Room but cannot answer here: SharedNet could not learn from SharedOS Cloud whether its earlier grant on this Room was taken back`),
    ]);
    // Removed and seated again, the revoke is tried anew, and still only the console's word on the grant settles it.
    await repository.removeRoomMember(owner.principalId, spent.room.id, builder.id);
    advance(1_000);
    await repository.addRoomMembers(await owners(), spent.room.id, { with: [builder.id] });
    const anew = (await repository.claimCloudRoomGrant({ seat: spentSeat }))!;
    expect(anew).toMatchObject({ intent: "revoke", grant_id: "g-Spent", attempts: 1 });
    expect(await repository.failCloudRoomGrant(spentSeat, anew.leaseToken, "rate_limited: Too many requests.", "refused")).toBe(true);
    expect(await repository.claimCloudRoomGrant({ seat: spentSeat })).toBeNull();
    advance(60_000);
    const settled = (await repository.claimCloudRoomGrant({ seat: spentSeat }))!;
    expect(await repository.completeCloudRoomGrant(spentSeat, settled.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant({ seat: spentSeat })).toMatchObject({ ...spentSeat, intent: "grant", attempts: 1 });
  });

  it("a granted seat removed asks the console to take the grant back, by the name it gave; through, the row is revoked and nothing waits", async () => {
    const { repository, owner, builder, dashboard } = await world();
    const ended: unknown[] = [];
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant())!;
    expect(await repository.completeCloudRoomGrant(seat, first.leaseToken, { grant_id: "g1", agent_handle: "builder" })).toBe(true);
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    const revoke = (await repository.claimCloudRoomGrant())!;
    expect(revoke).toMatchObject({ ...seat, intent: "revoke", grant_id: "g1", agent_handle: "builder", machine: "demo", auth_user_id: "acct-owner", attempts: 1 });
    // A revoke stands whatever the Room holds now: a stranger's seating of the agent meanwhile does not spare the old grant.
    expect(await repository.completeCloudRoomGrant(seat, revoke.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect((await repository.getRoomForPrincipal(owner.principalId, room.id)).messages).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("a seat taken again while its revoke is out waits on the attempt: the row is bound to the new seating, not written over, and the revoke through, the grant is asked afresh and told", async () => {
    const due: CloudRoomGrantSeat[] = [];
    const { repository, owner, builder, dashboard } = await world({ unseated: (seat) => { due.push(seat); } });
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant())!;
    expect(await repository.completeCloudRoomGrant(seat, first.leaseToken, { grant_id: "g1", agent_handle: "builder" })).toBe(true);
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    expect(due).toEqual([seat]);
    const revoke = (await repository.claimCloudRoomGrant())!;
    expect(revoke).toMatchObject({ intent: "revoke", grant_id: "g1", attempts: 1 });
    // The DELETE is out when the owner seats the agent again: nothing is claimed for the seat, which the owner sees waiting.
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([expect.objectContaining({ ...seat, state: "processing", attempts: 1 })]);
    // The revoke lands: the row is not revoked but the grant the new seating is owed, from the start, and told as due.
    expect(await repository.completeCloudRoomGrant(seat, revoke.leaseToken)).toBe(true);
    expect(due).toEqual([seat, seat]);
    const again = (await repository.claimCloudRoomGrant())!;
    expect(again).toMatchObject({ ...seat, intent: "grant", attempts: 1 });
    expect(await repository.completeCloudRoomGrant(seat, again.leaseToken, { grant_id: "g2", agent_handle: "builder" })).toBe(true);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    expect((await repository.getRoomForPrincipal(owner.principalId, room.id)).messages).toEqual([]);
    // Removed once more, it is the new grant that is taken back.
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    expect(await repository.claimCloudRoomGrant()).toMatchObject({ intent: "revoke", grant_id: "g2" });
  });

  it("a revoke refused while the seat is taken again is let go: the grant the seating is owed is asked instead, with nothing said", async () => {
    const { repository, owner, builder, dashboard } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant())!;
    await repository.completeCloudRoomGrant(seat, first.leaseToken, { grant_id: "g1", agent_handle: "builder" });
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    const revoke = (await repository.claimCloudRoomGrant())!;
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    expect(await repository.failCloudRoomGrant(seat, revoke.leaseToken, "unavailable: The kernel did not answer.")).toBe(true);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([expect.objectContaining({ ...seat, state: "pending", attempts: 0, last_refusal: null })]);
    expect(await repository.claimCloudRoomGrant()).toMatchObject({ ...seat, intent: "grant", attempts: 1 });
    expect((await repository.getRoomForPrincipal(owner.principalId, room.id)).messages).toEqual([]);
  });

  it("a seat removed and taken again by the owner while its grant attempt is out is granted by that attempt; taken again by somebody else, the grant is taken back", async () => {
    const { repository, owner, builder, dashboard, strangers, strangerAuth, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id, strangers.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const out = (await repository.claimCloudRoomGrant())!;
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    advance(1_000);
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect(await repository.completeCloudRoomGrant(seat, out.leaseToken, { grant_id: "g1", agent_handle: "builder" })).toBe(true);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    // Removed, and seated again by Sam while the revoke is out: the revoke stands, and Sam's seating asks nothing.
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    const revoke = (await repository.claimCloudRoomGrant())!;
    expect(revoke).toMatchObject({ intent: "revoke", grant_id: "g1" });
    advance(1_000);
    await repository.addRoomMembers(strangerAuth, room.id, { with: [builder.id] });
    expect(await repository.completeCloudRoomGrant(seat, revoke.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
  });

  it("a revoke the console refuses is due again and given up on like a grant, with nothing said in the Room; a grant never named is only superseded", async () => {
    const { repository, owner, builder, dashboard, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant())!;
    await repository.completeCloudRoomGrant(seat, first.leaseToken, { grant_id: "g1", agent_handle: "builder" });
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    for (let attempt = 1; attempt <= CLOUD_ROOM_GRANT_MAX_ATTEMPTS; attempt++) {
      const claim = (await repository.claimCloudRoomGrant())!;
      expect(claim).toMatchObject({ intent: "revoke", attempts: attempt });
      expect(await repository.failCloudRoomGrant(seat, claim.leaseToken, "unavailable: The kernel did not answer.")).toBe(true);
      expect(await repository.claimCloudRoomGrant()).toBeNull();
      advance(3_600_000);
    }
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect((await repository.getRoomForPrincipal(owner.principalId, room.id)).messages).toEqual([]);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    const unnamed = await repository.createRoom((await repository.dashboardSeat("acct-owner")).auth, { name: "Unnamed", with: [builder.id] });
    const claim = (await repository.claimCloudRoomGrant())!;
    await repository.completeCloudRoomGrant({ room_id: unnamed.room.id, instance_id: builder.id }, claim.leaseToken);
    await repository.removeRoomMember(owner.principalId, unnamed.room.id, builder.id);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
  });

  it("the observer is told after the grant is queued, so it can claim that seat's grant at once; and of the seat's end, once a grant through is to be taken back", async () => {
    const claims: Array<CloudRoomGrantClaim | null> = [];
    const ended: Array<CloudRoomGrantClaim | null> = [];
    const held: { repository?: MemorySharedNetRepository } = {};
    const { repository, owner, builder, dashboard } = await world({
      seated: async (seat) => {
        claims.push(await held.repository!.claimCloudRoomGrant({ seat: { room_id: seat.room_id, instance_id: seat.instance_id } }));
      },
      unseated: async (seat) => {
        ended.push(await held.repository!.claimCloudRoomGrant({ seat }));
      },
    });
    held.repository = repository;
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    await new Promise((resolve) => setImmediate(resolve));
    // The creator's own seat has no grant to claim; the builder's is there by the time it is told.
    expect(claims).toEqual([null, expect.objectContaining({ room_id: room.id, instance_id: builder.id, intent: "grant", attempts: 1 })]);
    const seat = { room_id: room.id, instance_id: builder.id };
    // Removed before the grant is through: nothing to take back, nothing told. Seated again while that attempt is out, nothing is
    // claimed for the seat; the attempt lands as the new seating's grant.
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    expect(ended).toEqual([]);
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.id] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(claims[2]).toBeNull();
    expect(await repository.completeCloudRoomGrant(seat, claims[1]!.leaseToken, { grant_id: "g1", agent_handle: "builder" })).toBe(true);
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toEqual([expect.objectContaining({ ...seat, intent: "revoke", grant_id: "g1", agent_handle: "builder", attempts: 1 })]);
  });

  it("the Room is told once when the first attempt fails, once when the attempts are spent, and once when a failed grant is through", async () => {
    const { repository, owner, builder, dashboard, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const lines = async () => (await repository.getRoomForPrincipal(owner.principalId, room.id)).messages.map((message) => message.content);
    expect(await lines()).toEqual([]);
    const first = (await repository.claimCloudRoomGrant())!;
    await repository.failCloudRoomGrant(seat, first.leaseToken, "cloud_unreachable: SharedOS Cloud could not be reached");
    expect(await lines()).toEqual([
      `The builder (${builder.id}) is in this Room but SharedOS Cloud has not granted it the Room yet, so it cannot answer here. SharedNet is asking again; once it is through, say your message again. The console said: "cloud_unreachable: SharedOS Cloud could not be reached"`,
    ]);
    // The notice addresses nobody, so it wakes nobody.
    expect((await repository.getRoomForPrincipal(owner.principalId, room.id)).messages[0]!.mentions).toEqual([]);
    for (let attempt = 2; attempt < CLOUD_ROOM_GRANT_MAX_ATTEMPTS; attempt++) {
      advance(cloudRoomGrantRetryMs(attempt - 1));
      const claim = (await repository.claimCloudRoomGrant())!;
      await repository.failCloudRoomGrant(seat, claim.leaseToken, "cloud_unreachable: still down");
    }
    expect(await lines()).toHaveLength(1);
    advance(cloudRoomGrantRetryMs(CLOUD_ROOM_GRANT_MAX_ATTEMPTS - 1));
    const last = (await repository.claimCloudRoomGrant())!;
    await repository.failCloudRoomGrant(seat, last.leaseToken, "not_found: No such machine.");
    expect((await lines()).at(-1)).toBe(
      `SharedOS Cloud would not grant the builder (${builder.id}) this Room, so it cannot answer here. The console said: "not_found: No such machine." Its owner can ask once more by removing it from this Room and adding it back, or look at its machine on SharedOS Cloud.`,
    );
    // Asked once more and through: the Room hears it is answered now. (The dashboard seat is fetched again: hours passed on the clock.)
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    await repository.addRoomMembers((await repository.dashboardSeat("acct-owner")).auth, room.id, { with: [builder.id] });
    const again = (await repository.claimCloudRoomGrant())!;
    await repository.failCloudRoomGrant(seat, again.leaseToken, "cloud_unreachable: a blip");
    advance(cloudRoomGrantRetryMs(1));
    const through = (await repository.claimCloudRoomGrant())!;
    await repository.completeCloudRoomGrant(seat, through.leaseToken);
    const all = await lines();
    expect(all).toHaveLength(4);
    expect(all.at(-1)).toBe(`The builder (${builder.id}) can answer here now. Say your message again if it went unanswered.`);
  });

  it("a grant through at the first attempt, or in a Room since closed, says nothing", async () => {
    const { repository, owner, builder, dashboard } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const claim = (await repository.claimCloudRoomGrant())!;
    await repository.completeCloudRoomGrant(seat, claim.leaseToken);
    expect((await repository.getRoomForPrincipal(owner.principalId, room.id)).messages).toEqual([]);
    const closed = await repository.createRoom(dashboard, { name: "Closed", with: [builder.id] });
    const held = (await repository.claimCloudRoomGrant())!;
    await repository.closeRoom(owner.principalId, closed.room.id);
    expect(await repository.failCloudRoomGrant({ room_id: closed.room.id, instance_id: builder.id }, held.leaseToken, "cloud_unreachable: down")).toBe(true);
    expect((await repository.getRoomForPrincipal(owner.principalId, closed.room.id)).messages).toEqual([]);
  });

  it("the owner's word is for one seating: removed, then seated again on somebody else's word, the agent is granted nothing", async () => {
    const { repository, owner, builder, dashboard, strangers, strangerAuth, advance } = await world();
    // Sam is in Ada's Room too, and any member may seat a public Instance.
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id, strangers.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const first = (await repository.claimCloudRoomGrant())!;
    await repository.failCloudRoomGrant(seat, first.leaseToken, "cloud_unreachable: down");
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    // The promise went with the seat, before anybody took it again.
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    advance(60_000);
    await repository.addRoomMembers(strangerAuth, room.id, { with: [builder.id] });
    expect((await repository.getRoom(strangerAuth, room.id)).memberships.find((member) => member.instance_id === builder.id)?.state).toBe("active");
    advance(3_600_000);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    // Ada seating it again is her word anew.
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    await repository.addRoomMembers((await repository.dashboardSeat("acct-owner")).auth, room.id, { with: [builder.id] });
    expect((await repository.claimCloudRoomGrant())).toMatchObject({ ...seat, attempts: 1 });
  });

  it("a seat removed while its attempt is out settles nothing when the attempt comes back, granted or refused", async () => {
    const { repository, owner, builder, dashboard } = await world();
    const granted = await repository.createRoom(dashboard, { name: "Granted late", with: [builder.id] });
    const refused = await repository.createRoom(dashboard, { name: "Refused late", with: [builder.id] });
    const one = (await repository.claimCloudRoomGrant({ seat: { room_id: granted.room.id, instance_id: builder.id } }))!;
    const two = (await repository.claimCloudRoomGrant({ seat: { room_id: refused.room.id, instance_id: builder.id } }))!;
    await repository.removeRoomMember(owner.principalId, granted.room.id, builder.id);
    await repository.removeRoomMember(owner.principalId, refused.room.id, builder.id);
    expect(await repository.completeCloudRoomGrant({ room_id: granted.room.id, instance_id: builder.id }, one.leaseToken, { grant_id: "g9", agent_handle: "builder" })).toBe(false);
    expect(await repository.failCloudRoomGrant({ room_id: refused.room.id, instance_id: builder.id }, two.leaseToken, "cloud_unreachable: down")).toBe(false);
    // Neither Room heard a word, and nothing waits on the owner.
    expect((await repository.getRoomForPrincipal(owner.principalId, refused.room.id)).messages).toEqual([]);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    // The grant that landed on the seat gone is to be taken back, by the name the console gave it.
    const late = (await repository.claimCloudRoomGrant())!;
    expect(late).toMatchObject({ room_id: granted.room.id, instance_id: builder.id, intent: "revoke", grant_id: "g9", agent_handle: "builder" });
    expect(await repository.completeCloudRoomGrant({ room_id: granted.room.id, instance_id: builder.id }, late.leaseToken)).toBe(true);
    expect(await repository.claimCloudRoomGrant()).toBeNull();
  });

  it("a grant given up on is nobody's to wait on once the seat is gone", async () => {
    const { repository, owner, builder, builderAuth, dashboard, advance } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    for (let attempt = 1; attempt <= CLOUD_ROOM_GRANT_MAX_ATTEMPTS; attempt++) {
      const claim = (await repository.claimCloudRoomGrant())!;
      await repository.failCloudRoomGrant(seat, claim.leaseToken, "not_found: No such machine.");
      advance(3_600_000);
    }
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([expect.objectContaining({ ...seat, state: "failed" })]);
    await repository.removeRoomMember(owner.principalId, room.id, builder.id);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
    const ended = await repository.createRoom((await repository.dashboardSeat("acct-owner")).auth, { name: "Ended", with: [builder.id] });
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([expect.objectContaining({ room_id: ended.room.id, state: "pending" })]);
    await repository.endInstance(builderAuth);
    expect(await repository.cloudRoomGrantsForAccount("acct-owner")).toEqual([]);
  });

  it("the console's words are quoted without waking anybody, even when they hold a seat's @", async () => {
    const { repository, owner, builder, dashboard, strangers } = await world();
    const { room } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.id, strangers.id] });
    const seat = { room_id: room.id, instance_id: builder.id };
    const claim = (await repository.claimCloudRoomGrant())!;
    await repository.failCloudRoomGrant(seat, claim.leaseToken, `forbidden: ask @${builder.id} or @${strangers.id} or @Sam`);
    const [line] = (await repository.getRoomForPrincipal(owner.principalId, room.id)).messages;
    expect(line!.content).toContain(`The console said: "forbidden: ask (at)${builder.id} or (at)${strangers.id} or (at)Sam"`);
    expect(line!.mentions).toEqual([]);
    // The same words said by a member address the seats named: it is the notice that addresses nobody.
    const said = await repository.postMessage(dashboard, room.id, { content: line!.content.replaceAll("(at)", "@") });
    expect(said.message.mentions).toContain(builder.id);
  });

  it("refuses a lease outside the bounds", async () => {
    const { repository } = await world();
    await expect(repository.claimCloudRoomGrant({ leaseMs: 10 })).rejects.toThrow("between 1000 and 300000");
  });
});
