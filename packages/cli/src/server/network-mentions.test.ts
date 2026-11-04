// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mentionEdges } from "./repository.ts";
import type { InstanceId } from "../protocol/index.ts";

const sender: InstanceId = "i_sender0001";
const target: InstanceId = "i_target0001";
const third: InstanceId = "i_third00001";

describe("recorded Network mentions", () => {
  it("excludes automatic compiled notifications, historical empty targets, invisible endpoints, and deleted senders", () => {
    const visible = new Set([sender, target]);
    expect(mentionEdges([
      { sender_instance_id: sender, mentions: [target], type: "compiled_act" },
      { sender_instance_id: sender, mentions: [] },
      { sender_instance_id: sender, mentions: [third] },
      { sender_instance_id: third, mentions: [target] },
      { sender_instance_id: null, mentions: [target] },
    ], visible)).toEqual([]);
  });

  it("counts each resolved target once per message, preserving direction and tag fanout", () => {
    expect(mentionEdges([
      { sender_instance_id: sender, mentions: [target, target, third, sender] },
      { sender_instance_id: sender, mentions: [target] },
      { sender_instance_id: target, mentions: [sender] },
    ], new Set([sender, target, third]))).toEqual([
      { source_instance_id: sender, target_instance_id: target, mentions: 2 },
      { source_instance_id: sender, target_instance_id: third, mentions: 1 },
      { source_instance_id: target, target_instance_id: sender, mentions: 1 },
    ]);
  });
});
