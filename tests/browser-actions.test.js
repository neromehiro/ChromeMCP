import test from "node:test";
import assert from "node:assert/strict";
import {dispatch, httpUrl, tabId, waitForTab} from "../browser-actions.js";

function event() {
  const listeners = new Set();
  return {listeners, addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback), emit: (...args) => { for (const callback of [...listeners]) callback(...args); }};
}

test("only normal website URLs and integer tab IDs are accepted", () => {
  assert.equal(httpUrl("https://example.com"), "https://example.com/");
  for (const url of ["chrome://settings", "file:///tmp/private", "javascript:alert(1)", "https://user:password@example.com"]) assert.throws(() => httpUrl(url));
  for (const id of [undefined, -1, 2.2, "1"]) assert.throws(() => tabId(id));
});

test("load completion is observed even if it finishes before get returns", async () => {
  const onUpdated = event(), onRemoved = event();
  globalThis.chrome = {tabs: {onUpdated, onRemoved, get: async id => {
    assert.equal(onUpdated.listeners.size, 1);
    return {id, status: "complete"};
  }}};
  assert.equal((await waitForTab(17, 1000)).id, 17);
  assert.equal(onUpdated.listeners.size, 0);
  assert.equal(onRemoved.listeners.size, 0);
});

test("closing the target tab cancels its loading wait and cleans listeners", async () => {
  const onUpdated = event(), onRemoved = event();
  globalThis.chrome = {tabs: {onUpdated, onRemoved, get: async id => ({id, status: "loading"})}};
  const waiting = waitForTab(17, 1000);
  onRemoved.emit(17);
  await assert.rejects(waiting, /閉じられました/);
  assert.equal(onUpdated.listeners.size, 0);
  assert.equal(onRemoved.listeners.size, 0);
});

test("Google search encodes Japanese and waits for actual result elements", async () => {
  const onUpdated = event(), onRemoved = event();
  let requestedUrl;
  const operations = [];
  globalThis.chrome = {
    tabs: {onUpdated, onRemoved,
      create: async params => {requestedUrl = params.url; return {id: 5};},
      get: async id => ({id, windowId: 1, title: "こんにちは - Google 検索", url: requestedUrl, status: "complete"})},
    scripting: {executeScript: async params => {
      const operation = params.args[0].operation; operations.push(operation);
      return [{result: operation === "wait" ? {found: true} : {url: requestedUrl, title: "こんにちは - Google 検索", text: "こんにちは"}}];
    }},
  };
  const result = await dispatch("google_search", {query: "こんにちは & hello"});
  assert.equal(new URL(requestedUrl).searchParams.get("q"), "こんにちは & hello");
  assert.deepEqual(operations, ["wait", "snapshot"]);
  assert.equal(result.tab.id, 5);
});

test("screenshot is discarded if the active tab changes", async () => {
  let queries = 0;
  globalThis.chrome = {
    scripting: {executeScript: async () => []},
    tabs: {get: async () => ({id: 5, windowId: 1, url: "https://example.com"}), update: async () => ({}),
      query: async () => [{id: ++queries === 1 ? 5 : 6}], captureVisibleTab: async () => "data:image/png;base64,AA=="},
    windows: {update: async () => ({})},
  };
  await assert.rejects(dispatch("screenshot", {tab_id: 5}), /破棄/);
});
