import test from "node:test";
import assert from "node:assert/strict";

let serial=0;
async function fixture() {
  const tabs=new Map(),groups=new Map(),overlays=[];let next=100;
  globalThis.chrome={
    scripting:{executeScript:async request=>{overlays.push({tabId:request.target.tabId,remove:request.args[3]});return []; }},
    storage:{local:{get:async()=>({}),set:async()=>{}}},
    tabs:{
      get:async id=>{if(!tabs.has(id))throw new Error("closed");return {...tabs.get(id)};},
      group:async props=>{
        const id=props.groupId??next++;if(!groups.has(id))groups.set(id,{id,windowId:1});
        for(const tab of props.tabIds)tabs.get(tab).groupId=id;return id;
      },
      ungroup:async id=>{tabs.get(id).groupId=-1;},
      remove:async id=>{tabs.delete(id);},
    },
    tabGroups:{get:async id=>{if(![...tabs.values()].some(tab=>tab.groupId===id))throw new Error("group removed");return groups.get(id);},update:async(id,props)=>Object.assign(groups.get(id),props)},
  };
  const api=await import(`../sessions.js?test=${++serial}`);
  const params={session_id:"session",turn_id:"turn1"};
  return {api,params,tabs,groups,overlays};
}

test("new tabs share a session-named group and renaming changes Chrome's title",async()=>{
  const {api,params,tabs,groups}=await fixture();
  for(const id of [1,2])tabs.set(id,{id,windowId:1,groupId:-1});
  await api.setSessionName({...params,name:"🔎 Hello"});
  await api.touchTab(1,params,"agent");await api.touchTab(2,params,"agent");
  assert.equal(tabs.get(1).groupId,tabs.get(2).groupId);
  assert.equal(groups.get(tabs.get(1).groupId).title,"🔎 Hello");
  await api.setSessionName({...params,name:"🔎 Renamed"});
  assert.equal(groups.get(tabs.get(1).groupId).title,"🔎 Renamed");
});

test("claimed user tabs keep their group and survive turn cleanup",async()=>{
  const {api,params,tabs}=await fixture();tabs.set(3,{id:3,windowId:1,groupId:77,url:"https://example.com",title:"Example"});
  await assert.rejects(api.claimTab({...params,tab_id:3,expected_url:"https://changed.test"}),/URLが変わ/);
  await api.claimTab({...params,tab_id:3,expected_url:"https://example.com",expected_title:"Example"});
  assert.equal(tabs.get(3).groupId,77);
  assert.deepEqual((await api.endTurn(params)).released,[3]);
  assert.equal(tabs.get(3).groupId,77);
});

test("end turn closes ephemeral tabs, ungroups deliverables, preserves handoff",async()=>{
  const {api,params,tabs,overlays}=await fixture();
  for(const id of [1,2,3]){tabs.set(id,{id,windowId:1,groupId:-1});await api.touchTab(id,params,"agent");}
  await api.markTab({...params,tab_id:2,status:"deliverable"});
  await api.markTab({...params,tab_id:3,status:"handoff"});
  const result=await api.endTurn(params);
  assert.deepEqual(result.closed,[1]);assert.deepEqual(result.kept,[2,3]);
  assert.equal(tabs.get(2).groupId,-1);assert.notEqual(tabs.get(3).groupId,-1);
  assert.ok(overlays.some(item=>item.tabId===3 && item.remove===true),"handoff has no active overlay after turn ends");
  const next={...params,turn_id:"turn2"};
  await api.touchTab(3,next);
  assert.equal((await api.managedTabs(next))[0].mark,null);
  assert.deepEqual((await api.endTurn(next)).closed,[3]);
});

test("user Stop blocks later agent actions until human resumes",async()=>{
  const {api,params,tabs}=await fixture();tabs.set(1,{id:1,windowId:1,groupId:-1});
  await api.touchTab(1,params,"agent");await api.pauseSession(params.session_id,true);
  await assert.rejects(api.checkSession(params),/ユーザーが/);
  await api.pauseSession(params.session_id,false);await api.checkSession(params);
});
