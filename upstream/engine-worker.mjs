// Existing Python tool names are aliases for original browser commands.
// No AX reconstruction, role/name parsing, input or navigation implementation.
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {LocalHost} from './local-host.mjs';
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const host=new LocalHost(send),setup=await host.setup(),snapshots=new Map();
const key=m=>`${m.browser_id}:${m.arguments.session_id}:${m.arguments.tab_id}`;
function validate(m){if(m.arguments.snapshot_id&&m.arguments.snapshot_id!==snapshots.get(key(m)))throw new Error('snapshot_id is stale; inspect the page again');}
function index(m){validate(m);const a=m.arguments;if(a.ref){const at=a.ref.lastIndexOf(':');if(a.ref.slice(0,at)!==snapshots.get(key(m)))throw new Error('Element ref is stale; inspect the page again');return Number(a.ref.slice(at+1));}return a.element_index;}

async function run(m){
  const a={...m.arguments,local_request_id:m.id},action=m.action,browser_id=m.browser_id,tab_id=String(a.tab_id);
  const cmd=(type,params={})=>host.execute({type,browser_id,...params});
  const tab=(type,params={})=>cmd(type,{tab_id,...params});
  const manage=async(namespace,method,...args)=>(await cmd('browser_management_call',{namespace,method,args})).value;
  if(action==='runtime_setup')return setup;
  if(action==='runtime_after_code')return host.afterCode(browser_id,a);
  if(action==='session_end_turn'){
    const result=await host.endTurn(browser_id,a);
    for(const snapshotKey of snapshots.keys())if(snapshotKey.startsWith(`${browser_id}:${a.session_id}:`))snapshots.delete(snapshotKey);
    return result;
  }
  return host.withContext(browser_id,a,async()=>{
    if(action==='browser_command'){
      if(a.native_runtime)return a.with_recovery?host.executeWithRecovery(a.command):host.execute(a.command);
      if(a.command.browser_id&&a.command.browser_id!==browser_id)throw new Error('Browser ID does not match the selected connection');
      return host.execute({...a.command,browser_id});
    }
    if(action==='session_name'){
      return cmd('name_session',{name:a.name});
    }
    if(action==='session_tabs')return (await cmd('list_tabs')).tabs;
    if(action==='windows_list'){
      const windows=await manage('windows','getAll',{windowTypes:['normal']});
      return windows.filter(w=>w.type==='normal'&&!w.incognito&&Number.isSafeInteger(w.id)).map(w=>({id:w.id,focused:w.focused,state:w.state,left:w.left,top:w.top,width:w.width,height:w.height}));
    }
    if(action==='tab_claim'){
      if(a.expected_url!==undefined||a.expected_title!==undefined){
        const current=(await host.browsers.get(browser_id).api.getUserTabs()).find(t=>t.id===Number(tab_id));
        if(!current||a.expected_url!==undefined&&current.url!==a.expected_url||a.expected_title!==undefined&&current.title!==a.expected_title)throw new Error('The tab changed. Inspect the tabs again.');
      }
      return tab('browser_user_claim_tab');
    }
    if(action==='tab_mark')return tab('mark_tab',{status:a.status});
    if(action==='group_create'||action==='group_update'){
      const group=action==='group_create'?await manage('tabs','group',{tabIds:a.tab_ids}):a.group_id;
      const changes={};for(const field of ['title','color','collapsed'])if(a[field]!==undefined&&a[field]!==null)changes[field]=a[field];
      if(Object.keys(changes).length)await manage('tabGroups','update',group,changes);
      return manage('tabGroups','get',group);
    }
    if(action==='tabs_ungroup'){await manage('tabs','ungroup',a.tab_ids);return {ungrouped:a.tab_ids};}
    if(action==='tab_open'||action==='google_search'){
      const created=a.tab_id===undefined?await cmd('create_tab'):await tab('browser_user_claim_tab');
      const id=String(created.id);
      await cmd('navigate_tab_url',{tab_id:id,url:action==='google_search'?'https://www.google.com/search?q='+encodeURIComponent(a.query):a.url});
      if(action==='google_search'){
        await cmd('playwright_locator_wait_for',{tab_id:id,selector:'#rso h3',state:'visible',timeout_ms:20000});
        const max=Math.min(Math.max(Number(a.max_results)||10,1),20);
        const script=`return Array.from(document.querySelectorAll('#rso h3')).filter(h=>h.getClientRects().length>0).slice(0,${max}).map(h=>{const link=h.closest('a');const card=h.closest('.MjjYud')||link?.parentElement?.parentElement;return {title:(h.innerText||h.textContent||'').trim(),url:link?.href||'',snippet:(card?.innerText||'').trim().slice(0,500)}}).filter(r=>r.title&&r.url);`;
        const result=await cmd('playwright_evaluate',{tab_id:id,script});
        const current=await manage('tabs','get',Number(id));
        const response={tab:{...await cmd('get_tab',{tab_id:id}),window_id:current.windowId},results:result.value??[],count:(result.value??[]).length};
        if(a.include_ax===true)response.ax=(await cmd('tab_ax_get_state',{tab_id:id,content:'axState'})).state;
        return response;
      }
      const current=await manage('tabs','get',Number(id));
      return {...await cmd('get_tab',{tab_id:id}),window_id:current.windowId};
    }
    const simple={tab_navigate:'navigate_tab_url',tab_reload:'navigate_tab_reload',tab_back:'navigate_tab_back',tab_forward:'navigate_tab_forward',tab_close:'close_tab'};
    if(simple[action]){await tab(simple[action],action==='tab_navigate'?{url:a.url}:{});return action==='tab_close'?{closed:true}:tab('get_tab');}
    if(action==='tab_focus'){await host.browsers.get(browser_id).api.sendSessionRequest('focusTab',{tabId:Number(tab_id)});return tab('get_tab');}
    if(action==='page_snapshot'||action==='page_ax_state'){
      const capture=await tab('tab_ax_get_state',{content:'axState',disable_diffing:action==='page_snapshot'||a.disable_diffing===true});
      const snapshot_id=randomUUID();snapshots.set(key(m),snapshot_id);
      return {engine:'upstream',...capture,ax_tree:capture.state,text:capture.state,snapshot_id,...await tab('get_tab')};
    }
    if(action==='screenshot'){
      if(a.wait_until&&a.wait_until!=='none')await tab('playwright_wait_for_load_state',{state:a.wait_until,timeout_ms:20000});
      const capture=await tab('tab_screenshot',{fullPage:a.full_page===true});
      const signature=Buffer.from(capture.data.slice(0,24),'base64');
      const mime=signature[0]===0xff&&signature[1]===0xd8?'image/jpeg':'image/png';
      return {tab_id:Number(tab_id),data_url:`data:${mime};base64,`+capture.data};
    }
    if(action==='page_wait_for'){await tab('playwright_locator_wait_for',{selector:a.selector,state:a.state||'visible',timeout_ms:a.timeout_ms});return {found:true};}
    if(action==='page_select'){await tab('playwright_locator_select_option',{selector:a.selector,selections:a.selections});return {selected:true};}
    if(action==='page_check'){await tab('playwright_locator_set_checked',{selector:a.selector,checked:a.checked});return {checked:a.checked};}
    if((action==='page_click'||action==='page_fill')&&a.selector){
      await tab(action==='page_click'?'playwright_locator_click':'playwright_locator_fill',{selector:a.selector,value:a.value,replace:true,timeout_ms:a.timeout_ms,button:a.button,modifiers:a.modifiers});
      return action==='page_click'?{clicked:true}:{filled:true};
    }
    const actions={
      page_click:()=>({kind:'click',target:index(m),mouse_button:a.button,click_count:a.click_count??1}),
      page_fill:()=>({kind:'set_value',element_index:index(m),value:a.value}),
      page_key:()=>({kind:'press_key',element_index:a.element_index??null,key:a.key}),
      page_type:()=>({kind:'type_text',element_index:a.element_index??null,text:a.text}),
      page_drag:()=>({kind:'drag',from:a.from,to:a.to}),
      page_secondary:()=>({kind:'perform_secondary_action',element_index:a.element_index,action:a.action}),
      page_ax_action:()=>{validate(m);return a.action;},
    };
    if(action==='page_scroll')throw new Error('Use browser_ax_action scroll with the original target/direction/pages contract.');
    if(actions[action]){
      return tab('tab_ax_action',{action:actions[action]()});
    }
    throw new Error('Unsupported browser action: '+action);
  });
}
// Original JS starts event waits before sending the triggering command.
// The host's AsyncLocalStorage retains request metadata for concurrent calls.
readline.createInterface({input:process.stdin}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.type==='rpc_result'){host.result(m);return;}
  if(m.type==='elicitation_result'){host.elicitationResult(m);return;}
  if(m.type==='event'){host.event(m.browser_id,m.name,m.value);return;}
  if(m.type==='call')void run(m).then(result=>send({type:'result',id:m.id,result}),e=>send({type:'result',id:m.id,error:String(e?.stack||e)}));
});
