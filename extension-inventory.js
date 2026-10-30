// Read-only Chrome metadata for connection diagnostics. Page operations never
// enter this module; they use the original browser runtime and extension core.
import {originalSessionList} from './upstream-adapter.js';
export async function dispatch(action){
  if(action==='session_list')return originalSessionList();
  if(action==='groups_list')return chrome.tabGroups.query({});
  if(action==='tabs_list')return (await chrome.tabs.query({})).map(t=>({id:t.id,window_id:t.windowId,group_id:t.groupId,index:t.index,title:t.title,url:t.url||t.pendingUrl,active:t.active,status:t.status,pinned:t.pinned}));
  throw new Error('This operation requires the original runtime. Update/restart the Python bridge.');
}
