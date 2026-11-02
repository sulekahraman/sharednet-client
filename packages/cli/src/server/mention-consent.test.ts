// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import { DEFAULT_MESSAGE_QUERY, type InstanceId, type RoomId } from "../protocol/index.ts";

async function fixture(options: { mentionConsent?: boolean } = {}) {
  const repo = new MemorySharedNetRepository({
    accounts: [{ authUserId: "user-ada", apiKey: "key-ada" }, { authUserId: "user-bo", apiKey: "key-bo" }],
    ...options,
  });
  const ada = (await repo.authenticateApiKey("key-ada"))!;
  const bo = (await repo.authenticateApiKey("key-bo"))!;
  const adaAgent = await repo.startInstance(ada, { runtime_kind: "codex", cli_version: "test" });
  const boAgent = await repo.startInstance(bo, { runtime_kind: "codex", cli_version: "test" });
  const adaAuth = (await repo.authenticateInstance(adaAgent.token))!;
  const boAuth = (await repo.authenticateInstance(boAgent.token))!;
  const { room } = await repo.createRoom(adaAuth, { name: "consent" });
  await repo.joinRoom(boAuth, room.id);
  return { repo, ada, bo, adaAuth, boAuth, boAgent: boAgent.instance.id, room: room.id };
}

/** What `wait --on mention` and `serve` read: only lines whose resolved mentions include the seat. */
async function addressedTo(repo: MemorySharedNetRepository, auth: Parameters<MemorySharedNetRepository["listMessages"]>[0], room: RoomId, seat: InstanceId) {
  return (await repo.listMessages(auth, room, { ...DEFAULT_MESSAGE_QUERY, mentions: seat })).items;
}

describe("mention consent: an @ from another Principal waits for the target's owner", () => {
  it("holds the line from the target and asks its owner, then releases a short pointer on approval", async () => {
    const { repo, bo, adaAuth, boAuth, boAgent, room } = await fixture();
    const sourceText = `@${boAgent} please review: ${"private source details. ".repeat(100)}`;
    const { message } = await repo.postMessage(adaAuth, room, { content: sourceText });
    expect(message.mentions).toEqual([]);
    expect(await addressedTo(repo, boAuth, room, boAgent)).toEqual([]);

    const pending = (await repo.listDecisionsForPrincipal(bo.principalId)).decisions.map((item) => item.decision);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "pending", requested_for_instance_id: boAgent, room_id: room });
    expect(pending[0]!.contact).toMatchObject({ action: "mention", source_message_id: message.id, effect_state: "pending" });

    const resolved = await repo.resolveDecisionForPrincipal(bo.principalId, pending[0]!.id, { outcome: "approved" });
    expect(resolved.decision.decision.contact?.effect_state).toBe("approved");
    const woken = await addressedTo(repo, boAuth, room, boAgent);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      content: `✅ approved by owner — @${boAgent} see #${message.sequence}`,
      reply_to_message_id: message.id,
      sender_principal_id: adaAuth.principalId,
      sender_instance_id: adaAuth.instanceId,
      mentions: [boAgent],
    });
    expect(woken[0]!.content).not.toContain("private source details");
    // Approving again changes nothing and says nothing twice.
    await repo.resolveDecisionForPrincipal(bo.principalId, pending[0]!.id, { outcome: "approved" });
    expect(await addressedTo(repo, boAuth, room, boAgent)).toHaveLength(1);
  });

  it("releases only the approved target and emits one pointer for duplicate approval calls", async () => {
    const { repo, bo, adaAuth, boAuth, boAgent, room } = await fixture();
    const sibling = await repo.startInstance(bo, { runtime_kind: "claude-code", cli_version: "test" });
    const siblingAuth = (await repo.authenticateInstance(sibling.token))!;
    await repo.joinRoom(siblingAuth, room);
    const { message } = await repo.postMessage(adaAuth, room, { content: `@${boAgent} @${sibling.instance.id} private review` });
    expect(message.mentions).toEqual([]);
    const requests = (await repo.listDecisionsForPrincipal(bo.principalId)).decisions;
    expect(requests).toHaveLength(2);
    const request = requests.find(({ decision }) => decision.contact?.target_instance_id === boAgent)!;
    await Promise.all([
      repo.resolveDecisionForPrincipal(bo.principalId, request.decision.id, { outcome: "approved" }),
      repo.resolveDecisionForPrincipal(bo.principalId, request.decision.id, { outcome: "approved" }),
    ]);
    const woken = await addressedTo(repo, boAuth, room, boAgent);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      content: `✅ approved by owner — @${boAgent} see #${message.sequence}`,
      reply_to_message_id: message.id,
      mentions: [boAgent],
    });
    expect(woken[0]!.content).not.toContain(sibling.instance.id);
    expect(await addressedTo(repo, siblingAuth, room, sibling.instance.id)).toEqual([]);
    expect((await repo.listDecisionsForPrincipal(bo.principalId)).decisions.find(({ decision }) => decision.contact?.target_instance_id === sibling.instance.id)!.decision.status).toBe("pending");
  });

  it("says nothing on a denial", async () => {
    const { repo, bo, adaAuth, boAuth, boAgent, room } = await fixture();
    await repo.postMessage(adaAuth, room, { content: `@${boAgent} please review` });
    const [request] = (await repo.listDecisionsForPrincipal(bo.principalId)).decisions;
    await repo.resolveDecisionForPrincipal(bo.principalId, request!.decision.id, { outcome: "denied" });
    expect(await addressedTo(repo, boAuth, room, boAgent)).toEqual([]);
  });

  it("stops asking once the owner always allows the sender's Principal", async () => {
    const { repo, bo, adaAuth, boAuth, boAgent, room } = await fixture();
    const { message: held } = await repo.postMessage(adaAuth, room, { content: `@${boAgent} first` });
    const [request] = (await repo.listDecisionsForPrincipal(bo.principalId)).decisions;
    await repo.resolveDecisionForPrincipal(bo.principalId, request!.decision.id, { outcome: "approved", scope: "source_principal_action" });
    const { message } = await repo.postMessage(adaAuth, room, { content: `@${boAgent} second` });
    expect(message.mentions).toEqual([boAgent]);
    expect((await repo.listDecisionsForPrincipal(bo.principalId)).decisions).toHaveLength(1);
    expect((await addressedTo(repo, boAuth, room, boAgent)).map((line) => line.content)).toEqual([
      `✅ approved by owner — @${boAgent} see #${held.sequence}`,
      `@${boAgent} second`,
    ]);
  });

  it("leaves the same owner's agents and an invite's ownerless seats alone", async () => {
    const { repo, ada, adaAuth, boAuth, room } = await fixture();
    const sibling = await repo.startInstance(ada, { runtime_kind: "claude-code", cli_version: "test" });
    await repo.joinRoom((await repo.authenticateInstance(sibling.token))!, room);
    const { token: invite } = await repo.createRoomInvite({ roomId: room, principalId: ada.principalId });
    const guest = await repo.joinRoomWithInvite(invite, room, { name: "guest" });
    const { message } = await repo.postMessage(boAuth, room, { content: `@${sibling.instance.id} @guest hello` });
    // The sibling is Ada's, asked by Bo: held. The guest has no owner to ask: addressed.
    expect(message.mentions).toEqual([guest.membership.instance_id]);
    const { message: own } = await repo.postMessage(adaAuth, room, { content: `@${sibling.instance.id} hello` });
    expect(own.mentions).toEqual([sibling.instance.id]);
  });

  it("can be switched off", async () => {
    const { repo, bo, adaAuth, boAgent, room } = await fixture({ mentionConsent: false });
    const { message } = await repo.postMessage(adaAuth, room, { content: `@${boAgent} please review` });
    expect(message.mentions).toEqual([boAgent]);
    expect((await repo.listDecisionsForPrincipal(bo.principalId)).decisions).toEqual([]);
  });
});
