import { describe, expect, it } from "vitest";
import { Room } from "./room.ts";
import { toCanonicalEvent } from "./envelope.ts";
import { renderObligations } from "./obligations.ts";

describe("personal obligations follow admitted work", () => {
  const setup = () => {
    const room = new Room(["A", "B", "C", "D"]);
    const act = (actor: string, envelope: unknown) => {
      const outcome = room.ingest(toCanonicalEvent(actor, envelope, room.projection));
      expect(outcome.accepted).toBe(true);
    };
    act("A", { type: "work.request", work_id: "W1", to: "B", requires: [{ kind: "deliverables", names: ["patch"] }, { kind: "verified_by", verifier: "C" }] });
    return { room, act };
  };

  it("tells only the addressed actor to accept or decline", () => {
    const { room } = setup();
    expect(renderObligations(room.projection, "B")).toMatch(/W1.*work.accept.*work.decline/);
    expect(renderObligations(room.projection, "D")).toBe("No outstanding obligations.");
    expect(renderObligations(room.projection, "A")).not.toContain("work.accept");
  });

  it("lists the responsible actor's deliverables after acceptance", () => {
    const { room, act } = setup();
    act("B", { type: "work.accept", work_id: "W1" });
    expect(renderObligations(room.projection, "B")).toMatch(/W1.*work.result.*patch/);
    expect(renderObligations(room.projection, "C")).not.toContain("verification.pass");
    expect(renderObligations(room.projection, "C")).toMatch(/WAITING ON OTHERS.*B/);
  });

  it("binds review instructions to the result and hides them after voting", () => {
    const { room, act } = setup();
    act("B", { type: "work.accept", work_id: "W1" });
    act("B", { type: "work.result", work_id: "W1", artifacts: { patch: "art_patch" } });
    const review = renderObligations(room.projection, "C");
    expect(review).toContain("verification.pass");
    expect(review).toContain("verification.fail");
    expect(review).toContain("verify:C");
    expect(review).toContain(room.projection.work.W1!.result);
    expect(review).toContain("evidence");
    expect(renderObligations(room.projection, "B")).toMatch(/WAITING ON OTHERS.*C/);
    expect(renderObligations(room.projection, "A")).toMatch(/blocked.*verify:C/);
    act("C", { type: "verification.pass", work_id: "W1", evidence: "art_report" });
    expect(renderObligations(room.projection, "C")).not.toContain("verification.pass");
    expect(renderObligations(room.projection, "A")).toContain("work.resolve");
    act("A", { type: "work.resolve", work_id: "W1" });
    expect(renderObligations(room.projection, "A")).toBe("No outstanding obligations.");
    expect(renderObligations(room.projection, "B")).toBe("No outstanding obligations.");
  });

  it("renders human review and avoids prompting a quorum voter twice", () => {
    const room = new Room(["A", "B", "C", "D"]);
    const act = (actor: string, envelope: unknown) => room.ingest(toCanonicalEvent(actor, envelope, room.projection));
    act("A", { type: "work.request", work_id: "W1", to: "B", requires: [{ kind: "human_review", scope: ["A"] }, { kind: "quorum", eligible: ["C", "D"], q: 2 }] });
    act("B", { type: "work.accept", work_id: "W1" });
    act("B", { type: "work.result", work_id: "W1" });
    expect(renderObligations(room.projection, "A")).toContain("human.approve");
    act("C", { type: "verification.pass", work_id: "W1", requirement: "quorum#1", evidence: "report" });
    expect(renderObligations(room.projection, "C")).not.toContain("verification.pass");
    expect(renderObligations(room.projection, "D")).toContain("quorum#1");
  });
});
