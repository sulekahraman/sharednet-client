// @vitest-environment node

import { describe, expect, it } from "vitest";

import type {
  Agent,
  AgentId,
  Instance,
  InstanceId,
  PrincipalId,
} from "../protocol/index.ts";
import type { InstanceDirectorySnapshot } from "./repository.ts";
import { projectInstanceDirectory } from "./instance-directory.ts";

const PRINCIPAL = "p_Owner000001" as PrincipalId;
const OTHER = "p_Other000001" as PrincipalId;
const NOW = "2026-10-19T08:00:00.000Z";

function agent(id: string, handle: string, displayName: string | null = null): Agent {
  return {
    id: id as AgentId,
    principal_id: PRINCIPAL,
    handle,
    display_name: displayName,
    description: null,
    created_at: "2026-10-01T00:00:00.000Z",
  };
}

function instance(
  id: string,
  options: Partial<Instance> & Pick<Instance, "status" | "last_seen_at">,
): Instance {
  return {
    id: id as InstanceId,
    principal_id: PRINCIPAL,
    agent_id: null,
    runtime_kind: "codex",
    cli_version: "0.1.16",
    runtime_metadata: { hostname: "must-not-leak" },
    reach: "private",
    display_name: null,
    started_at: options.last_seen_at,
    lease_expires_at: "2026-10-19T08:02:00.000Z",
    token_expires_at: "2026-11-01T00:00:00.000Z",
    ended_at: null,
    revoked_at: null,
    ...options,
  };
}

function snapshot(instances: Instance[], agents: Agent[] = []): InstanceDirectorySnapshot {
  return {
    sampled_at: NOW,
    agents,
    instances,
    active: [],
  };
}

describe("owned Instance directory projection", () => {
  it("returns only the caller's non-revoked Instances in latest-seen order", () => {
    const own = instance("i_OwnLatest01", {
      status: "online",
      last_seen_at: "2026-10-19T07:59:30.000Z",
    });
    const older = instance("i_OwnOlder001", {
      status: "offline",
      last_seen_at: "2026-10-19T05:00:00.000Z",
    });
    const foreign = instance("i_Foreign0001", {
      principal_id: OTHER,
      status: "online",
      last_seen_at: "2026-10-19T08:00:00.000Z",
    });
    const revoked = instance("i_Revoked0001", {
      status: "revoked",
      revoked_at: "2026-10-19T07:30:00.000Z",
      last_seen_at: "2026-10-19T07:30:00.000Z",
    });

    const result = projectInstanceDirectory(snapshot([older, foreign, revoked, own]), PRINCIPAL);

    expect(result.instances.map(({ instance_id }) => instance_id)).toEqual([own.id, older.id]);
    expect(result.instances[0]).toEqual({
      instance_id: own.id,
      name: "codex",
      agent: null,
      driver: "codex",
      state: "online",
      detail: "listening",
      last_seen_at: own.last_seen_at,
    });
    expect(result.instances[1]?.detail).toBe("last seen 3h ago");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("uses the driven-turn heartbeat lease as working truth and resolves public names", () => {
    const tagged = agent("a_Planner0001", "planner", "Planner");
    const active = instance("i_Working0001", {
      agent_id: tagged.id,
      status: "online",
      last_seen_at: "2026-10-19T07:59:55.000Z",
    });
    const view = snapshot([active], [tagged]);
    view.active = [{ instance_id: active.id, room_name: "Launch Project" }];

    const result = projectInstanceDirectory(view, PRINCIPAL);

    expect(result.instances).toEqual([
      {
        instance_id: active.id,
        name: "Planner",
        agent: { agent_id: tagged.id, name: "Planner" },
        driver: "codex",
        state: "working",
        detail: "replying in Launch Project",
        last_seen_at: active.last_seen_at,
      },
    ]);
  });

  it("does not call an ended Instance working even if a stale reply projection remains", () => {
    const ended = instance("i_Ended000001", {
      status: "ended",
      ended_at: "2026-10-19T07:55:00.000Z",
      last_seen_at: "2026-10-19T07:55:00.000Z",
    });
    const view = snapshot([ended]);
    view.active = [{ instance_id: ended.id, room_name: "Project" }];

    expect(projectInstanceDirectory(view, PRINCIPAL))
      .toEqual({
        instances: [expect.objectContaining({ state: "offline", detail: "ended" })],
      });
  });
});
