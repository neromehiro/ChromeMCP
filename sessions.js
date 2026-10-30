const STORAGE = "bridge_sessions_v2";
const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
let sessions = new Map();
let initialized = null;

async function init() {
  initialized ||= (async () => {
    const saved = (await chrome.storage.local.get(STORAGE))[STORAGE] || [];
    sessions = new Map(saved.map(item => [item.id, {...item, groups: new Map(item.groups), tabs: new Map(item.tabs)}]));
  })();
  await initialized;
}
async function save() {
  await chrome.storage.local.set({[STORAGE]: Array.from(sessions.values(), item => ({...item, groups: [...item.groups], tabs: [...item.tabs]}))});
}

function overlay(sessionId, name, paused, remove) {
  if (remove) {
    globalThis.__LOCAL_BRIDGE_OVERLAY__?.host.remove();
    delete globalThis.__LOCAL_BRIDGE_OVERLAY__;
    return;
  }
  let state = globalThis.__LOCAL_BRIDGE_OVERLAY__;
  if (!state || !state.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute('aria-hidden','true');
    host.style.cssText = "position:fixed;right:16px;top:16px;z-index:2147483647;";
    const shadow = host.attachShadow({mode:"closed"});
    const box = document.createElement("div");
    box.style.cssText = "display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #137b5b;border-radius:12px;background:white;box-shadow:0 4px 20px #0002;color:#153e30;font:13px system-ui;";
    const label = document.createElement("span");
    const stop = document.createElement("button");
    stop.textContent = "停止";
    stop.style.cssText = "border:0;border-radius:6px;background:#f0ded9;color:#7a281d;padding:5px 10px;cursor:pointer;";
    state = {host, label, sessionId};
    stop.addEventListener("click", () => { void chrome.runtime.sendMessage({type:"session_pause",session_id:state.sessionId,paused:true}); });
    box.append(label, stop); shadow.append(box); document.documentElement.append(host);
    globalThis.__LOCAL_BRIDGE_OVERLAY__ = state;
  }
  state.sessionId = sessionId;
  state.label.textContent = `${paused ? "⏸ 停止中" : "● AI操作中"} · ${name}`;
}
async function updateOverlay(tabId, item, remove = false) {
  if (!chrome.scripting) return;
  try { await chrome.scripting.executeScript({target:{tabId},world:"ISOLATED",func:overlay,args:[item.id,item.name,item.paused,remove]}); } catch { /* restricted page or still loading */ }
}
async function session(params) {
  await init();
  const id = params.session_id;
  if (typeof id !== "string" || !id || id.length > 128) throw new Error("session_idを指定してください。");
  let item = sessions.get(id);
  if (!item) {
    item = {id, name: "ChatGPT", paused: false, turn_id: null, groups: new Map(), tabs: new Map()};
    sessions.set(id, item);
  }
  const turn = params.turn_id || "default";
  if (item.turn_id !== turn) {
    for (const lease of item.tabs.values()) lease.mark = null;
    item.turn_id = turn;
  }
  return item;
}

export async function sessionList() {
  await init();
  return Array.from(sessions.values(), item => ({id: item.id, name: item.name, paused: item.paused, tab_ids: [...item.tabs.keys()], group_ids: [...item.groups.values()]}));
}

export async function setSessionName(params) {
  const item = await session(params);
  if (typeof params.name !== "string" || !params.name.trim()) throw new Error("セッション名を指定してください。");
  item.name = params.name.trim().slice(0, 120);
  for (const id of item.groups.values()) {
    try { await chrome.tabGroups.update(id, {title: item.name}); } catch { /* closed group */ }
  }
  for (const id of item.tabs.keys()) await updateOverlay(id,item);
  await save();
  return {session_id: item.id, name: item.name};
}

export async function pauseSession(id, paused) {
  await init();
  const item = sessions.get(id);
  if (!item) throw new Error("セッションがありません。");
  item.paused = paused;
  for (const tabId of item.tabs.keys()) await updateOverlay(tabId,item);
  await save();
  return {session_id: id, paused};
}

export async function checkSession(params) {
  if (!params.session_id) return;
  const item = await session(params);
  if (item.paused) throw new Error("ユーザーがブラウザ操作を停止しました。拡張のポップアップから再開してください。");
}

export async function touchTab(id, params, origin = "user") {
  if (!params.session_id) return;
  const item = await session(params);
  if (item.paused) throw new Error("ユーザーがブラウザ操作を停止しました。");
  for (const other of sessions.values()) {
    if (other.id !== item.id && other.tabs.has(id)) throw new Error("このタブは別のブラウザセッションが操作中です。");
  }
  if (!item.tabs.has(id)) item.tabs.set(id, {origin, mark: null, turn_id: item.turn_id});
  else item.tabs.get(id).turn_id = item.turn_id;
  const tab = await chrome.tabs.get(id);
  if (origin === "agent") {
    let group = item.groups.get(tab.windowId);
    if (group !== undefined) {
      try { await chrome.tabGroups.get(group); } catch { group = undefined; }
    }
    if (group === undefined) {
      group = await chrome.tabs.group({tabIds: [id], createProperties: {windowId: tab.windowId}});
      await chrome.tabGroups.update(group, {title: item.name, color: COLORS[Math.floor(Math.random() * COLORS.length)]});
      item.groups.set(tab.windowId, group);
    } else await chrome.tabs.group({groupId: group, tabIds: [id]});
  }
  await save();
  await updateOverlay(id,item);
}

export async function claimTab(params) {
  const tab = await chrome.tabs.get(params.tab_id);
  if (params.expected_url !== undefined && params.expected_url !== tab.url) throw new Error("タブのURLが変わっています。一覧を取り直してください。");
  if (params.expected_title !== undefined && params.expected_title !== tab.title) throw new Error("タブのタイトルが変わっています。一覧を取り直してください。");
  await touchTab(tab.id, params, "user");
  return {id: tab.id, title: tab.title, url: tab.url, group_id: tab.groupId, origin: "user"};
}

export async function markTab(params) {
  if (!["deliverable", "handoff"].includes(params.status)) throw new Error("statusはdeliverableまたはhandoffです。");
  await touchTab(params.tab_id, params);
  const item = await session(params);
  item.tabs.get(params.tab_id).mark = params.status;
  await save();
  return {tab_id: params.tab_id, status: params.status};
}

export async function managedTabs(params) {
  const item = await session(params);
  const result = [];
  for (const [id, lease] of item.tabs) {
    try { result.push({...await chrome.tabs.get(id), origin: lease.origin, mark: lease.mark}); }
    catch { item.tabs.delete(id); }
  }
  await save();
  return result;
}

export async function endTurn(params) {
  await init();
  const item = sessions.get(params.session_id);
  if (!item || (params.turn_id && item.turn_id !== params.turn_id)) return {closed: [], kept: [], released: []};
  const result = {closed: [], kept: [], released: []};
  for (const [id, lease] of [...item.tabs]) {
    let tab;
    try { tab = await chrome.tabs.get(id); } catch { item.tabs.delete(id); continue; }
    await updateOverlay(id,item,true);
    if (lease.mark === "handoff") { result.kept.push(id); continue; }
    if (lease.mark === "deliverable") {
      if ([...item.groups.values()].includes(tab.groupId)) await chrome.tabs.ungroup(id);
      result.kept.push(id);
    } else if (lease.origin === "agent") {
      await chrome.tabs.remove(id);
      result.closed.push(id);
    } else result.released.push(id);
    item.tabs.delete(id);
  }
  for (const [window, group] of [...item.groups]) {
    try { await chrome.tabGroups.get(group); } catch { item.groups.delete(window); }
  }
  item.turn_id = null;
  if (!item.tabs.size) sessions.delete(item.id);
  await save();
  return result;
}
