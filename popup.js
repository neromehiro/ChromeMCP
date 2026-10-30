const $ = id => document.getElementById(id);
const config = await chrome.storage.local.get(["label", "port", "max_agent_tabs"]);
$("label").value = config.label || "Chrome";
$("port").value = config.port || 8768;
$("tab-limit").value=config.max_agent_tabs||32;
let selected=new Map();

async function request(message){
  const result=await chrome.runtime.sendMessage(message);
  if(result?.error)throw new Error(result.error);
  return result;
}
async function showError(operation){
  try{await operation();}catch(error){$("error").textContent=error.message;}
}
async function refreshTabs(){
  const result=await request({type:'tab_inventory'});
  selected.clear();$('close-tabs').disabled=true;$('tabs').replaceChildren();
  $('tab-summary').textContent=`開いているタブ：${result.total}枚 ／ 自動化：${result.agent_count}枚（上限${result.limit}枚）`+
    (result.agent_count>=result.limit?'。不要な作業を終了してください。':'');
  for(const tab of result.tabs){
    const row=document.createElement('label');row.className='tab-row';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.disabled=!tab.selectable;
    const text=document.createElement('span');
    text.textContent=`${tab.title} — ${tab.kind}${tab.session_name?' / '+tab.session_name:''}`;
    row.title=tab.url;
    checkbox.addEventListener('change',()=>{
      if(checkbox.checked)selected.set(tab.id,tab);else selected.delete(tab.id);
      $('close-tabs').disabled=!selected.size;
    });
    row.append(checkbox,text);$('tabs').append(row);
  }
}
$('refresh-tabs').addEventListener('click',()=>showError(refreshTabs));
$('close-tabs').addEventListener('click',()=>showError(async()=>{
  const tabs=[...selected.values()];
  if(!tabs.length||!confirm(`${tabs.length}枚のタブを閉じます。\n${tabs.map(t=>t.title).join('\n')}`))return;
  await request({type:'close_selected_tabs',tabs:tabs.map(({id,url})=>({id,url}))});
  await refreshTabs();await refresh();
}));

async function refresh() {
  const state = await chrome.runtime.sendMessage({type: "status"});
  $("status").textContent = state.connected ? "● ローカルサーバーに接続済み" : "○ 未接続 / 一時停止";
  $("error").textContent = state.last_error;
  $("endpoint").textContent = state.endpoint;
  $("instance").textContent = `Browser ID: ${state.instance_id}\nExtension ID: ${state.extension_id}`;
  $("sessions").replaceChildren();
  for (const session of state.sessions || []) {
    const row=document.createElement("div"); row.className="session";
    const label=document.createElement("span");label.textContent=`${session.name} (${session.tab_ids.length}タブ)`;
    const button=document.createElement("button");button.textContent=session.paused?"再開":"停止";
    button.addEventListener("click",()=>showError(async()=>{await request({type:"session_pause",session_id:session.id,paused:!session.paused});await refresh();await refreshTabs();}));
    const end=document.createElement('button');end.textContent='作業を終了';end.disabled=session.busy;
    end.addEventListener('click',()=>showError(async()=>{
      if(!confirm(`${session.name}を終了します。保存指定のない自動化タブを閉じ、操作接続を解放します。`))return;
      await request({type:'session_end',session_id:session.id});await refresh();await refreshTabs();
    }));
    row.append(label,button,end);$("sessions").append(row);
  }
}
$("connect").addEventListener("click", async () => {
  const port = Number($("port").value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { $("error").textContent = "ポートは1024〜65535で指定してください。"; return; }
  const max_agent_tabs=Number($('tab-limit').value);
  if(!Number.isInteger(max_agent_tabs)||max_agent_tabs<1||max_agent_tabs>512){$('error').textContent='タブ上限は1〜512枚で指定してください。';return;}
  await chrome.storage.local.set({label: $("label").value.trim() || "Chrome", port, enabled: true,max_agent_tabs});
  await chrome.runtime.sendMessage({type: "reconnect"});
  await refresh();
});
$("pause").addEventListener("click", async () => {
  await chrome.storage.local.set({enabled: false});
  await chrome.runtime.sendMessage({type: "pause"});
  await refresh();
});
await refresh();
await showError(refreshTabs);
setInterval(()=>showError(refresh), 5000);
