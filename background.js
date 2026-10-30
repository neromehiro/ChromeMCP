import {dispatch} from "./extension-inventory.js";
import {originalRpc,connectOriginalEvents,originalSessionList,pauseOriginalSession,originalTabInventory,closeSelectedTabs,finishOriginalSession,finishDisconnectedSessions} from './upstream-adapter.js';
import {sendBounded} from './transport-buffer.js';

let socket = null;
let heartbeat = null;
let reconnectTimer = null;
let queue = Promise.resolve();
let connectionTask = Promise.resolve();
let connectionEpoch = 0;
let disconnectedAt=Date.now();
const disconnectedReady=chrome.storage.session.get('bridge_disconnected_at').then(async saved=>{
  disconnectedAt=saved.bridge_disconnected_at??disconnectedAt;
  await chrome.storage.session.set({bridge_disconnected_at:disconnectedAt});
});
let recoveryRequired=false;
let state = {connected: false, endpoint: "", last_error: "", instance_id: "", label: "Chrome"};

async function setBadge(connected) {
  await chrome.action.setBadgeText({text: connected ? "ON" : "OFF"});
  await chrome.action.setBadgeBackgroundColor({color: connected ? "#137b5b" : "#777777"});
}

function send(connection, value) {
  return sendBounded(connection,value,()=>{
    recoveryRequired=true;
    state.last_error='通信が滞留したため操作を停止しました。セッションを解放して再接続します。';
  });
}

function connect() {
  connectionTask = connectionTask.then(connectOnce).catch(error => { state.last_error = String(error.message || error); });
  return connectionTask;
}

async function connectOnce() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  await disconnectedReady;
  if(recoveryRequired||(disconnectedAt!==null&&Date.now()-disconnectedAt>=45000)){
    await finishDisconnectedSessions();
    recoveryRequired=false;
    disconnectedAt=Date.now();
    await chrome.storage.session.set({bridge_disconnected_at:disconnectedAt});
  }
  const epoch = connectionEpoch;
  const config = await chrome.storage.local.get(["instance_id", "label", "port", "enabled"]);
  if (epoch !== connectionEpoch) return;
  if (config.enabled === false) return;
  const instance = config.instance_id || crypto.randomUUID();
  // The original getInfo/profile reader uses this storage key.
  await chrome.storage.local.set({instance_id: instance,extensionInstanceId:instance});
  if (epoch !== connectionEpoch) return;
  const port = Number(config.port) || 8766;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid bridge port");
  state = {...state, instance_id: instance, label: config.label || "Chrome", endpoint: `ws://127.0.0.1:${port}/extension`};
  const connection = new WebSocket(state.endpoint);
  socket = connection;
  connection.onopen = () => {
    send(connection, {type: "hello", protocol: 1, instance_id: instance, label: state.label, version: chrome.runtime.getManifest().version});
    heartbeat = setInterval(() => send(connection, {type: "heartbeat"}), 20000);
  };
  connection.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "welcome") {
      state.connected = true;
      disconnectedAt=null;
      void chrome.storage.session.set({bridge_disconnected_at:null});
      state.last_error = "";
      void setBadge(true);
    } else if (message.type === "command") {
      const execute = async () => {
        if(socket!==connection||connection.readyState!==WebSocket.OPEN)return;
        try {
          const result = message.action==='upstream_rpc' ? await originalRpc(message.params) : await dispatch(message.action, message.params);
          send(connection, {type: "response", id: message.id, result});
        } catch (error) {
          send(connection, {type: "response", id: message.id, error: error.rpcError || {code: "ACTION_FAILED", message: String(error.message || error)}});
        }
      };
      // Original JSON-RPC handles requests concurrently. CDP may pause a new
      // target during Page.navigate; its resume request must not queue behind it.
      if(message.action==='upstream_rpc')void execute().catch(error=>{state.last_error=String(error.message||error);});
      else queue=queue.then(execute).catch(error=>{state.last_error=String(error.message||error);});
    }
  };
  connection.onerror = () => { state.last_error = "ローカルサーバーに接続できません。起動状態とポートを確認してください。"; };
  connection.onclose = () => {
    if (socket !== connection) return;
    socket = null;
    state.connected = false;
    disconnectedAt ??= Date.now();
    void chrome.storage.session.set({bridge_disconnected_at:disconnectedAt});
    clearInterval(heartbeat);
    heartbeat = null;
    void setBadge(false);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { void connect(); }, 3000);
  };
}

function disconnect() {
  connectionEpoch++;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeat);
  const old = socket;
  socket = null;
  old?.close();
  state.connected = false;
  disconnectedAt ??= Date.now();
  void chrome.storage.session.set({bridge_disconnected_at:disconnectedAt});
  void setBadge(false);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === "status") {
    originalSessionList().then(sessions => reply({...state, sessions, extension_id: chrome.runtime.id, version: chrome.runtime.getManifest().version})).catch(error=>reply({...state,error:error.message}));
    return true;
  }
  if(['tab_inventory','close_selected_tabs','session_end'].includes(message.type)){
    if(sender.url!==chrome.runtime.getURL('popup.html')){reply({error:'拡張のポップアップから操作してください。'});return false;}
    const operation=message.type==='tab_inventory'?originalTabInventory:
      message.type==='session_end'?()=>finishOriginalSession(message.session_id):()=>closeSelectedTabs(message.tabs);
    Promise.resolve().then(operation).then(value=>reply(value||{ok:true})).catch(error=>reply({error:error.message}));
    return true;
  }
  if (message.type === "session_pause") {
    // Resume is a human action in the popup; no MCP command can override Stop.
    if (message.paused !== true && sender.url!==chrome.runtime.getURL('popup.html')) { reply({error:"ポップアップから再開してください。"}); return false; }
    pauseOriginalSession(message.session_id,message.paused === true).then(reply).catch(error=>reply({error:error.message}));
    return true;
  }
  if (message.type === "reconnect") {
    disconnect();
    connect().then(() => reply({ok: true})).catch(error => reply({error: error.message}));
    return true;
  }
  if (message.type === "pause") { disconnect(); reply({ok: true}); return false; }
  return false;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if(alarm.name!=='bridge-reconnect')return;
  void connect();
});
chrome.runtime.onStartup.addListener(() => { void connect(); });
chrome.runtime.onInstalled.addListener(() => { void connect(); });
void chrome.alarms.create("bridge-reconnect", {periodInMinutes: 0.5});
void connect();
connectOriginalEvents((name,value)=>{if(socket)send(socket,{type:'upstream_event',name,value});});
