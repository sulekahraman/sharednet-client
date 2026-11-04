import { describe, expect, it } from "vitest";

import { handleRequest } from "./handler.ts";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import { RepositoryError } from "./repository.ts";

const OWNER = `snk_${"o".repeat(43)}`;
const STRANGER = `snk_${"s".repeat(43)}`;

function makeStore() {
  return new MemorySharedNetRepository({
    accounts: [
      { authUserId: "owner", apiKey: OWNER },
      { authUserId: "stranger", apiKey: STRANGER },
    ],
  });
}

function request(store: MemorySharedNetRepository, path: string, init: RequestInit = {}) {
  return handleRequest(new Request(`http://127.0.0.1:3001${path}`, init), store);
}

async function start(store: MemorySharedNetRepository, key: string, body: Record<string, unknown> = {}) {
  const response = await request(store, "/api/v1/instances", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ runtime_kind: "custom", cli_version: "0.1.3", ...body }),
  });
  expect(response.status).toBe(201);
  const { instance, token } = (await response.json()) as { instance: { id: string }; token: string };
  return { id: instance.id, token };
}

function post(store: MemorySharedNetRepository, path: string, token: string, body?: unknown) {
  return request(store, path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof RepositoryError) return error.code;
    throw error;
  }
  return "no refusal";
}

describe("direct Rooms: a person's private line to their own Agents", () => {
  it("opens with kind direct, seats the owner's Instances and refuses anyone else's, however public", async () => {
    const store = makeStore();
    const console_ = await start(store, OWNER);
    const agent = await start(store, OWNER);
    const foreign = await start(store, STRANGER, { reach: "public" });

    const created = await post(store, "/api/v1/rooms", console_.token, {
      name: "Me and my agent",
      kind: "direct",
      with: [agent.id, foreign.id],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      room: { id: string; kind: string };
      admissions: { instance_id: string; status: string }[];
    };
    expect(body.room.kind).toBe("direct");
    expect(body.admissions).toEqual([
      { instance_id: agent.id, status: "member", decision_id: null },
      { instance_id: foreign.id, status: "refused", decision_id: null },
    ]);

    // Knowing the Room id does not open it to another Principal.
    const walkedIn = await post(store, `/api/v1/rooms/${body.room.id}/join`, foreign.token, {});
    expect(walkedIn.status).toBe(403);
    expect(((await walkedIn.json()) as { error: { code: string } }).error.code).toBe("room_direct");

    // A later add is refused the same way, and asks nobody.
    const added = await post(store, `/api/v1/rooms/${body.room.id}/members`, agent.token, { with: [foreign.id] });
    expect(((await added.json()) as { admissions: { status: string }[] }).admissions[0]?.status).toBe("refused");

    // The owner's other Instances still join by id.
    const second = await start(store, OWNER);
    expect((await post(store, `/api/v1/rooms/${body.room.id}/join`, second.token, {})).status).toBe(200);
  });

  it("is never invited to and never published", async () => {
    const store = makeStore();
    const console_ = await start(store, OWNER);
    const auth = (await store.authenticateInstance(console_.token))!;
    const { room } = await store.createRoom(auth, { name: "Private line", kind: "direct" });

    expect(await refusal(store.createRoomInvite({ roomId: room.id, principalId: auth.principalId }))).toBe("room_direct");
    expect(await refusal(store.shareRoom(auth.principalId, room.id))).toBe("room_direct");
    const viaApi = await request(store, `/api/v1/rooms/${room.id}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${console_.token}` },
    });
    expect(viaApi.status).toBe(403);
  });

  it("stays open, with its Agent in it, until that Agent has ended", async () => {
    const store = makeStore();
    const console_ = await start(store, OWNER);
    const agent = await start(store, OWNER);
    const dashboard = await start(store, OWNER);
    const auth = (await store.authenticateInstance(console_.token))!;
    const { room } = await store.createRoom(auth, { name: "planner · direct", kind: "direct", with: [agent.id as never] });
    // The person's own seat walks in by id; it is not the Agent the Room was opened with.
    expect((await post(store, `/api/v1/rooms/${room.id}/join`, dashboard.token, {})).status).toBe(200);

    // A closed Room never reopens, so neither door is open while the Agent sits there.
    expect(await refusal(store.closeRoom(auth.principalId, room.id))).toBe("room_direct_seated");
    expect(await refusal(store.removeRoomMember(auth.principalId, room.id, agent.id as never))).toBe("room_direct_seated");
    expect((await store.removeRoomMember(auth.principalId, room.id, dashboard.id as never)).membership.state).toBe("left");

    // Removing the Agent in SharedOS Cloud ends its Instance, which leaves the Room.
    await store.endInstance((await store.authenticateInstance(agent.token))!);
    expect((await store.closeRoom(auth.principalId, room.id)).room.state).toBe("closed");

    // An ordinary Room closes whoever is in it.
    const open = await store.createRoom(auth, { name: "Open floor", with: [dashboard.id as never] });
    expect((await store.closeRoom(auth.principalId, open.room.id)).room.state).toBe("closed");
  });

  it("leaves ordinary Rooms as they were, and takes the kind only when the Room opens", async () => {
    const store = makeStore();
    const console_ = await start(store, OWNER);
    const foreign = await start(store, STRANGER);

    const created = await post(store, "/api/v1/rooms", console_.token, { name: "Open floor" });
    const { room } = (await created.json()) as { room: { id: string; kind: string } };
    expect(room.kind).toBe("standard");
    expect((await post(store, `/api/v1/rooms/${room.id}/join`, foreign.token, {})).status).toBe(200);

    const unknown = await post(store, "/api/v1/rooms", console_.token, { name: "Odd", kind: "secret" });
    expect(unknown.status).toBe(422);
  });
});
