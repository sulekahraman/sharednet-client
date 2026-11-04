// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import type { PrincipalId } from "../protocol/index.ts";
async function fixture() {
  const protectedIds: PrincipalId[] = [];
  const repo = new MemorySharedNetRepository({devApiKeys:["source", "target", "third"],contactPrincipals:protectedIds});
  const a = (await repo.authenticateApiKey("source"))!;
  const b = (await repo.authenticateApiKey("target"))!;
  const source = await repo.startInstance(a,{runtime_kind:"codex",cli_version:"test"});
  const target = await repo.startInstance(b,{runtime_kind:"codex",cli_version:"test"});
  const sa = (await repo.authenticateInstance(source.token))!;
  const ta = (await repo.authenticateInstance(target.token))!;
  protectedIds.push(b.principalId);
  return {repo,sa,ta,a,b,source,target};
}
describe("contact owner consent",()=>{
  it("gates public foreign targets, refuses agent resolution and bare joins",async()=>{
    const {repo,sa,ta,b,target}=await fixture();
    const {room,admissions}=await repo.createRoom(sa,{name:"contact",with:[target.instance.id]});
    expect(admissions[0].status).toBe("pending");
    const id=admissions[0].decision_id!;
    await expect(repo.resolveDecision(ta,id,{resolution:"approved"})).rejects.toMatchObject({code:"permission_denied"});
    await expect(repo.joinRoom(ta,room.id)).rejects.toMatchObject({code:"permission_denied"});
    const result=await repo.resolveDecisionForPrincipal(b.principalId,id,{outcome:"approved"});
    expect(result.decision.decision.contact?.effect_state).toBe("approved");
    expect(result.membership?.instance_id).toBe(target.instance.id);
  });
  it("late approval creates one independent wake, claim and complete replay safely",async()=>{
    const {repo,sa,ta,b,target}=await fixture();
    const {room,admissions}=await repo.createRoom(sa,{name:"contact",with:[target.instance.id]});
    await repo.resolveDecisionForPrincipal(b.principalId,admissions[0].decision_id!,{outcome:"approved"});
    const {message}=await repo.postMessage(sa,room.id,{content:`@${target.instance.id} hello`});
    expect((await repo.listContactWakes(ta,{after:null,limit:20})).items).toHaveLength(0);
    const request=(await repo.listDecisionsForPrincipal(b.principalId)).decisions.find(d=>d.decision.contact?.source_message_id===message.id)!;
    await repo.resolveDecisionForPrincipal(b.principalId,request.decision.id,{outcome:"approved",scope:"source_principal_action"});
    const {items}=await repo.listContactWakes(ta,{after:null,limit:20});
    expect(items).toHaveLength(1);
    const key="7f8bb5f1-3060-45ea-8c69-a40b88c74045";
    const claim=await repo.claimContactWake(ta,items[0].id,{execution_key:key});
    expect(await repo.claimContactWake(ta,items[0].id,{execution_key:key})).toEqual(claim);
    await expect(repo.claimContactWake(ta,items[0].id,{execution_key:"other"})).rejects.toMatchObject({code:"conflict"});
    const done=await repo.completeContactWake(ta,items[0].id,{execution_key:key,receipt:claim.receipt,outcome:"completed"});
    expect(done.wake.state).toBe("completed");
    expect(await repo.completeContactWake(ta,items[0].id,{execution_key:key,receipt:claim.receipt,outcome:"completed"})).toEqual(done);
    await repo.postMessage(sa,room.id,{content:`@${target.instance.id} again`});
    const next=(await repo.listContactWakes(ta,{after:items[0].cursor,limit:20})).items[0];
    const rule=(await repo.listContactRulesForPrincipal(b.principalId)).rules[0];
    await repo.revokeContactRuleForPrincipal(b.principalId,rule.id);
    await expect(repo.claimContactWake(ta,next.id,{execution_key:key})).rejects.toMatchObject({code:"permission_denied"});
  });
});

describe("contact policy boundaries",()=>{
  it("same owner bypasses consent and same-owner mentions yield authorized wakes",async()=>{
    const {repo,ta,b,target}=await fixture();
    const sibling=await repo.startInstance(b,{runtime_kind:"codex",cli_version:"test"});
    const {room,admissions}=await repo.createRoom(ta,{name:"same owner",with:[sibling.instance.id]});
    expect(admissions[0].status).toBe("member");
    const auth=(await repo.authenticateInstance(sibling.token))!;
    await repo.postMessage(ta,room.id,{content:"Owner message without a mention"});
    expect((await repo.listContactWakes(auth,{after:null,limit:10})).items).toHaveLength(0);
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions).toHaveLength(0);
    await repo.postMessage(ta,room.id,{content:`@${sibling.instance.id} hello`});
    expect((await repo.listContactWakes(auth,{after:null,limit:10})).items[0].authorization).toBe("same_principal");
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions).toHaveLength(0);
    expect(target.instance.principal_id).toBe(b.principalId);
  });
  it("Always applies to the source principal's siblings, not another action or source",async()=>{
    const {repo,sa,ta,a,b,target}=await fixture();
    await repo.updateInstance(ta,{reach:"private"});
    const first=await repo.createRoom(sa,{name:"first",with:[target.instance.id]});
    await repo.resolveDecisionForPrincipal(b.principalId,first.admissions[0].decision_id!,{outcome:"approved",scope:"source_principal_action"});
    const sibling=await repo.startInstance(a,{runtime_kind:"codex",cli_version:"test"});
    const siblingAuth=(await repo.authenticateInstance(sibling.token))!;
    const next=await repo.createRoom(siblingAuth,{name:"second",with:[target.instance.id]});
    expect(next.admissions[0].status).toBe("member");
    const {message}=await repo.postMessage(siblingAuth,next.room.id,{content:`@${target.instance.id} hello`});
    expect((await repo.listContactWakes(ta,{after:null,limit:10})).items).toHaveLength(0);
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions.some(d=>d.decision.contact?.source_message_id===message.id)).toBe(true);
    const rule=(await repo.listContactRulesForPrincipal(b.principalId)).rules[0];
    await expect(repo.revokeContactRuleForPrincipal(a.principalId,rule.id)).rejects.toMatchObject({status:404});
    await repo.revokeContactRuleForPrincipal(b.principalId,rule.id);
    expect((await repo.createRoom(sa,{name:"third",with:[target.instance.id]})).admissions[0].status).toBe("pending");
  });
  it("denial cannot be changed into a trust grant and closed-room approval has no effect",async()=>{
    const {repo,sa,a,b,target}=await fixture();
    const first=await repo.createRoom(sa,{name:"deny",with:[target.instance.id]});
    const id=first.admissions[0].decision_id!;
    await repo.resolveDecisionForPrincipal(b.principalId,id,{outcome:"denied"});
    await expect(repo.resolveDecisionForPrincipal(b.principalId,id,{outcome:"approved",scope:"source_principal_action"})).rejects.toMatchObject({code:"decision_already_resolved"});
    expect((await repo.listContactRulesForPrincipal(b.principalId)).rules).toHaveLength(0);
    const next=await repo.createRoom(sa,{name:"closed",with:[target.instance.id]});
    await repo.closeRoom(a.principalId,next.room.id);
    await expect(repo.resolveDecisionForPrincipal(b.principalId,next.admissions[0].decision_id!,{outcome:"approved"})).rejects.toMatchObject({code:"permission_denied"});
  });
  it("does not reuse another source's pending invitation",async()=>{
    const {repo,sa,b,target}=await fixture();
    const c=(await repo.authenticateApiKey("third"))!;
    const third=await repo.startInstance(c,{runtime_kind:"codex",cli_version:"test"});
    const thirdAuth=(await repo.authenticateInstance(third.token))!;
    const {room,admissions}=await repo.createRoom(sa,{name:"foreign",with:[target.instance.id,third.instance.id]});
    const other=await repo.addRoomMembers(thirdAuth,room.id,{with:[target.instance.id]});
    expect(other.admissions[0].decision_id).not.toBe(admissions[0].decision_id);
    expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions).toHaveLength(2);
  });
});


it("refuses a legacy agent-resolvable invitation after the recipient enables protection",async()=>{
  const ids:PrincipalId[]=[];
  const repo=new MemorySharedNetRepository({devApiKeys:["a","b"],contactPrincipals:ids});
  const a=(await repo.authenticateApiKey("a"))!,b=(await repo.authenticateApiKey("b"))!;
  const source=await repo.startInstance(a,{runtime_kind:"codex",cli_version:"test"});
  const target=await repo.startInstance(b,{runtime_kind:"codex",cli_version:"test",reach:"private"});
  const sa=(await repo.authenticateInstance(source.token))!,ta=(await repo.authenticateInstance(target.token))!;
  const {admissions}=await repo.createRoom(sa,{name:"legacy",with:[target.instance.id]});
  ids.push(b.principalId);
  await expect(repo.resolveDecision(ta,admissions[0].decision_id!,{resolution:"approved"})).rejects.toMatchObject({code:"permission_denied"});
  const resolved=await repo.resolveDecisionForPrincipal(b.principalId,admissions[0].decision_id!,{outcome:"approved"});
  expect(resolved.decision.decision.contact?.action).toBe("invite");
});

it("attributes compiled notifications to the authenticated actor, not the Room service",async()=>{
  const {repo,sa,ta,b,target}=await fixture();
  const {room,admissions}=await repo.createRoom(sa,{name:"compiled",type:"compiled",with:[target.instance.id]});
  await repo.resolveDecisionForPrincipal(b.principalId,admissions[0].decision_id!,{outcome:"approved"});
  const act=await repo.postAct(sa,room.id,{type:"work.request",work_id:"patch",to:target.instance.id,task:"Patch",idempotency_key:"request-1"});
  expect(act.accepted).toBe(true);
  expect((await repo.listContactWakes(ta,{after:null,limit:10})).items).toHaveLength(0);
  const decision=(await repo.listDecisionsForPrincipal(b.principalId)).decisions.find(d=>d.decision.contact?.action==="mention")!;
  expect(decision.decision.contact?.source_principal_id).toBe(sa.principalId);
  expect(decision.decision.requested_by_instance_id).toBe(sa.instanceId);
});

it("room closure and removed membership prohibit a new claim; cursors bind target identity",async()=>{
  const {repo,sa,ta,a,b,target}=await fixture();
  const {room,admissions}=await repo.createRoom(sa,{name:"closed wake",with:[target.instance.id]});
  await repo.resolveDecisionForPrincipal(b.principalId,admissions[0].decision_id!,{outcome:"approved"});
  await repo.postMessage(sa,room.id,{content:`@${target.instance.id} hello`});
  const decision=(await repo.listDecisionsForPrincipal(b.principalId)).decisions.find(d=>d.decision.contact?.action==="mention")!;
  await repo.resolveDecisionForPrincipal(b.principalId,decision.decision.id,{outcome:"approved"});
  const {items}=await repo.listContactWakes(ta,{after:null,limit:10});
  await expect(repo.listContactWakes(sa,{after:items[0].cursor,limit:10})).rejects.toMatchObject({code:"invalid_cursor"});
  await repo.removeRoomMember(a.principalId,room.id,ta.instanceId);
  await expect(repo.claimContactWake(ta,items[0].id,{execution_key:crypto.randomUUID()})).rejects.toMatchObject({code:"permission_denied"});
  await repo.closeRoom(a.principalId,room.id);
  await expect(repo.claimContactWake(ta,items[0].id,{execution_key:crypto.randomUUID()})).rejects.toMatchObject({code:"permission_denied"});
});

it("reuses a denied invitation and rejects an incompatible approval scope replay",async()=>{
 const {repo,sa,b,target}=await fixture();
 const first=await repo.createRoom(sa,{name:"deny retries",with:[target.instance.id]});
 await repo.resolveDecisionForPrincipal(b.principalId,first.admissions[0].decision_id!,{outcome:"denied"});
 expect((await repo.addRoomMembers(sa,first.room.id,{with:[target.instance.id]})).admissions[0].status).toBe("refused");
 expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions).toHaveLength(1);
 const next=await repo.createRoom(sa,{name:"scope",with:[target.instance.id]});
 await repo.resolveDecisionForPrincipal(b.principalId,next.admissions[0].decision_id!,{outcome:"approved"});
 await expect(repo.resolveDecisionForPrincipal(b.principalId,next.admissions[0].decision_id!,{outcome:"approved",scope:"source_principal_action"})).rejects.toMatchObject({code:"conflict"});
});

it("bounds outstanding requests per source and target without persisting a refused message",async()=>{
 const {repo,sa,b,target}=await fixture();
 const first=await repo.createRoom(sa,{name:"bounded",with:[target.instance.id]});
 await repo.resolveDecisionForPrincipal(b.principalId,first.admissions[0].decision_id!,{outcome:"approved"});
 for(let n=0;n<100;n++)await repo.postMessage(sa,first.room.id,{content:`@${target.instance.id} ${n}`});
 await expect(repo.postMessage(sa,first.room.id,{content:`@${target.instance.id} refused`})).rejects.toMatchObject({code:"resource_limit_reached"});
 expect((await repo.listDecisionsForPrincipal(b.principalId)).decisions.filter(d=>d.decision.status==="pending")).toHaveLength(100);
});

it("new trust does not authorize an earlier denied or pending invitation",async()=>{
 const {repo,sa,b,target}=await fixture();
 const denied=await repo.createRoom(sa,{name:"denied backlog",with:[target.instance.id]});
 await repo.resolveDecisionForPrincipal(b.principalId,denied.admissions[0].decision_id!,{outcome:"denied"});
 const pending=await repo.createRoom(sa,{name:"pending backlog",with:[target.instance.id]});
 const allowed=await repo.createRoom(sa,{name:"new trust",with:[target.instance.id]});
 await repo.resolveDecisionForPrincipal(b.principalId,allowed.admissions[0].decision_id!,{outcome:"approved",scope:"source_principal_action"});
 expect((await repo.addRoomMembers(sa,denied.room.id,{with:[target.instance.id]})).admissions[0]).toMatchObject({status:"refused",decision_id:denied.admissions[0].decision_id});
 expect((await repo.addRoomMembers(sa,pending.room.id,{with:[target.instance.id]})).admissions[0]).toMatchObject({status:"pending",decision_id:pending.admissions[0].decision_id});
});
