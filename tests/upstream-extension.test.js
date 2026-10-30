import test from 'node:test';
import assert from 'node:assert/strict';

function event(){const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:(...args)=>{for(const f of listeners)f(...args);}};}
function storage(){const data={};return {get:async keys=>keys===null?{...data}:Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,data[k]])),set:async value=>Object.assign(data,value),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete data[k];}};}

test('unchanged upstream extension owns tabs, groups agents and finalizes leases',async()=>{
  Object.defineProperty(globalThis,'navigator',{value:{userAgent:'Mozilla/5.0 Chrome/140.0.0.0'},configurable:true});
  const tabs=new Map(),groups=new Map();let id=10,group=100;
  globalThis.chrome={
    runtime:{id:'test-extension',getURL:path=>'chrome-extension://test-extension/'+path,getManifest:()=>({version:'0.3.0'}),sendMessage:async()=>({ok:true}),onMessage:event()},
    storage:{local:storage(),session:storage(),onChanged:event()},
    scripting:{executeScript:async()=>[{result:false}]},
    windows:{WINDOW_ID_NONE:-1,getAll:async()=>[{id:1,focused:true}],update:async(id,args)=>({id,...args}),onFocusChanged:event()},
    debugger:{onDetach:event(),onEvent:event(),detach:async()=>{},sendCommand:async()=>({})},
    tabs:{
      onRemoved:event(),onReplaced:event(),onUpdated:event(),onActivated:event(),
      query:async filters=>[...tabs.values()].filter(t=>filters?.groupId===undefined||filters.groupId===t.groupId),
      get:async id=>{if(!tabs.has(id))throw new Error('closed');return {...tabs.get(id)};},
      create:async args=>{const tab={...args,id:id++,windowId:args.windowId??1,groupId:-1,status:'complete',title:'Test'};tabs.set(tab.id,tab);return {...tab};},
      update:async(id,args)=>Object.assign(tabs.get(id),args),
      group:async args=>{const gid=args.groupId??group++;if(!groups.has(gid))groups.set(gid,{id:gid});for(const id of Array.isArray(args.tabIds)?args.tabIds:[args.tabIds])tabs.get(id).groupId=gid;return gid;},
      ungroup:async ids=>{for(const id of Array.isArray(ids)?ids:[ids])tabs.get(id).groupId=-1;},
      remove:async ids=>{for(const id of Array.isArray(ids)?ids:[ids]){tabs.delete(id);chrome.tabs.onRemoved.emit(id,{});}},
      sendMessage:async()=>({ok:true}),
    },
    tabGroups:{get:async id=>{if(![...tabs.values()].some(t=>t.groupId===id))throw new Error('removed');return groups.get(id);},update:async(id,args)=>Object.assign(groups.get(id),args),query:async()=>[...groups.values()],onRemoved:event(),onUpdated:event()},
  };
  const {upstream}=await import('../upstream/extension-core.js');
  upstream.featureGate=async()=>false;upstream.webMcpConfig=()=>({enabled:async()=>false});
  const core=new upstream.BrowserBackend({agentPopupInterceptorEnabled:Promise.resolve(false),browserManagementEnabled:Promise.resolve(true)});
  const context={session_id:'native-session',turn_id:'native-turn'};
  await core.nameSession({...context,name:'🔎 Native'});
  const one=await core.createTab(context),two=await core.createTab(context),three=await core.createTab(context);
  assert.equal(tabs.get(one.id).groupId,tabs.get(two.id).groupId);
  assert.equal(groups.get(tabs.get(one.id).groupId).title,'🔎 Native');
  const user=await chrome.tabs.create({url:'https://example.test/user'});tabs.get(user.id).groupId=77;
  await core.claimUserTab({...context,tabId:user.id});
  await core.markTab({...context,tabId:two.id,status:'deliverable'});
  await core.markTab({...context,tabId:three.id,status:'handoff'});
  await core.turnEnded(context);
  assert.equal(tabs.has(one.id),false);
  assert.equal(tabs.get(two.id).groupId,-1);
  assert.notEqual(tabs.get(three.id).groupId,-1);
  assert.equal(tabs.get(user.id).groupId,77);
  const next={...context,turn_id:'next'};
  await core.getTabs(next);
  await core.turnEnded(next);
  assert.equal(tabs.has(three.id),false);
  // Actual original handlers with the App's discovery/focus signatures.
  const {originalRpc}=await import('../upstream-adapter.js');
  const info=await originalRpc({method:'getInfo'});
  assert.equal(info.type,'extension');
  assert.equal(await originalRpc({method:'focusTab',session_id:'unknown',arguments:{tabId:two.id}}),false);
  const adapterContext={session_id:'app-ui-contract',turn_id:'one'};
  const shown=await originalRpc({method:'createTab',...adapterContext});
  assert.equal(await originalRpc({method:'focusTab',session_id:adapterContext.session_id,arguments:{tabId:shown.id}}),true);
  assert.equal(tabs.get(shown.id).active,true);
  await originalRpc({method:'turnEnded',...adapterContext});
  const {originalTabInventory,finishOriginalSession,closeSelectedTabs,pauseOriginalSession}=await import('../upstream-adapter.js');
  const baseline=tabs.size;
  for(let index=0;index<100;index++){
    const ctx={session_id:`repeat-${index}`,turn_id:'one'};
    await originalRpc({method:'createTab',...ctx});
    await finishOriginalSession(ctx.session_id);
    assert.equal(tabs.size,baseline);
    assert.equal((await upstream.tabLeases().getSessionActiveLeases(ctx.session_id)).size,0);
  }
  const protectedContext={session_id:'protected',turn_id:'one'};
  const saved=await originalRpc({method:'createTab',...protectedContext});
  await originalRpc({method:'markTab',...protectedContext,arguments:{tabId:saved.id,status:'deliverable'}});
  await originalRpc({method:'claimUserTab',...protectedContext,arguments:{tabId:user.id}});
  await finishOriginalSession(protectedContext.session_id);
  assert.ok(tabs.has(saved.id));assert.ok(tabs.has(user.id));
  const inventory=await originalTabInventory();
  assert.equal(inventory.tabs.find(t=>t.id===saved.id).agent,false);
  assert.equal(inventory.tabs.find(t=>t.id===saved.id).kind,'既存・所有者不明');
  await chrome.storage.local.set({max_agent_tabs:2});
  const limitContext={session_id:'limited',turn_id:'one'};
  const creates=await Promise.allSettled(Array.from({length:3},()=>originalRpc({method:'createTab',...limitContext})));
  assert.equal(creates.filter(x=>x.status==='fulfilled').length,2);
  assert.match(creates.find(x=>x.status==='rejected').reason.message,/上限2枚/);
  await pauseOriginalSession(limitContext.session_id,true);
  await finishOriginalSession(limitContext.session_id);
  assert.equal((await upstream.tabLeases().getSessionActiveLeases(limitContext.session_id)).size,0);
  const manual=await chrome.tabs.create({url:'https://example.test/manual'});
  await assert.rejects(closeSelectedTabs([{id:manual.id,url:'https://changed.test'}]),/状態が変わりました/);
  await closeSelectedTabs([{id:manual.id,url:manual.url}]);
  assert.ok(!tabs.has(manual.id));
});
