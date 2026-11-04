import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { generatePublicId, type ContactAction, type ContactMetadata, type ContactRule, type ContactWake, type InstanceId, type MessageId, type PrincipalId, type RoomId } from "../protocol/index.ts";
import { RepositoryError } from "./repository.ts";
export type StoredContactWake = { wake: ContactWake; sourcePrincipalId: PrincipalId; sourceInstanceId: InstanceId; ruleId: string | null; decisionId: string | null; expiresAt: string; position: number; executionKey: string | null; receiptDigest: string | null };
export type ContactState = { rules: ContactRule[]; wakes: StoredContactWake[]; counters: Record<string, number>; receiptKey: string };
export function emptyContactState(): ContactState { return {rules:[],wakes:[],counters:{},receiptKey:randomBytes(32).toString("hex")}; }
export function configuredContactPrincipals(environment: Record<string, string | undefined> = process.env): PrincipalId[] {
  const value=environment.SHAREDNET_CONTACT_PRINCIPALS?.trim();
  if (!value) return [];
  const ids=value.split(",").map(x=>x.trim());
  if (ids.some(id=>!/^p_[0-9A-Za-z]{10}$/.test(id))) throw new Error("Invalid SHAREDNET_CONTACT_PRINCIPALS configuration");
  return [...new Set(ids)] as PrincipalId[];
}
/**
 * Mention consent for everyone: an @ from another Principal's seat wakes an agent only after that
 * agent's owner approves it in Decisions. On unless SHAREDNET_MENTION_CONSENT is "off".
 */
export function configuredMentionConsent(environment: Record<string, string | undefined> = process.env): boolean {
  return environment.SHAREDNET_MENTION_CONSENT?.trim().toLowerCase() !== "off";
}
/** The short pointer an approval posts, so the target is woken without repeating the source text. */
export function releasedContent(target: InstanceId, sequence: number): string { return `✅ approved by owner — @${target} see #${sequence}`; }
export function contactRule(state: ContactState, source: PrincipalId, action: ContactAction): ContactRule | undefined { return state.rules.find(r=>r.source_principal_id===source && r.action===action && r.revoked_at===null); }
export function grantContactRule(state: ContactState, owner: PrincipalId, source: PrincipalId, action: ContactAction, now: string): ContactRule {
  const old=contactRule(state,source,action); if(old) return old;
  const rule:ContactRule={id:generatePublicId("ctr"),owner_principal_id:owner,source_principal_id:source,action,created_at:now,revoked_at:null};state.rules.push(rule);return rule;
}
export function metadata(action:ContactAction,source:PrincipalId,target:InstanceId,message:MessageId|null,now:string):ContactMetadata { return {action,source_principal_id:source,target_instance_id:target,source_message_id:message,expires_at:new Date(Date.parse(now)+86400000).toISOString(),effect_state:"pending"}; }
export function enqueueContactWake(state:ContactState, args:{roomId:RoomId;targetId:InstanceId;messageId:MessageId;sourceId:InstanceId;sourcePrincipalId:PrincipalId;authorization:ContactWake["authorization"];ruleId?:string;decisionId?:string;expiresAt:string;now:string}):ContactWake {
  const old=state.wakes.find(w=>w.wake.target_instance_id===args.targetId&&w.wake.source_message_id===args.messageId);if(old)return old.wake;
  const position=(state.counters[args.targetId]??0)+1;state.counters[args.targetId]=position;
  const wake:ContactWake={id:generatePublicId("wak"),cursor:Buffer.from(`${args.targetId}:${position}`).toString("base64url"),kind:"contact.wake",source_message_id:args.messageId,room_id:args.roomId,target_instance_id:args.targetId,authorized_at:args.now,authorization:args.authorization,policy_version:1,state:"queued"};
  state.wakes.push({wake,sourcePrincipalId:args.sourcePrincipalId,sourceInstanceId:args.sourceId,ruleId:args.ruleId??null,decisionId:args.decisionId??null,expiresAt:args.expiresAt,position,executionKey:null,receiptDigest:null});return wake;
}
export function contactWakeList(state:ContactState,target:InstanceId,input:{after:string|null;limit:number}):{items:ContactWake[];next_cursor:string|null} {
  let after=0;
  if(input.after){const raw=Buffer.from(input.after,"base64url").toString();const [id,n]=raw.split(":");after=Number(n);if(id!==target||!Number.isSafeInteger(after)||after<0||Buffer.from(raw).toString("base64url")!==input.after)throw new RepositoryError(400,"invalid_cursor","Invalid contact cursor.");}
  const items=state.wakes.filter(w=>w.wake.target_instance_id===target&&w.position>after).sort((a,b)=>a.position-b.position).slice(0,input.limit).map(w=>({...w.wake}));return {items,next_cursor:items.at(-1)?.cursor??input.after};
}
export function storedWake(state:ContactState,target:InstanceId,id:string):StoredContactWake { const item=state.wakes.find(w=>w.wake.id===id&&w.wake.target_instance_id===target);if(!item)throw new RepositoryError(404,"decision_not_found","Wake was not found.");return item; }
export function claimWake(state:ContactState,item:StoredContactWake,key:string,now:string):{wake:ContactWake;receipt:string} {
  if(item.executionKey && item.executionKey!==key)throw new RepositoryError(409,"conflict","Wake already claimed.");
  if(!item.executionKey){
    if(item.wake.state!=="queued"||item.expiresAt<=now||(item.ruleId&&!state.rules.some(r=>r.id===item.ruleId&&r.revoked_at===null)))throw new RepositoryError(403,"permission_denied","Contact authorization is no longer active.");
    item.executionKey=key;item.wake.state="claimed";
  }
  // A keyed receipt is reproducible on reconnect; only a server-held HMAC key and
  // receipt digest are persisted. Receipt has no authority outside completion.
  const receipt=createHmac("sha256",state.receiptKey).update(`${item.wake.id}:${key}`).digest("base64url");
  item.receiptDigest=createHash("sha256").update(receipt).digest("hex");
  return {wake:{...item.wake},receipt};
}
export function completeWake(state:ContactState,item:StoredContactWake,input:{execution_key:string;receipt:string;outcome:"completed"|"failed"|"interrupted"}):{wake:ContactWake} {
  const expected=createHmac("sha256",state.receiptKey).update(`${item.wake.id}:${input.execution_key}`).digest("base64url");
  if(item.executionKey!==input.execution_key||expected.length!==input.receipt.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(input.receipt)))throw new RepositoryError(403,"permission_denied","Invalid completion receipt.");
  if(item.wake.state!=="claimed"&&item.wake.state!==input.outcome)throw new RepositoryError(409,"conflict","Conflicting completion.");
  item.wake.state=input.outcome;return {wake:{...item.wake}};
}
