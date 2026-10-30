// Trusted RPC transport only. Client API, schemas, observations and operations
// are the original bundles. This module contains no browser interaction logic.
import {randomUUID} from 'node:crypto';
const fallback={session_id:randomUUID(),turn_id:randomUUID()};
const contexts=new Map();
let hooksRegistered=false;
const runtimeId=randomUUID();
let socketPromise;
const pending=new Map();

function metadata(){
  let value=globalThis.nodeRepl?.requestMeta?.['x-codex-turn-metadata'];
  if(typeof value==='string')value=JSON.parse(value);
  const meta=value?.session_id&&value?.turn_id?value:fallback;
  contexts.set(meta.session_id,meta.turn_id);
  return meta;
}
async function request(method,params){
  const port=Number(globalThis.nodeRepl?.env?.CHROME_BRIDGE_PORT||8766);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local bridge port');
  socketPromise ??= new Promise((resolve,reject)=>{
    const socket=new WebSocket(`ws://127.0.0.1:${port}/client`);
    const fail=()=>{const error=new Error('Local Chrome bridge is offline');reject(error);socketPromise=undefined;for(const finish of pending.values())finish(error);};
    socket.addEventListener('open',()=>resolve(socket),{once:true});
    socket.addEventListener('error',fail,{once:true});
    socket.addEventListener('close',fail,{once:true});
    socket.addEventListener('message',async event=>{
      const reply=JSON.parse(event.data);
      if(reply.type==='elicitation'){
        try{const result=await globalThis.nodeRepl.createElicitation(reply.request);await request('elicitation_reply',{elicitation_id:reply.elicitation_id,result});}
        catch(error){await request('elicitation_reply',{elicitation_id:reply.elicitation_id,error:String(error)});}
        return;
      }
      pending.get(reply.id)?.(reply.error?new Error(reply.error.message):undefined,reply.result);
    });
  });
  const socket=await socketPromise,id=randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Local bridge request timed out')),90000);
    const finish=(error,value)=>{clearTimeout(timer);pending.delete(id);error?reject(error):resolve(value);};
    pending.set(id,finish);
    try{socket.send(JSON.stringify({id,method,params}));}catch(error){finish(error);}
  });
}
async function call(action,args={},meta=metadata()){
  const runtime=globalThis.nodeRepl;
  const names=['BROWSER_USE_PREFERRED_EXTENSION_INSTANCE_ID','BROWSER_USE_PREFERRED_WINDOW_ID','BROWSER_USE_PREFERRED_CHROME_EXTENSION_INSTANCE_ID','BROWSER_USE_PREFERRED_CHROME_WINDOW_ID'];
  const runtime_env=Object.fromEntries(names.filter(name=>runtime?.env?.[name]!==undefined).map(name=>[name,runtime.env[name]]));
  return request('call',{action,runtime_id:runtimeId,arguments:{...args,...meta,runtime_env,request_meta:runtime?.requestMeta},supports_elicitation:true});
}
export async function handleRpc(message){
  if(!hooksRegistered){
    const runtime=globalThis.nodeRepl;
    if(runtime?.addAfterSubmittedCodeHook){
      runtime.addAfterSubmittedCodeHook({timeoutMs:20000,run:async()=>{
        const result=await call('runtime_after_code');
        runtime.setResponseMeta(result.responseMeta);
        for(const item of result.contentItems)runtime.emitContentItem(item);
      }});
    }
    if(runtime?.addTurnEndedHandler){
      runtime.addTurnEndedHandler({timeoutMs:10000,run:async meta=>{
        if(contexts.get(meta.session_id)===meta.turn_id){await call('session_end_turn',{},meta);contexts.delete(meta.session_id);}
      }});
    }
    hooksRegistered=true;
  }
  if(message.method==='setup')return call('runtime_setup');
  if(message.method==='execute')return call('browser_command',{command:message.params});
  if(message.method==='executeWithRecovery')return call('browser_command',{command:message.params,with_recovery:true});
  throw new Error('Unsupported browser service request');
}
