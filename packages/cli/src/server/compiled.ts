/** Admission shared by both persistence implementations; callers hold their Room lock. */
import { createHash } from 'node:crypto';
import { toCanonicalEvent, UnsupportedEnvelopeError } from '../protocol/envelope.ts';
import { Room, pythonJson, type StoredEvent } from '../protocol/room.ts';
import { renderObligations } from '../protocol/obligations.ts';
import type { ActResult, Artifact, CompiledRoomState, RoomId } from '../protocol/index.ts';
export type PersistedAct = { event: StoredEvent; envelopeDigest: string };
export const envelopeDigest = (envelope: unknown) => createHash('sha256').update(pythonJson(envelope)).digest('hex');
export function compiledState(engine: Room, actor: string): CompiledRoomState {
  return {protocol_version:engine.version, sequence:engine.log.length, digest:engine.digest(), projection:structuredClone(engine.projection), obligations:renderObligations(engine.projection,actor), events:structuredClone(engine.log)};
}
export function referencedArtifacts(envelope: Record<string, unknown>): string[] {
  const ids = envelope.type === 'work.result' ? Object.values((envelope.artifacts ?? {}) as Record<string,string>) : [];
  if (['verification.pass','verification.fail','human.approve','human.reject'].includes(String(envelope.type)) && typeof envelope.evidence === 'string') ids.push(envelope.evidence);
  return [...new Set(ids)];
}
export function admitCompiled(engine: Room, roomId: RoomId, actor: string, envelope: Record<string,unknown>, history: PersistedAct[], files: Map<string, Pick<Artifact,'id'|'room_id'|'sha256'>>): ActResult {
  const refusalDetail = (detail: string): string => [detail, renderObligations(engine.projection, actor)].filter(Boolean).join('\n\n');
  const reject=(code:string,detail:string):ActResult=>({accepted:false,code,detail:refusalDetail(detail),binding:false,seq:null,digest:engine.digest()});
  if (envelope.idempotency_key) {
    const previous=history.find(row=>row.event.actor===actor && row.event.idempotency_key===envelope.idempotency_key);
    if(previous) return previous.envelopeDigest===envelopeDigest(envelope)
      ? {accepted:true,code:'DUPLICATE',detail:'idempotent replay; not re-applied',binding:false,seq:previous.event.seq,digest:engine.digest(),event:structuredClone(previous.event)}
      : reject('IDEMPOTENCY_CONFLICT','This actor already used the key for another envelope.');
  }
  const needsClock = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(needsClock);
    const item = value as Record<string, unknown>;
    return item.kind === "expire" || item.op === "clock_ge" || Object.values(item).some(needsClock);
  };
  if (needsClock(envelope.requires)) return reject('UNSUPPORTED_ENVELOPE','Compiled service clocks are not enabled; expire and clock_ge clauses are unsupported.');
  const review=['verification.pass','verification.fail','human.approve','human.reject'].includes(String(envelope.type));
  if(review && (typeof envelope.result_ref!=='string' || !envelope.result_ref.trim())) return reject('STALE_COMMITMENT','Review must identify the exact result_ref.');
  if(review && (typeof envelope.evidence!=='string' || !envelope.evidence.trim())) return reject('MISSING_EVIDENCE','Review must reference an uploaded Room report as evidence.');
  const receipts:Record<string,{id:string;sha256:string}>=Object.create(null);
  for(const id of referencedArtifacts(envelope)) {
    const file=files.get(id);
    if(!file || file.room_id!==roomId) return reject('ARTIFACT_NOT_FOUND','Every artifact and review report must exist in this Room.');
    receipts[id]={id:file.id,sha256:file.sha256};
  }
  try {
    const event=toCanonicalEvent(actor,envelope,engine.projection,{requireEvidence:true});
    if(Object.keys(receipts).length) event.refs.artifact_receipts=receipts;
    const result=engine.ingest({...event,version:engine.version});
    return {...result,detail:result.accepted?result.detail:refusalDetail(result.detail),digest:result.digest??engine.digest(),...(result.accepted?{event:structuredClone(engine.log[result.seq!-1])}:{})};
  } catch(error) {
    if(error instanceof UnsupportedEnvelopeError) return reject(error.code,error.message);
    throw error;
  }
}
export const notification=(event:StoredEvent)=>`[compiled act #${event.seq}] ${event.actor} ${event.type}${event.work_id ? ` ${event.work_id}` : ''} ${event.hash}`;
