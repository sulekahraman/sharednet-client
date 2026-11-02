// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { MemorySharedNetRepository } from "./memory-repository.ts";
import type { SeatTaken } from "./repository.ts";

const OWNER_KEY = `snk_${"a".repeat(43)}`;
const STRANGER_KEY = `snk_${"s".repeat(43)}`;

/**
 * Two accounts with a Principal each. The owner's SharedOS Cloud agent is the
 * Instance the console's seat route starts for it (`seatCloudAgent`): runtime
 * kind sharedos, its machine and handle in the metadata, public reach as any
 * Instance has unless told otherwise.
 */
async function world(seated: (seat: SeatTaken) => void | Promise<void>) {
  const repository = new MemorySharedNetRepository({
    accounts: [
      { authUserId: "owner", apiKey: OWNER_KEY, displayName: "Ada" },
      { authUserId: "stranger", apiKey: STRANGER_KEY, displayName: "Sam" },
    ],
    seated,
  });
  const owner = (await repository.authenticateApiKey(OWNER_KEY))!;
  const stranger = (await repository.authenticateApiKey(STRANGER_KEY))!;
  const builder = await repository.startInstance(owner, { runtime_kind: "sharedos", cli_version: "sharedos", agent_id: null, runtime_metadata: { machine: "demo", handle: "builder", role: "agent" } });
  const builderAuth = (await repository.authenticateInstance(builder.token))!;
  const dashboard = (await repository.dashboardSeat("owner")).auth;
  const strangers = await repository.startInstance(stranger, { runtime_kind: "claude-code", cli_version: "1.0.0", agent_id: null });
  const strangerAuth = (await repository.authenticateInstance(strangers.token))!;
  return { repository, owner, stranger, builder, builderAuth, dashboard, strangerAuth };
}

describe("a seat taken is told once it is written, with whose doing it was", () => {
  it("the owner opens a Room with the agent in it: the creator's seat and the agent's, both the owner's word", async () => {
    const seats: SeatTaken[] = [];
    const { repository, owner, builder, dashboard } = await world((seat) => void seats.push(seat));
    const { room, admissions } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.instance.id] });
    expect(admissions).toEqual([{ instance_id: builder.instance.id, status: "member", decision_id: null }]);
    expect(seats).toEqual([
      { room_id: room.id, room_kind: "standard", instance_id: dashboard.instanceId, principal_id: owner.principalId, by_principal_id: owner.principalId },
      { room_id: room.id, room_kind: "standard", instance_id: builder.instance.id, principal_id: owner.principalId, by_principal_id: owner.principalId },
    ]);
  });

  it("the agent joins by itself: its own Principal's word, and told once however often it joins", async () => {
    const seats: SeatTaken[] = [];
    const { repository, owner, builder, builderAuth, dashboard } = await world((seat) => void seats.push(seat));
    const { room } = await repository.createRoom(dashboard, { name: "Open floor" });
    seats.length = 0;
    await repository.joinRoom(builderAuth, room.id);
    await repository.joinRoom(builderAuth, room.id);
    expect(seats).toEqual([{ room_id: room.id, room_kind: "standard", instance_id: builder.instance.id, principal_id: owner.principalId, by_principal_id: owner.principalId }]);
  });

  it("the owner adds the agent to a Room later: the owner's word", async () => {
    const seats: SeatTaken[] = [];
    const { repository, owner, builder, dashboard } = await world((seat) => void seats.push(seat));
    const { room } = await repository.createRoom(dashboard, { name: "Later" });
    seats.length = 0;
    await repository.addRoomMembers(dashboard, room.id, { with: [builder.instance.id] });
    expect(seats).toEqual([{ room_id: room.id, room_kind: "standard", instance_id: builder.instance.id, principal_id: owner.principalId, by_principal_id: owner.principalId }]);
  });

  it("a stranger seats the public agent in a Room of theirs: seated, told, and the stranger's word, not the owner's", async () => {
    const seats: SeatTaken[] = [];
    const { repository, owner, stranger, builder, strangerAuth } = await world((seat) => void seats.push(seat));
    const { room, admissions } = await repository.createRoom(strangerAuth, { name: "Sam's Room", with: [builder.instance.id] });
    expect(admissions[0]!.status).toBe("member");
    const told = seats.find((seat) => seat.instance_id === builder.instance.id)!;
    expect(told).toEqual({ room_id: room.id, room_kind: "standard", instance_id: builder.instance.id, principal_id: owner.principalId, by_principal_id: stranger.principalId });
  });

  it("a private agent is seated on its own acceptance: the request was the stranger's, the seat is the owner's word", async () => {
    const seats: SeatTaken[] = [];
    const { repository, owner, strangerAuth } = await world((seat) => void seats.push(seat));
    const reviewer = await repository.startInstance(owner, { runtime_kind: "sharedos", cli_version: "sharedos", agent_id: null, runtime_metadata: { machine: "demo", handle: "reviewer" }, reach: "private" });
    const reviewerAuth = (await repository.authenticateInstance(reviewer.token))!;
    const { room, admissions } = await repository.createRoom(strangerAuth, { name: "Sam's Room", with: [reviewer.instance.id] });
    expect(admissions[0]!.status).toBe("pending");
    expect(seats.map((seat) => seat.instance_id)).not.toContain(reviewer.instance.id);
    await repository.resolveDecision(reviewerAuth, admissions[0]!.decision_id!, { resolution: "approved" });
    expect(seats.at(-1)).toEqual({ room_id: room.id, room_kind: "standard", instance_id: reviewer.instance.id, principal_id: owner.principalId, by_principal_id: owner.principalId });
  });

  it("the direct Room a seat is born with is told as such", async () => {
    const seats: SeatTaken[] = [];
    const { repository, builder, dashboard } = await world((seat) => void seats.push(seat));
    const { room } = await repository.createRoom(dashboard, { name: "builder · direct", kind: "direct", with: [builder.instance.id] });
    expect(room.kind).toBe("direct");
    expect(seats.find((seat) => seat.instance_id === builder.instance.id)?.room_kind).toBe("direct");
  });

  it("an observer that throws is said in the log and the seat stands", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { repository, builder, dashboard } = await world(() => {
      throw new Error("the console is down");
    });
    const { room, admissions } = await repository.createRoom(dashboard, { name: "To-do", with: [builder.instance.id] });
    expect(admissions[0]!.status).toBe("member");
    const view = await repository.getRoomForPrincipal(dashboard.principalId, room.id);
    expect(view.memberships.map((member) => member.instance_id)).toContain(builder.instance.id);
    expect(error.mock.calls.some((call) => String(call[0]).includes("was taken but not told") && call[1] === "the console is down")).toBe(true);
    error.mockRestore();
  });
});
