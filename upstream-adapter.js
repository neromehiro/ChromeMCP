// Loopback transport adapter around the unchanged upstream extension backend.
import {upstream} from './upstream/extension-core.js';

let backend;
let rpcBridge;
let emitOriginalEvent=()=>{};
let mentionProvider;
const stoppedTabs = new Set();
const ownDetaches = new Set();
let stoppedReady;
const controls=new Map();
let creationQueue=Promise.resolve();
const activeCalls=new Map();
const rpcReplies=new Map();
let nextRpcId=1;

async function loadControls(){
  await (stoppedReady ||= (async()=>{
    const saved=await chrome.storage.session.get(['local_upstream_stopped_tabs','local_upstream_controls']);
    for(const id of saved.local_upstream_stopped_tabs||[])stoppedTabs.add(id);
    for(const item of saved.local_upstream_controls||[])controls.set(item.id,item);
    await chrome.storage.session.remove('local_saved_tabs');
  })());
}
const saveControls=()=>chrome.storage.session.set({local_upstream_controls:[...controls.values()]});

function core() {
  // Original zm() wires the provider's lazy invalidation observation. Keep its
  // tab filters, debounce, generation and favicon-cache notifications intact.
  mentionProvider ||= new upstream.BrowserTabMentionProvider('prod',upstream.tabFavicons(),()=>{
    const invalidate=()=>emitOriginalEvent('onBrowserTabMentionsInvalidated');
    upstream.observeTabMentionInvalidations(invalidate);
    mentionProvider.subscribeInvalidations(invalidate);
  });
  return backend ||= new upstream.BrowserBackend({browserTabMentionProvider:mentionProvider,webMcpConfig:upstream.webMcpConfig(),browserManagementEnabled:upstream.featureGate('codex-app-chrome-extension-browser-management').catch(()=>false),agentPopupInterceptorEnabled:upstream.featureGate('codex-app-chrome-extension-background-popups').catch(()=>false)});
}
function originalRequestHandlers(){
  rpcBridge ||= new upstream.BrowserRpcBridge({setMessageCallback(){},sendMessage(message){
    const settle=rpcReplies.get(message.id);
    if(settle){rpcReplies.delete(message.id);settle(message);}
  }},core());
  return rpcBridge.requestHandlers;
}

export async function originalRpc(params) {
  if(params.method==='createTab'){
    const result=creationQueue.then(async()=>{
      const inventory=await originalTabInventory();
      if(inventory.agent_count>=inventory.limit)throw new Error(`自動化タブが上限${inventory.limit}枚です。拡張のタブ一覧で不要な作業を終了してください。`);
      return executeOriginalRpc(params);
    });
    creationQueue=result.catch(()=>{});
    return result;
  }
  return executeOriginalRpc(params);
}

async function executeOriginalRpc(params) {
  await loadControls();
  const {method,arguments:args={},session_id,turn_id,session_context} = params;
  // The original SessionClient recognizes this exact RPC error and falls back
  // for optional host methods (committed URLs and cached CDP expressions).
  const handlers=originalRequestHandlers();
  const handler=async value=>{
    if(params.notification){await rpcBridge.handleIncomingMessage({jsonrpc:'2.0',method,params:value});return;}
    const id=nextRpcId++;
    const reply=new Promise(resolve=>rpcReplies.set(id,resolve));
    try{
      await rpcBridge.handleIncomingMessage({jsonrpc:'2.0',id,method,params:value});
      const message=await reply;
      if(message.error){const error=new Error(message.error.message);error.rpcError=message.error;throw error;}
      return message.result;
    }finally{rpcReplies.delete(id);}
  };
  if(!params.notification&&!handlers.has(method))return handler(args);
  // Original App discovery calls getInfo without turn metadata, and its
  // "show browser" button calls focusTab with only session_id and tabId.
  // These three original backend methods do not activate a browser turn.
  if(['ping','getInfo','focusTab'].includes(method))return handler({...args,...(session_id?{session_id}:{})});
  if (!session_id || !turn_id) throw new Error('session_id and turn_id are required');
  const context={session_id,turn_id,...(session_context==='cached'?{session_context}:{})};
  const releasingInput=method==='executeCdp' && (
    (args.method==='Input.dispatchMouseEvent'&&args.commandParams?.type==='mouseReleased') ||
    (args.method==='Input.dispatchKeyEvent'&&args.commandParams?.type==='keyUp'));
  let control=controls.get(session_id);
  const needsSave=!control||!control.turn_ids?.includes(turn_id)||method==='nameSession';
  if(!control){control={id:session_id,name:'ChatGPT',paused:false};controls.set(session_id,control);}
  control.turn_ids ||= [];
  if(!control.turn_ids.includes(turn_id))control.turn_ids.push(turn_id);
  control.last_activity=Date.now();
  const cleanupOnly=['detach','detachTarget','turnEnded'].includes(method)||releasingInput;
  if(!cleanupOnly&&control.paused)throw new Error('ユーザーがブラウザ操作を停止しました。ポップアップから再開してください。');
  const id=args.tabId ?? args.target?.tabId;
  if(id!==undefined) {
    const tab=await chrome.tabs.get(id);
    if(args.expected_url!==undefined&&args.expected_url!==tab.url)throw new Error('The tab URL changed. Inspect the tabs again.');
    if(args.expected_title!==undefined&&args.expected_title!==tab.title)throw new Error('The tab title changed. Inspect the tabs again.');
    if(stoppedTabs.has(id) && !cleanupOnly)throw new Error('Chrome debugger was stopped by the user. Resume from the extension popup.');
  }
  if(method==='nameSession')control.name=args.name;
  const expectedDetach=[];
  const attached=new Set(upstream.debuggerAttachedTabs());
  if(method==='detach'&&id!==undefined&&attached.has(id))expectedDetach.push(id);
  if(method==='turnEnded'){
    const tabs=await core().sessions.get(session_id)?.getTabs()||[];
    for(const tab of tabs)if(attached.has(tab.id))expectedDetach.push(tab.id);
  }
  for(const tab of expectedDetach)ownDetaches.add(tab);
  activeCalls.set(session_id,(activeCalls.get(session_id)||0)+1);
  try {
    if(needsSave)await saveControls();
    const result=await handler({...args,...context});
    if(method==='turnEnded'){
      control.turn_ids=control.turn_ids.filter(id=>id!==turn_id);
      const leases=await leaseSnapshot();
      if(!control.turn_ids.length&&![...leases.values()].some(lease=>lease.sessionId===session_id))controls.delete(session_id);
    }
    if(['nameSession','turnEnded','createTab'].includes(method))await saveControls();
    return result;
  } catch(error){
    for(const tab of expectedDetach)ownDetaches.delete(tab);
    throw error;
  } finally {
    const count=(activeCalls.get(session_id)||1)-1;
    if(count)activeCalls.set(session_id,count);else activeCalls.delete(session_id);
  }
}

export function connectOriginalEvents(emit) {
  emitOriginalEvent=emit;
  // The same event and handler used by the original extension's bootstrap.
  chrome.webNavigation.onCreatedNavigationTarget.addListener(details=>{
    void core().handleCreatedNavigationTarget(details).catch(()=>{});
  });
  core().addDownloadChangeListener(value=>emit('onDownloadChange',value));
  chrome.downloads.onCreated.addListener(value=>core().handleDownloadCreated(value));
  chrome.downloads.onChanged.addListener(value=>core().handleDownloadChanged(value));
  chrome.debugger.onEvent.addListener((source,method,params)=>emit('onCDPEvent',{source,method,params}));
  chrome.debugger.onDetach.addListener((source,reason)=>{
    const initiated=ownDetaches.delete(source.tabId);
    if(reason==='canceled_by_user'&&!initiated){
      stoppedTabs.add(source.tabId);
      void chrome.storage.session.set({local_upstream_stopped_tabs:[...stoppedTabs]});
    }
    emit('onCDPDetach',source);
  });
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id)return false;
    // Same original predicates, lease lookup and backend handlers as zm().
    if(upstream.isAgentBackgroundPopup(message)){
      const tab=sender.tab?.id;if(typeof tab!=='number')return false;
      core().handleAgentBackgroundPopup(tab,message.url).then(()=>reply({ok:true})).catch(()=>reply({ok:false}));
      return true;
    }
    if(message?.type==='codex:page-event'&&upstream.isPageEvent(message.event)){
      const tab=sender.tab?.id;
      if(typeof tab==='number'&&Number.isInteger(tab))upstream.tabLeases().getActiveLease(tab).then(lease=>{
        if(lease)emit('onPageEvent',{...message.event,session_id:lease.sessionId,tabId:tab});
      }).catch(()=>{});
      return false;
    }
    return upstream.handlePageMessage(core(),message,sender,reply);
  });
}

export function resumeOriginalTabs(ids) {
  for(const id of ids){stoppedTabs.delete(id);ownDetaches.delete(id);}
  void chrome.storage.session.set({local_upstream_stopped_tabs:[...stoppedTabs]});
}

// Read the original persisted lease store after its own initialization/mutation barrier.
// No duplicate ownership, handoff or saved-tab state is kept by this adapter.
async function leaseSnapshot(){
  const store=upstream.tabLeases();
  await store.ensureInit();await store.waitForPendingMutations();
  return new Map([...store.leases].map(([id,lease])=>[id,{...lease}]));
}
export async function originalSessionList(){
  await loadControls();
  const leases=await leaseSnapshot();
  const ids=new Set([...controls.keys(),...[...leases.values()].map(lease=>lease.sessionId)]);
  return [...ids].map(id=>({...controls.get(id),id,name:controls.get(id)?.name||'ChatGPT',
    busy:!!activeCalls.get(id),tab_ids:[...leases].filter(([,lease])=>lease.sessionId===id).map(([tab])=>tab)}));
}
export async function pauseOriginalSession(id,paused){
  await loadControls();
  let control=controls.get(id);
  if(!control){
    if(![...(await leaseSnapshot()).values()].some(lease=>lease.sessionId===id))throw new Error('セッションがありません。');
    control={id,name:'ChatGPT',paused:false};controls.set(id,control);
  }
  control.paused=paused;
  await chrome.storage.session.set({local_upstream_controls:[...controls.values()]});
  if(!paused){const leases=await leaseSnapshot();resumeOriginalTabs([...leases].filter(([,lease])=>lease.sessionId===id).map(([tab])=>tab));}
  return {session_id:id,paused};
}

export async function finishOriginalSession(id){
  await loadControls();
  const control=controls.get(id)||{id,name:'ChatGPT',paused:false};
  controls.set(id,control);
  // Fence new RPCs before awaiting lease enumeration or upstream cleanup.
  control.paused=true;
  await saveControls();
  if(activeCalls.get(id))throw new Error('操作中です。完了してから終了してください。');
  // Persisted upstream leases also recover turn IDs after a service-worker restart.
  const leases=await upstream.tabLeases().getSessionActiveLeases(id);
  const turns=new Set([...(control.turn_ids||[]),...[...leases.values()].map(x=>x.turnId)]);
  for(const turn_id of turns)await originalRpc({method:'turnEnded',session_id:id,turn_id});
}

export async function finishDisconnectedSessions(){
  await loadControls();
  const sessions=await originalSessionList();
  const results=await Promise.allSettled(sessions.map(session=>finishOriginalSession(session.id)));
  const failure=results.find(x=>x.status==='rejected');
  if(failure)throw failure.reason;
}

export async function originalTabInventory(){
  await loadControls();
  const leases=await leaseSnapshot();
  const tabs=await chrome.tabs.query({});
  const config=await chrome.storage.local.get('max_agent_tabs');
  const limit=Number.isInteger(config.max_agent_tabs)&&config.max_agent_tabs>0?config.max_agent_tabs:32;
  const items=tabs.map(tab=>{
    const lease=leases.get(tab.id),control=lease&&controls.get(lease.sessionId);
    const protectedTab=lease?.mark==='deliverable'||lease?.mark==='handoff'||lease?.state==='handoff';
    return {id:tab.id,title:tab.title||'無題',url:tab.url||'',session_name:control?.name,
      kind:protectedTab?'保存・引き継ぎ':lease?.origin==='agent'?'自動化':'既存・所有者不明',
      selectable:!protectedTab&&(!lease||!!control?.paused)&&!activeCalls.get(lease?.sessionId),
      protected:protectedTab,agent:lease?.origin==='agent'};
  });
  return {total:items.length,agent_count:items.filter(x=>x.agent).length,limit,tabs:items};
}

export async function closeSelectedTabs(selected){
  if(!Array.isArray(selected)||!selected.length)throw new Error('閉じるタブを選択してください。');
  const inventory=await originalTabInventory();
  const validated=selected.map(value=>{
    const tab=inventory.tabs.find(t=>t.id===value.id);
    if(!tab||!tab.selectable||tab.url!==value.url)throw new Error('タブの状態が変わりました。一覧を更新してください。');
    return tab.id;
  });
  await chrome.tabs.remove(validated);
  return {closed:validated.length};
}
