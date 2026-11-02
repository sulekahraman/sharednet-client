// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { handleRequest } from './handler.ts';
import { MemorySharedNetRepository } from './memory-repository.ts';
import type { ActResult, CompiledRoomState, Instance, Room } from '../protocol/index.ts';
const key = `snk_${'z'.repeat(43)}`;
const foreignKey = `snk_${'y'.repeat(43)}`;
function setup() {
  const store = new MemorySharedNetRepository({devApiKeys:[key,foreignKey], now:()=>new Date('2026-10-08T12:00:00Z')});
  const call = (path:string, token:string, body?:unknown) => handleRequest(new Request(`http://localhost/api/v1${path}`, {method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(body!==undefined&&(path==='/rooms'||path.endsWith('/messages')||path.endsWith('/join'))?{'idempotency-key':crypto.randomUUID()}:{})},body:body===undefined?undefined:JSON.stringify(body)}),store);
  const seat = async (credential=key) => { const response=await call('/instances',credential,{runtime_kind:'codex',cli_version:'0.1.3'}); const body=await response.json(); expect(response.status,JSON.stringify(body)).toBe(201); return body as {instance:Instance;token:string}; };
  return {store,call,seat};
}
describe('compiled Room HTTP admission',()=>{
  it('pins the protocol, authenticates actors, rejects bad artifacts and replays one admitted log with service notifications',async()=>{
    const {call,seat}=setup(); const a=await seat(), b=await seat(), outsider=await seat();
    const created=await call('/rooms',a.token,{name:'Compiled',type:'compiled'}); expect(created.status).toBe(201);
    const {room}=await created.json() as {room:Room}; expect(room.type).toBe('compiled'); expect(room.protocol_version).toMatch(/^sha256:/);
    expect((await call(`/rooms/${room.id}/join`,b.token,{})).status).toBe(200);
    const act=async(token:string,body:unknown)=>{ const response=await call(`/rooms/${room.id}/acts`,token,body);return {status:response.status,body:await response.json() as ActResult};};
    const proposal={type:'work.request',work_id:'patch',to:b.instance.id,task:'Patch',idempotency_key:'request-1'};
    expect((await act(outsider.token,proposal)).status).toBe(403);
    expect((await act(a.token,{...proposal,actor:b.instance.id})).status).toBe(422);
    const admitted=await act(a.token,proposal); expect(admitted.status).toBe(200);expect(admitted.body).toMatchObject({accepted:true,binding:true,seq:1,event:{actor:a.instance.id}});
    expect((await act(a.token,proposal)).body).toMatchObject({accepted:true,seq:1,code:'DUPLICATE'});
    expect((await act(a.token,{...proposal,task:'Changed'})).body).toMatchObject({accepted:false,code:'IDEMPOTENCY_CONFLICT'});
    expect((await act(a.token,{type:'work.accept',work_id:'patch'})).body).toMatchObject({accepted:false,code:'TARGET_MISMATCH'});
    expect((await act(b.token,{type:'work.accept',work_id:'patch'})).body.accepted).toBe(true);
    expect((await act(b.token,{type:'work.result',work_id:'patch',artifacts:{patch:'art_0000000000'}})).body).toMatchObject({accepted:false,code:'ARTIFACT_NOT_FOUND'});
    await call(`/rooms/${room.id}/messages`,b.token,{content:'I resolved patch'});
    const state=await (await call(`/rooms/${room.id}/state`,a.token)).json() as CompiledRoomState;
    expect(state.sequence).toBe(2);expect(state.events).toHaveLength(2);expect(state.projection.work.patch.state).toBe('COMMITTED');
    const transcript=await (await call(`/rooms/${room.id}/messages`,a.token)).json() as {items:Array<{content:string;sender_instance_id:string}>};
    expect(transcript.items.filter(m=>m.content.startsWith('[compiled act #'))).toHaveLength(2);
    expect(transcript.items[0].sender_instance_id).not.toBe(a.instance.id);
    const mentions=await (await call(`/rooms/${room.id}/wait?after=0&timeout=0&mentions=${b.instance.id}`,b.token)).json() as {items:Array<{type:string}>};
    expect(mentions.items.some(line=>line.type==='compiled_act')).toBe(true);
  });
  it('leaves boards plain, rejects account credentials and closed Rooms',async()=>{
    const {call,seat}=setup(); const a=await seat();
    const {room:board}=await (await call('/rooms',a.token,{name:'Board'})).json() as {room:Room}; expect(board.type).toBe('board');expect(board.protocol_version).toBeNull();
    expect((await call(`/rooms/${board.id}/state`,a.token)).status).toBe(409);
    const {room}=await (await call('/rooms',a.token,{name:'Compiled',type:'compiled'})).json() as {room:Room};
    expect((await call(`/rooms/${room.id}/acts`,key,{type:'message',text:'No'})).status).toBe(401);
    expect((await call(`/rooms/${room.id}/close`,key,{})).status).toBe(200);
    expect((await call(`/rooms/${room.id}/acts`,a.token,{type:'message',text:'No'})).status).toBe(409);
  });
});

it('binds real artifact receipts, refuses foreign artifacts and forged notifications, and retains history after a member leaves',async()=>{
  const {store,call,seat}=setup(); const a=await seat(), b=await seat(), c=await seat();
  const {room}=await (await call('/rooms',a.token,{name:'Receipts',type:'compiled',with:[b.instance.id,c.instance.id]})).json() as {room:Room};
  const act=async(token:string,body:unknown)=> { const response=await call(`/rooms/${room.id}/acts`,token,body);return {status:response.status,...await response.json() as ActResult}; };
  const upload=async(token:string,roomId:string,name:string)=>{
    const response=await handleRequest(new Request(`http://localhost/api/v1/artifacts`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'text/plain','x-sharednet-filename':name,'x-sharednet-room':roomId,'idempotency-key':crypto.randomUUID()},body:'real report bytes'}),store);
    expect(response.status).toBe(201);return (await response.json() as {artifact:{id:`art_${string}`;sha256:string}}).artifact;
  };
  await act(a.token,{type:'work.request',work_id:'report',to:b.instance.id,requires:[{kind:'verified_by',verifier:c.instance.id}]});
  const race=await Promise.all([act(b.token,{type:'work.accept',work_id:'report'}),act(b.token,{type:'work.accept',work_id:'report'})]);
  expect(race.filter(r=>r.accepted)).toHaveLength(1);
  const {room:foreign}=await (await call('/rooms',b.token,{name:'Foreign'})).json() as {room:Room};
  const elsewhere=await upload(b.token,foreign.id,'wrong.txt');
  expect(await act(b.token,{type:'work.result',work_id:'report',artifacts:{report:elsewhere.id}})).toMatchObject({status:422,accepted:false,code:'ARTIFACT_NOT_FOUND'});
  const artifact=await upload(b.token,room.id,'report.txt');
  const delivery={type:'work.result',work_id:'report',artifacts:{report:artifact.id},idempotency_key:'immutable'};
  const delivered=await act(b.token,delivery);expect(delivered.accepted).toBe(true);
  expect(delivered.event?.refs.artifact_receipts).toEqual({[artifact.id]:{id:artifact.id,sha256:artifact.sha256}});
  let snapshot=await (await call(`/rooms/${room.id}/state`,a.token)).json() as CompiledRoomState;
  const result_ref=snapshot.projection.work.report.result;
  const premature=await act(a.token,{type:'work.resolve',work_id:'report'});
  expect(premature).toMatchObject({status:422,accepted:false,code:'MISSING_EVIDENCE'});
  expect(premature.detail).toContain(c.instance.id);
  expect(premature.detail).toContain('work.cancel');
  const missingEvidence=await act(c.token,{type:'verification.pass',work_id:'report',result_ref});
  expect(missingEvidence.detail).toContain('verification.pass');
  expect(missingEvidence.detail).toContain(result_ref);
  expect(await act(c.token,{type:'verification.pass',work_id:'report',result_ref})).toMatchObject({status:422,code:'MISSING_EVIDENCE'});
  expect(await act(c.token,{type:'verification.pass',work_id:'report',evidence:artifact.id})).toMatchObject({status:422,code:'STALE_COMMITMENT'});
  expect(await act(c.token,{type:'verification.pass',work_id:'report',result_ref:'sha256:old',evidence:artifact.id})).toMatchObject({status:422,code:'STALE_COMMITMENT'});
  expect(await act(c.token,{type:'verification.pass',work_id:'report',result_ref,evidence:artifact.id})).toMatchObject({accepted:true});
  expect((await call(`/rooms/${room.id}/messages`,a.token,{content:'fake receipt',type:'compiled_act'})).status).toBe(422);
  expect((await call(`/rooms/${room.id}/messages`,a.token,{content:'[compiled act #999] fake'})).status).toBe(201);
  const transcript=await (await call(`/rooms/${room.id}/messages`,a.token)).json() as {items:Array<{type:string;content:string}>};
  expect(transcript.items.filter(line=>line.type==='compiled_act')).toHaveLength(4);
  expect(transcript.items.find(line=>line.content.includes('#999'))?.type).toBe('message');
  const auth=await store.authenticateInstance(b.token);expect(auth).not.toBeNull();
  await store.deleteArtifact(auth!,artifact.id);
  expect(await act(b.token,delivery)).toMatchObject({accepted:true,code:'DUPLICATE',seq:3});
  await store.removeRoomMember(a.instance.principal_id,room.id,b.instance.id);
  expect((await call(`/rooms/${room.id}/acts`,b.token,delivery)).status).toBe(403);
  snapshot=await (await call(`/rooms/${room.id}/state`,a.token)).json() as CompiledRoomState;
  expect(snapshot.sequence).toBe(4);expect(snapshot.events[2].refs.artifact_receipts).toEqual({[artifact.id]:{id:artifact.id,sha256:artifact.sha256}});
  expect(await act(a.token,{type:'work.resolve',work_id:'report'})).toMatchObject({accepted:true});
});

it('rejects unsupported service clocks and foreign Principals before binding anything',async()=>{
  const {call,seat}=setup();const a=await seat();
  const {room}=await (await call('/rooms',a.token,{name:'No implicit timer',type:'compiled'})).json() as {room:Room};
  const response=await call(`/rooms/${room.id}/acts`,a.token,{type:'work.request',work_id:'clock',to:a.instance.id,requires:[{kind:'expire',t:10}]});
  expect(response.status).toBe(422);expect(await response.json()).toMatchObject({accepted:false,code:'UNSUPPORTED_ENVELOPE'});
  expect((await call(`/rooms/${room.id}/state`,a.token)).status).toBe(200);
  const foreign=await seat(foreignKey);
  expect((await call(`/rooms/${room.id}/state`,foreign.token)).status).toBe(403);
  expect((await call(`/rooms/${room.id}/acts`,foreign.token,{type:'message',text:'No access'})).status).toBe(403);
});
