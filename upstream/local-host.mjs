// Host boundary only. RPC sessions, dispatch, schemas, controller, AX, input,
// navigation and error handling all run inside the original browser bundle.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {BrowserSessionClient,OriginalBrowserContext,browserPreference,enrichProfileInfo,OriginalBrowserRpcService,setupService,ConfigProvider,HostFilesystem,CommandTiming,PerformanceSpan,CommandSchemas,configureBrowserInfo} from './browser-engine.mjs';

// Translate the compatibility API's per-request window_id to the existing
// vendor createTab(preferredWindowId) parameter. Creation, window selection,
// grouping and turn tracking remain in the original service/client/backend.
export class LocalSessionClient extends BrowserSessionClient {
  createTab(preferredWindowId){
    return super.createTab(this.requestedWindowId?.() ?? preferredWindowId);
  }
}

// Replace only discovery of transports. Selection, aliases, URL ranking,
// preferred-window matching and close tracking are the original methods.
class LocalBrowserContext extends OriginalBrowserContext {
  constructor(runtime,host){super(runtime,browserPreference(runtime));this.host=host;}
  async refresh(){
    this.refreshPromise ??= (async()=>{
      const ids=this.host.connectedBrowsers?.map(b=>b.id)??[...this.host.browsers.keys()];
      for(const [id,item] of this.host.browsers)if(!ids.includes(id)){this.host.browsers.delete(id);await item.api.close();}
      this.browsers=await Promise.all(ids.map(id=>this.host.browser(id)));
      for(const item of this.browsers)this.trackBrowser(item);
    })().finally(()=>{this.refreshPromise=null;});
    await this.refreshPromise;
  }
}

const configPath=process.env.CHROME_MCP_POLICY_PATH || join(homedir(), '.chromemcp', 'browser-policy.json');
class LocalConfig {
  // Preserve the installed bridge's consent for trusted local clients. Never
  // invent elicitation replies. Original URL checks and configured denials run.
  values={global:{approval_mode:'never_ask'},sessions:{},config:{},requirements:{}};
  async load(){try{this.values=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
  async save(){await mkdir(dirname(configPath),{recursive:true});await writeFile(configPath,JSON.stringify(this.values,null,2));}
  async read(){return {config:this.values.config||{}};}
  async readRequirements(){return {requirements:this.values.requirements||{}};}
  async readToml(path){return path.includes('/sessions/')?this.values.sessions[path]||{}:this.values.global||{};}
  async writeToml(path,value){if(path.includes('/sessions/'))this.values.sessions[path]=value;else this.values.global=value;await this.save();}
}

class LoopbackTransport {
  constructor(host,browser){this.host=host;this.browser=browser;this.closers=new Set();}
  setMessageCallback(callback){this.callback=callback;}
  addCloseListener(callback){this.closers.add(callback);return ()=>this.closers.delete(callback);}
  sendMessage(message){
    const notification=message.id===undefined,id=`${this.browser}:${notification?randomUUID():message.id}`;
    if(!notification)this.host.pending.set(id,{transport:this,id:message.id});
    const {session_id,turn_id,session_context,...args}=message.params||{};
    this.host.send({type:'rpc',id,browser_id:this.browser,method:message.method,arguments:args,session_id,turn_id,session_context,notification});
  }
  receive(message){this.callback?.(message);}
  async close(){for(const callback of this.closers)await callback();}
}

export class LocalHost {
  constructor(send){this.send=send;this.pending=new Map();this.elicitations=new Map();this.browsers=new Map();this.browserLoads=new Map();this.turnHooks=new Set();this.codeHooks=new Set();this.context=new AsyncLocalStorage();this.responseMeta={};this.contentItems=[];}
  get meta(){return this.context.getStore()?.meta;}
  async setup(){
    const config=new LocalConfig();await config.load();
    const runtime={
      platform:process.platform,cwd:fileURLToPath(new URL('../',import.meta.url)),
      env:{BROWSER_USE_DISABLE_AMBIENT_NETWORK:'1',BROWSER_USE_TINYSKY_ENABLED:'1',BROWSER_USE_ACCESSIBILITY_CORE_WASM_PATH:fileURLToPath(new URL('./browser-accessibility.wasm.br',import.meta.url))},
      get requestMeta(){return {...this.host.context.getStore()?.requestMeta,...(this.host.meta?{'x-codex-turn-metadata':this.host.meta}:{})};},host:this,
      config,fetch:globalThis.fetch,
      setResponseMeta:value=>Object.assign(this.responseMeta,value),
      emitContentItem:value=>this.contentItems.push(value),
      addAfterSubmittedCodeHook:hook=>{this.codeHooks.add(hook);return ()=>this.codeHooks.delete(hook);},
      addTurnEndedHandler:hook=>{this.turnHooks.add(hook);return ()=>this.turnHooks.delete(hook);},
      createElicitation:async request=>{
        const {meta,...result}=await this.elicit(request);
        return {...result,_meta:result._meta??meta};
      },
    };
    this.runtime=runtime;
    const browserContext=new LocalBrowserContext(runtime,this);
    this.browserContext=browserContext;this.tracker=browserContext.turnEndedTracker;
    this.service=await setupService({environment:'codex-app'},Object.assign(Object.create(runtime),{
      config:ConfigProvider(runtime),browserContext,
      commandTiming:CommandTiming,performanceSpan:PerformanceSpan,filesystem:HostFilesystem,
      errorReporter:{captureException:error=>process.stderr.write(String(error)+'\n'),setTag(){},setUser(){},setExtra(){},setContext(){}},
    }));
    OriginalBrowserRpcService.execute=command=>this.execute(command);
    return {apiManifest:this.service.apiManifest,disabledMemberIds:[...this.service.disabledMemberIds],credentialRecoveryErrorVersion:1};
  }
  async browser(id){
    if(this.browsers.has(id))return this.browsers.get(id);
    if(this.browserLoads.has(id))return this.browserLoads.get(id);
    const loading=this.loadBrowser(id);this.browserLoads.set(id,loading);
    try{return await loading;}finally{this.browserLoads.delete(id);}
  }
  async loadBrowser(id){
    const transport=new LoopbackTransport(this,id);
    const api=new LocalSessionClient(transport,{ping:()=> 'pong'},()=>this.meta,this.tracker);
    api.requestedWindowId=()=>this.context.getStore()?.preferredWindowId;
    const info=configureBrowserInfo(this.runtime,await enrichProfileInfo(await api.getInfo(),this.runtime));
    api.clientInfo=info;
    const item={id,api,info,transport};this.browsers.set(id,item);return item;
  }
  async withContext(browserId,args,fn){
    const meta={session_id:args.session_id,turn_id:args.turn_id};
    if(!meta.session_id||!meta.turn_id)throw new Error('session_id and turn_id are required');
    return this.context.run({meta,requestId:args.local_request_id,requestMeta:args.request_meta,preferredWindowId:args.window_id},async()=>{
      if(args.connected_browsers)this.connectedBrowsers=args.connected_browsers;
      if(args.runtime_env){Object.assign(this.runtime.env,args.runtime_env);this.browserContext.browserPreference=browserPreference(this.runtime);}
      if(browserId)await this.browser(browserId);
      // Legacy callers pre-load one transport instead of passing discovery.
      if(!this.connectedBrowsers)this.browserContext.browsers=[...this.browsers.values()];
      return fn();
    });
  }
  execute(command){
    const {type,...params}=command;
    const schema=Object.values(CommandSchemas).find(s=>s.commandType===type);
    return this.service.executeAgentCommand({type,...(schema?schema.PayloadSchema.parse(params):params)});
  }
  executeWithRecovery(command){return OriginalBrowserRpcService.executeWithRecovery(command);}
  async afterCode(browserId,args){
    return this.withContext(browserId,args,async()=>{
      this.responseMeta={};this.contentItems=[];
      for(const hook of this.codeHooks)await hook.run();
      return {responseMeta:this.responseMeta,contentItems:this.contentItems};
    });
  }
  async endTurn(browserId,args){
    return this.withContext(browserId,args,async()=>{
      for(const hook of this.turnHooks)await hook.run({session_id:args.session_id,turn_id:args.turn_id});
      return {};
    });
  }
  result(message){
    const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);
    pending.transport.receive({jsonrpc:'2.0',id:pending.id,...(message.error?{error:{code:1,message:message.error}}:{result:message.result})});
  }
  event(browserId,name,value){this.browsers.get(browserId)?.transport.receive({jsonrpc:'2.0',method:name,params:value});}
  elicit(request){
    const id=randomUUID(),request_id=this.context.getStore()?.requestId;
    return new Promise((resolve,reject)=>{this.elicitations.set(id,{resolve,reject});this.send({type:'elicitation',id,request_id,request});});
  }
  elicitationResult(message){
    const pending=this.elicitations.get(message.id);if(!pending)return;this.elicitations.delete(message.id);
    message.error?pending.reject(new Error(message.error)):pending.resolve(message.result);
  }
}
