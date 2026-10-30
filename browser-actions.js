import {pageAction} from "./page-actions.js";
import {setSessionName, checkSession, touchTab, claimTab, markTab, managedTabs, endTurn, sessionList} from "./sessions.js";

export function httpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("http/httpsのURLを指定してください。");
  if (url.username || url.password) throw new Error("URL内の認証情報には対応していません。");
  return url.href;
}

export function tabId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("有効なtab_idを指定してください。");
  return value;
}

const info = tab => ({id: tab.id, window_id: tab.windowId, group_id: tab.groupId ?? -1, index: tab.index, pinned: Boolean(tab.pinned), title: tab.title, url: tab.url || tab.pendingUrl, active: tab.active, status: tab.status, ...(tab.origin ? {origin:tab.origin, mark:tab.mark} : {})});

export async function waitForTab(id, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("ページの読み込みがタイムアウトしました。")), timeoutMs);
    function finish(error, tab) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      error ? reject(error) : resolve(tab);
    }
    function updated(changed, delta, tab) {
      if (changed === id && delta.status === "complete") finish(null, tab);
    }
    function removed(changed) {
      if (changed === id) finish(new Error("対象タブが閉じられました。"));
    }
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(id).then(tab => {
      if (tab.status === "complete") finish(null, tab);
    }).catch(finish);
  });
}

async function page(id, operation, params) {
  const tab = await chrome.tabs.get(tabId(id));
  httpUrl(tab.url);
  const frame = params.frame_id ?? 0;
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error("frame_idは非負の整数で指定してください。");
  const results = await chrome.scripting.executeScript({
    target: {tabId: tab.id, frameIds: [frame]}, world: "ISOLATED",
    func: pageAction, args: [{...params, operation}],
  });
  if (results[0]?.error) throw new Error(results[0].error.message || "Page action failed");
  if (!results.length) throw new Error("ページから応答がありません。");
  return results[0].result;
}

export async function dispatch(action, params = {}) {
  if (action === "session_list") return sessionList();
  if (action === "session_name") return setSessionName(params);
  if (action === "session_end_turn") return endTurn(params);
  await checkSession(params);
  if (action === "tab_claim") return claimTab(params);
  if (action === "tab_mark") return markTab(params);
  if (action === "session_tabs") return (await managedTabs(params)).map(info);
  if (action === "groups_list") return chrome.tabGroups.query({});
  if (action === "group_create" || action === "group_update") {
    let id = params.group_id;
    if (action === "group_create") {
      if (!Array.isArray(params.tab_ids) || !params.tab_ids.length) throw new Error("tab_idsを指定してください。");
      const tabs = await Promise.all(params.tab_ids.map(id => chrome.tabs.get(tabId(id))));
      if (new Set(tabs.map(tab => tab.windowId)).size !== 1) throw new Error("異なるウィンドウのタブは一緒にグループ化できません。");
      if (tabs.some(tab => tab.pinned)) throw new Error("固定タブはグループに移動できません。");
      id = await chrome.tabs.group({tabIds: params.tab_ids, createProperties: {windowId: tabs[0].windowId}});
    }
    if (!Number.isSafeInteger(id) || id < 0) throw new Error("有効なgroup_idを指定してください。");
    const changes = {};
    for (const key of ["title", "color", "collapsed"]) if (params[key] !== undefined && params[key] !== null) changes[key] = params[key];
    await chrome.tabGroups.update(id, changes);
    return chrome.tabGroups.get(id);
  }
  if (action === "tabs_ungroup") {
    if (!Array.isArray(params.tab_ids) || !params.tab_ids.length) throw new Error("tab_idsを指定してください。");
    await chrome.tabs.ungroup(params.tab_ids.map(tabId));
    return {ungrouped: params.tab_ids};
  }
  if (action === "tabs_list") return (await chrome.tabs.query({})).map(info);
  if (params.tab_id !== undefined) await touchTab(tabId(params.tab_id), params);
  if (action === "tab_open") {
    const tab = await chrome.tabs.create({url: httpUrl(params.url), active: params.active !== false});
    await touchTab(tab.id, params, "agent");
    return info(await waitForTab(tab.id));
  }
  if (action === "google_search") {
    if (typeof params.query !== "string" || !params.query.trim()) throw new Error("検索語を指定してください。");
    const url = "https://www.google.com/search?q=" + encodeURIComponent(params.query);
    const tab = params.tab_id === undefined
      ? await chrome.tabs.create({url, active: true})
      : await chrome.tabs.update(tabId(params.tab_id), {url, active: true});
    await touchTab(tab.id, params, params.tab_id === undefined ? "agent" : "user");
    const loaded = await waitForTab(tab.id);
    if (params.wait_for_results !== false) await page(tab.id, "wait", {selector: "#rso h3", timeout_ms: 12000});
    const snapshot = await page(tab.id, "snapshot", {max_chars: 12000, max_elements: 80});
    if (new URL(snapshot.url).hostname !== "www.google.com" || new URL(snapshot.url).searchParams.get("q") !== params.query) throw new Error("検索結果URLを確認できません。CAPTCHAや別ページになっていないか確認してください。");
    return {tab: info(loaded), snapshot};
  }
  if (action === "tab_navigate") {
    const tab = await chrome.tabs.update(tabId(params.tab_id), {url: httpUrl(params.url)});
    return info(await waitForTab(tab.id));
  }
  if (action === "tab_close") {
    await chrome.tabs.remove(tabId(params.tab_id));
    return {closed: true};
  }
  if (["tab_reload", "tab_back", "tab_forward"].includes(action)) {
    const id = tabId(params.tab_id);
    await chrome.tabs.get(id);
    await chrome.tabs[{tab_reload: "reload", tab_back: "goBack", tab_forward: "goForward"}[action]](id);
    return info(await waitForTab(id));
  }
  if (action === "tab_focus" || action === "screenshot") {
    const tab = await chrome.tabs.get(tabId(params.tab_id));
    if (action === "screenshot") httpUrl(tab.url);
    await chrome.windows.update(tab.windowId, {focused: true});
    await chrome.tabs.update(tab.id, {active: true});
    if (action === "tab_focus") return info(await chrome.tabs.get(tab.id));
    // Let the selected page paint its latest DOM before capturing the viewport.
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:"ISOLATED",func:async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }});
    const before = (await chrome.tabs.query({active: true, windowId: tab.windowId}))[0];
    if (before?.id !== tab.id) throw new Error("撮影前に選択タブが変更されました。");
    const data_url = await chrome.tabs.captureVisibleTab(tab.windowId, {format: "png"});
    const after = (await chrome.tabs.query({active: true, windowId: tab.windowId}))[0];
    if (after?.id !== tab.id) throw new Error("撮影中に選択タブが変更されました。撮影結果は破棄しました。");
    return {tab_id: tab.id, data_url};
  }
  const operations = {page_snapshot: "snapshot", page_click: "click", page_fill: "fill", page_scroll: "scroll", page_wait_for: "wait"};
  if(action==='page_ax_state'){const view=await page(params.tab_id,'snapshot',params);return {state:view.ax_tree,snapshot_id:view.snapshot_id};}
  if (operations[action]) return page(params.tab_id, operations[action], params);
  throw new Error("Unknown browser action");
}
