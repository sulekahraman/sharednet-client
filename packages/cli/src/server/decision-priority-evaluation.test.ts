// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import type { PrincipalId } from "../protocol/index.ts";

async function fixture(protectedContact = false) {
  let clock = new Date("2026-10-15T12:00:00Z");
  const protectedIds: PrincipalId[] = [];
  const repo = new MemorySharedNetRepository({ devApiKeys: ["a", "b"], contactPrincipals: protectedIds, now: () => clock });
  const a = (await repo.authenticateApiKey("a"))!, b = (await repo.authenticateApiKey("b"))!;
  if (protectedContact) protectedIds.push(b.principalId);
  const source = await repo.startInstance(a, { runtime_kind: "codex", cli_version: "test" });
  const target = await repo.startInstance(b, { runtime_kind: "codex", cli_version: "test", reach: "private" });
  const sa = (await repo.authenticateInstance(source.token))!;
  const { room, admissions } = await repo.createRoom(sa, { name: "Priority", with: [target.instance.id] });
  return { repo, a, b, sa, target, room, id: admissions[0].decision_id!, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
}
const assessment = { priority: "p1" as const, reason: "Owner approval blocks a delivery.", confidence: 0.85, provider: "test", model: "test-model", rubricVersion: "v1", inputDigest: "a".repeat(64) };

describe("Decision priority evaluation", () => {
  it.each([false, true])("enqueues new invitations once and leaves duplicate requests alone (protected=%s)", async (protectedContact) => {
    const { repo, sa, target, room, id, b } = await fixture(protectedContact);
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions[0]).toMatchObject({ priority_source: "pending", priority_evaluation: { status: "pending" } });
    expect((await repo.addRoomMembers(sa, room.id, { with: [target.instance.id] })).admissions[0].decision_id).toBe(id);
    const claim = (await repo.claimDecisionPriorityEvaluation())!;
    expect(claim).toMatchObject({ decision: { id }, attempts: 1 });
    expect(await repo.claimDecisionPriorityEvaluation()).toBeNull();
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions[0].priority_evaluation.status).toBe("processing");
  });

  it("enqueues mention consent Decisions separately from the completed invitation", async () => {
    const { repo, b, id, sa, target, room } = await fixture(true);
    const first = (await repo.claimDecisionPriorityEvaluation())!;
    await repo.completeDecisionPriorityEvaluation(id, first.leaseToken, assessment);
    await repo.resolveDecisionForPrincipal(b.principalId, id, { outcome: "approved" });
    await repo.postMessage(sa, room.id, { content: `@${target.instance.id} please respond` });
    const claim = (await repo.claimDecisionPriorityEvaluation())!;
    expect(claim.decision.contact?.action).toBe("mention");
    expect(claim.decision.id).not.toBe(id);
    expect(await repo.claimDecisionPriorityEvaluation()).toBeNull();
  });

  it("assigns resolved Decisions and exposes only public assessment metadata", async () => {
    const { repo, b, id } = await fixture();
    const claim = (await repo.claimDecisionPriorityEvaluation())!;
    await repo.resolveDecisionForPrincipal(b.principalId, id, { outcome: "denied" });
    expect(await repo.completeDecisionPriorityEvaluation(id, claim.leaseToken, assessment)).toBe(true);
    const overview = (await repo.listDecisionsForPrincipal(b.principalId)).decisions[0];
    expect(overview).toMatchObject({ decision: { priority: "p1", status: "denied" }, priority_source: "model", priority_evaluation: { status: "assigned", reason: assessment.reason, confidence: 0.85, model: "test-model", assessed_at: "2026-10-15T12:00:00.000Z" } });
    expect(Object.keys(overview.priority_evaluation).sort()).toEqual(["assessed_at", "confidence", "model", "reason", "status"]);
    expect(await repo.completeDecisionPriorityEvaluation(id, claim.leaseToken, assessment)).toBe(false);
  });

  it("keeps an owner override when an already claimed assessment completes or fails", async () => {
    const { repo, b, id } = await fixture();
    const claim = (await repo.claimDecisionPriorityEvaluation())!;
    await repo.reprioritizeDecisionForPrincipal(b.principalId, id, "p4");
    expect(await repo.completeDecisionPriorityEvaluation(id, claim.leaseToken, assessment)).toBe(false);
    expect(await repo.failDecisionPriorityEvaluation(id, claim.leaseToken, "timeout")).toBe(false);
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions[0]).toMatchObject({ decision: { priority: "p4" }, priority_source: "owner", priority_evaluation: { status: "overridden" } });
    expect(await repo.claimDecisionPriorityEvaluation()).toBeNull();
  });

  it("recovers expired leases and rejects the old worker's result", async () => {
    const { repo, id, advance } = await fixture();
    const first = (await repo.claimDecisionPriorityEvaluation({ leaseMs: 1000 }))!;
    advance(1000);
    const recovered = (await repo.claimDecisionPriorityEvaluation({ leaseMs: 1000 }))!;
    expect(recovered.attempts).toBe(2);
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    expect(await repo.completeDecisionPriorityEvaluation(id, first.leaseToken, assessment)).toBe(false);
    expect(await repo.completeDecisionPriorityEvaluation(id, recovered.leaseToken, assessment)).toBe(true);
  });

  it("backs off retryable failures and assigns p2 after three attempts", async () => {
    const { repo, id, b, advance } = await fixture();
    for (const delay of [30_000, 60_000, 0]) {
      const claim = (await repo.claimDecisionPriorityEvaluation())!;
      expect(await repo.failDecisionPriorityEvaluation(id, claim.leaseToken, "timeout")).toBe(true);
      expect(await repo.claimDecisionPriorityEvaluation()).toBeNull();
      advance(delay);
    }
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions[0]).toMatchObject({ decision: { priority: "p2" }, priority_source: "fallback", priority_evaluation: { status: "failed" } });
    expect(await repo.claimDecisionPriorityEvaluation()).toBeNull();
  });

  it("terminates repeatedly abandoned leases instead of looping forever", async () => {
    const { repo, b, advance } = await fixture();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await repo.claimDecisionPriorityEvaluation({ leaseMs: 1000 })).not.toBeNull();
      advance(1000);
    }
    expect(await repo.claimDecisionPriorityEvaluation()).toBeNull();
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions[0]).toMatchObject({ priority_source: "fallback", priority_evaluation: { status: "failed" } });
  });

  it("rejects malformed assessments without changing the priority or consuming the lease", async () => {
    const { repo, b, id } = await fixture();
    const claim = (await repo.claimDecisionPriorityEvaluation())!;
    for (const invalid of [{ ...assessment, confidence: Number.NaN }, { ...assessment, confidence: 1.1 }, { ...assessment, reason: " " }, { ...assessment, inputDigest: "raw input" }]) {
      await expect(repo.completeDecisionPriorityEvaluation(id, claim.leaseToken, invalid)).rejects.toThrow("Invalid Decision priority assessment");
    }
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions[0]).toMatchObject({ decision: { priority: "p2" }, priority_evaluation: { status: "processing" } });
    expect(await repo.completeDecisionPriorityEvaluation(id, claim.leaseToken, assessment)).toBe(true);
  });

  it("rejects an expired worker even before another worker reclaims the lease", async () => {
    const { repo, id, advance } = await fixture();
    const claim = (await repo.claimDecisionPriorityEvaluation({ leaseMs: 1000 }))!;
    advance(1000);
    expect(await repo.completeDecisionPriorityEvaluation(id, claim.leaseToken, assessment)).toBe(false);
    expect(await repo.failDecisionPriorityEvaluation(id, claim.leaseToken, "timeout")).toBe(false);
    expect((await repo.claimDecisionPriorityEvaluation())!.attempts).toBe(2);
  });
});
