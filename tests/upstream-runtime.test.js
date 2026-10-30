import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalHost} from '../upstream/local-host.mjs';
import {setupBrowserRuntime} from '../upstream/browser-client.mjs';

test('original client and complete service preserve navigation waits, browser errors and policy denials',async()=>{
  const tabs=new Map(),calls=[];let next=7,failNavigation=false,host;
  host=new LocalHost(message=>{
    calls.push(message.method==='executeCdp'?message.arguments.method:message.method);
    const args=message.arguments;let result={};
    if(message.method==='getInfo')result={type:'extension',family:'chrome',name:'Fixture Chrome'};
    else if(message.method==='createTab'){const tab={id:next++,title:'Fixture',url:'about:blank',active:true};tabs.set(tab.id,tab);result=tab;}
    else if(message.method==='getTabs'||message.method==='getUserTabs')result=[...tabs.values()];
    else if(message.method==='claimUserTab')result=tabs.get(args.tabId);
    else if(message.method==='executeCdp'){
      const id=args.target.tabId,tab=tabs.get(id);
      if(args.method==='Runtime.evaluate')result={result:{value:{href:tab.url,readyState:'complete',painted:true}}};
      if(args.method==='Page.getFrameTree')result={frameTree:{frame:{id:'frame',loaderId:tab.loaderId||'initial',url:tab.url}}};
      if(args.method==='Page.navigate'){
        if(failNavigation)result={errorText:'net::ERR_CONNECTION_REFUSED'};
        else{
          tab.url=args.commandParams.url;tab.loaderId='loaded';result={frameId:'frame',loaderId:'loaded'};
          setTimeout(()=>{
            host.event('fixture','onCDPEvent',{source:{tabId:id},method:'Page.frameNavigated',params:{frame:{id:'frame',loaderId:'loaded',url:tab.url}}});
            host.event('fixture','onCDPEvent',{source:{tabId:id},method:'Page.domContentEventFired',params:{timestamp:1}});
          },40);
        }
      }
    }
    queueMicrotask(()=>host.result({id:message.id,result}));
  });
  const setup=await host.setup(),metadata={session_id:'runtime-test',turn_id:'turn'};
  await host.withContext('fixture',metadata,async()=>{});
  globalThis.nodeRepl={rpc:async(service,request)=>{
    assert.equal(service,'browser');
    if(request.method==='setup')return setup;
    const value=await host.withContext('fixture',metadata,()=>host.execute(request.params));
    return request.method==='executeWithRecovery'?{ok:true,value}:value;
  }};
  const agent=await setupBrowserRuntime(),browser=await agent.browsers.get('fixture');
  await browser.nameSession('Original client');
  const tab=await browser.tabs.new();
  const start=Date.now();await tab.goto('http://127.0.0.1:12345/success');
  assert.ok(Date.now()-start>=35,'goto must wait for the delayed navigation event');
  assert.ok(calls.includes('Page.enable'));
  assert.equal(await tab.url(),'http://127.0.0.1:12345/success');
  failNavigation=true;
  await assert.rejects(()=>tab.goto('http://127.0.0.1:12345/error'),/Browser reported:.*ERR_CONNECTION_REFUSED/);
  const before=calls.filter(c=>c==='Page.navigate').length;
  host.runtime.config.values.requirements={network:{domains:{'127.0.0.1':'deny'}}};
  await assert.rejects(()=>tab.goto('http://127.0.0.1:12345/denied'),/admin-enforced policy|origin policy/);
  assert.equal(calls.filter(c=>c==='Page.navigate').length,before);
  await assert.rejects(()=>host.withContext('fixture',metadata,()=>host.execute({type:'tab_ax_action',browser_id:'fixture',tab_id:tab.id,action:{kind:'click',target:'not-an-index'}})),/invalid_type|Expected number|Expected array/);
});
