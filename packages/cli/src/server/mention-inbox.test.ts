// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemorySharedNetRepository } from "./memory-repository.ts";

async function seeded() {
  const repository = new MemorySharedNetRepository({ accounts: [{ authUserId: "a", apiKey: "key-a" }, { authUserId: "b", apiKey: "key-b" }] });
  const principal = (await repository.authenticateApiKey("key-a"))!;
  const started = await repository.startInstance(principal, { runtime_kind: "codex", cli_version: "test" });
  const auth = (await repository.authenticateInstance(started.token))!;
  const { room } = await repository.createRoom(auth, { name: "Inbox", description: null });
  const { message: human } = await repository.postAsPerson("a", room.id, { content: "Hello" }, { name: "Ada" });
  const { message } = await repository.postMessage(auth, room.id, { content: `@${human.sender_instance_id} need your answer` });
  return { repository, principal, auth, room, human, message };
}

describe("human mention inbox", () => {
  it("includes own agents addressing the human, excludes prose and agent-only mentions, and scopes reads and actions", async () => {
    const { repository, auth, room, human, message } = await seeded();
    await repository.postMessage(auth, room.id, { content: "Ada please answer" });
    await repository.postAsPerson("a", room.id, { content: `@${auth.instanceId} agent question` });
    expect(await repository.listMentionsForAccount("a")).toMatchObject({ pending_count: 1, items: [{ message_id: message.id, status: "pending" }] });
    expect(await repository.listMentionsForAccount("b")).toEqual({ pending_count: 0, items: [] });
    await expect(repository.resolveMentionForAccount("b", message.id, { action: "done" })).rejects.toMatchObject({ status: 404 });
    expect(human.sender_instance_id).not.toBe(auth.instanceId);
  });

  it("serializes concurrent quick replies, persists one linked human reply, and returns it on retry", async () => {
    const { repository, room, human, message } = await seeded();
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.resolveMentionForAccount("a", message.id, { action: "reply", content: "Approved" })));
    expect(new Set(results.map((r) => r.message?.id)).size).toBe(1);
    expect(results[0]).toMatchObject({ item: { status: "replied", reply_message_id: results[0]!.message!.id }, message: { room_id: room.id, sender_instance_id: human.sender_instance_id, reply_to_message_id: message.id, mentions: [message.sender_instance_id] } });
    expect((await repository.listMentionsForAccount("a")).pending_count).toBe(0);
    const detail = await repository.getRoomForPrincipal((await repository.principalForAccount("a"))!.id, room.id);
    expect(detail.messages.filter((m) => m.reply_to_message_id === message.id)).toHaveLength(1);
  });

  it("keeps a failed reply pending and makes done idempotent", async () => {
    const { repository, principal, room, message } = await seeded();
    await repository.closeRoom(principal.principalId, room.id);
    await expect(repository.resolveMentionForAccount("a", message.id, { action: "reply", content: "Yes" })).rejects.toMatchObject({ status: 409 });
    expect((await repository.listMentionsForAccount("a")).pending_count).toBe(1);
    await repository.resolveMentionForAccount("a", message.id, { action: "done" });
    expect(await repository.resolveMentionForAccount("a", message.id, { action: "done" })).toMatchObject({ item: { status: "done", reply_message_id: null } });
  });
  it("accepts human-to-human mentions but excludes hook events and resolves full chat replies", async () => {
    const { repository, principal, room, human, message } = await seeded();
    const b = (await repository.authenticateApiKey("key-b"))!;
    const seat = await repository.startInstance(b, { runtime_kind: "codex", cli_version: "test" });
    const auth = (await repository.authenticateInstance(seat.token))!;
    await repository.joinRoom(auth, room.id, {});
    await repository.postAsPerson("b", room.id, { content: `@${human.sender_instance_id} human question` });
    const { token } = await repository.createRoomHook(principal.principalId, room.id, { name: "ci" });
    const hook = (await repository.authenticateHook(token, room.id))!;
    await repository.postMessage(hook.auth, room.id, { content: `@${human.sender_instance_id} hook event` });
    expect((await repository.listMentionsForAccount("a")).pending_count).toBe(2);
    const { message: reply } = await repository.postAsPerson("a", room.id, { content: "Answer in chat", reply_to_message_id: message.id });
    expect((await repository.listMentionsForAccount("a")).items.find((i) => i.message_id === message.id)).toMatchObject({ status: "replied", reply_message_id: reply.id });
  });

  it("revokes inbox access when the last active membership in a foreign Room is removed", async () => {
    const { repository, auth, human } = await seeded();
    const b = (await repository.authenticateApiKey("key-b"))!;
    const seat = await repository.startInstance(b, { runtime_kind: "codex", cli_version: "test" });
    const bAuth = (await repository.authenticateInstance(seat.token))!;
    const { room } = await repository.createRoom(bAuth, { name: "Private", description: null });
    await repository.joinRoom(auth, room.id, {});
    await repository.postAsPerson("a", room.id, { content: "Present" });
    const { message } = await repository.postMessage(bAuth, room.id, { content: `@${human.sender_instance_id} private question` });
    expect((await repository.listMentionsForAccount("a")).items.some(i => i.message_id === message.id)).toBe(true);
    await repository.removeRoomMember(b.principalId, room.id, auth.instanceId);
    await repository.removeRoomMember(b.principalId, room.id, human.sender_instance_id);
    expect((await repository.listMentionsForAccount("a")).items.some(i => i.message_id === message.id)).toBe(false);
    await expect(repository.resolveMentionForAccount("a", message.id, { action: "reply", content: "No access" })).rejects.toMatchObject({ status: 404 });
  });

});
