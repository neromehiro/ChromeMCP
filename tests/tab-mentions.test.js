import test from 'node:test';
import assert from 'node:assert/strict';
const event=()=>{const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:(...args)=>{for(const f of listeners)f(...args)}}};
const storage=()=>{const data={};return {get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in data).map(k=>[k,data[k]])),set:async value=>Object.assign(data,value),remove:async()=>{}}};
test('adapter retains original tab-mention provider and its lazy invalidation events',async()=>{
 Object.defineProperty(globalThis,'navigator',{value:{userAgent:'Mozilla/5.0 Chrome/140.0.0.0'},configurable:true});
 globalThis.chrome={
  runtime:{id:'mentions-test',getURL:p=>'chrome-extension://mentions-test/'+p,getManifest:()=>({version:'test'}),onMessage:event()},
  storage:{local:storage(),session:storage(),onChanged:event()},
  windows:{onFocusChanged:event()},tabGroups:{onRemoved:event(),onUpdated:event()},
  tabs:{query:async()=>[],onCreated:event(),onRemoved:event(),onReplaced:event(),onActivated:event(),onUpdated:event(),onMoved:event(),onAttached:event(),onDetached:event()},
  webNavigation:{onCreatedNavigationTarget:event()},downloads:{onCreated:event(),onChanged:event()},debugger:{onEvent:event(),onDetach:event()},
 };
 const {upstream}=await import('../upstream/extension-core.js');
 upstream.featureGate=async()=>false;upstream.webMcpConfig=()=>({enabled:async()=>false});
 const {originalRpc,connectOriginalEvents}=await import('../upstream-adapter.js');
 const notifications=[];connectOriginalEvents((name,value)=>notifications.push({name,value}));
 await originalRpc({method:'getUserTabs',arguments:{limit:10,query:""},session_id:'mentions',turn_id:'one'});
 chrome.tabs.onUpdated.emit(1,{title:'Changed'});
 chrome.tabs.onCreated.emit({id:2});
 await new Promise(r=>setTimeout(r,300));
 assert.deepEqual(notifications,[{name:'onBrowserTabMentionsInvalidated',value:undefined}]);
 notifications.length=0;
 chrome.tabs.onUpdated.emit(1,{status:'complete'});
 await new Promise(r=>setTimeout(r,300));
 assert.deepEqual(notifications,[],'original filter ignores non-mention changes');
});
