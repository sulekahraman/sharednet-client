// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import { handleRequest } from "./handler.ts";

const key = `snk_${"D".repeat(43)}`;
async function setup() {
  const store = new MemorySharedNetRepository({devApiKey:key});
  const account = await store.authenticateApiKey(key);
  if (!account) throw new Error('fixture account');
  const started = await store.startInstance(account, {runtime_kind:'codex',cli_version:'test',runtime_metadata:{}});
  const headers = {authorization:`Bearer ${started.token}`, 'x-sharednet-contact-protocol':'contact-consent-v1','content-type':'application/json'};
  const call = (path:string, init:RequestInit={}) => handleRequest(new Request(`http://localhost/api/v1${path}`,init),store);
  return {store,headers,call,account,started};
}
describe('contact wake HTTP boundary',()=>{
  it('requires a seat credential rather than an account key or anonymous request',async()=>{
    const {call}=await setup();
    expect((await call('/contact-wakes')).status).toBe(401);
    expect((await call('/contact-wakes',{headers:{authorization:`Bearer ${key}`}})).status).toBe(401);
  });
  it('requires the explicit compatible protocol and returns no-store wake results',async()=>{
    const {call,headers}=await setup();
    expect((await call('/contact-wakes',{headers:{authorization:headers.authorization}})).status).toBe(409);
    const result=await call('/contact-wakes',{headers});
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(await result.json()).toMatchObject({items:[]});
  });
  it('rejects client-selected targets, repeated query keys and out-of-bounds limits',async()=>{
    const {call,headers}=await setup();
    for(const query of ['target_instance_id=i_AAAAAAAAAA','limit=0','limit=101','limit=1&limit=2']) {
      const result=await call(`/contact-wakes?${query}`,{headers});
      expect(result.status,query).toBe(422);
    }
  });
  it('binds wake cursors to the authenticated target',async()=>{
    const {call,headers}=await setup();
    expect((await call('/contact-wakes?after=untrusted',{headers})).status).toBe(400);
  });
  it('blocks legacy wait for protected seats even with a compatibility header',async()=>{
    const ids: import('../protocol/index.ts').PrincipalId[]=[];
    const store=new MemorySharedNetRepository({devApiKey:key,contactPrincipals:ids});
    const account=(await store.authenticateApiKey(key))!;
    const started=await store.startInstance(account,{runtime_kind:'codex',cli_version:'test'});
    const auth=(await store.authenticateInstance(started.token))!;
    const {room}=await store.createRoom(auth,{name:'legacy guard'});
    ids.push(account.principalId);
    const response=await handleRequest(new Request(`http://localhost/api/v1/rooms/${room.id}/wait?timeout=0`,{headers:{authorization:`Bearer ${started.token}`,'x-sharednet-contact-protocol':'contact-consent-v1'}}),store);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error:{code:'contact_runtime_required'}});
  });
  it('rejects malformed claim/completion input before looking up an event',async()=>{
    const {call,headers}=await setup();
    const wake='/contact-wakes/wak_AAAAAAAAAA';
    for(const body of [{execution_key:'bad'}, {execution_key:'00000000-0000-4000-8000-000000000001',owner:'p_AAAAAAAAAA'}]) {
      expect((await call(`${wake}/claim`,{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(422);
    }
    expect((await call(`${wake}/complete`,{method:'POST',headers,body:JSON.stringify({execution_key:'00000000-0000-4000-8000-000000000001',receipt:'',outcome:'completed'})})).status).toBe(422);
    expect((await call('/contact-wakes/not-a-wake/claim',{method:'POST',headers,body:JSON.stringify({execution_key:'00000000-0000-4000-8000-000000000001'})})).status).toBe(422);
  });
});
