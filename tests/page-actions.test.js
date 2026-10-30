import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {pageAction} from "../page-actions.js";

class Input {
  constructor(type = "text", value = "") {
    this.tagName = "INPUT"; this.type = type; this._value = value;
    this.isConnected = true; this.disabled = false; this.readOnly = false;
    this.labels = []; this.events = []; this.clicked = false;
  }
  get value() { return this._value; }
  set value(value) { this._value = value; }
  getAttribute() { return null; }
  getClientRects() { return [{}]; }
  focus() {}
  scrollIntoView() {}
  click() { this.clicked = true; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
}

function environment(elements) {
  if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
  delete globalThis.__LOCAL_CHROME_BRIDGE_V1__;
  globalThis.HTMLInputElement = Input;
  globalThis.HTMLTextAreaElement = class {};
  globalThis.HTMLSelectElement = class {};
  globalThis.InputEvent = class extends Event {};
  globalThis.getComputedStyle = () => ({display: "block", visibility: "visible"});
  globalThis.location = {href: "https://example.com/form"};
  globalThis.document = {title: "Form", body: {innerText: "Test form"}, querySelectorAll: () => elements};
}

test("password values are excluded from page snapshots", async () => {
  environment([new Input("text", "hello"), new Input("password", "secret")]);
  const snapshot = await pageAction({operation: "snapshot"});
  assert.equal(snapshot.elements[0].value, "hello");
  assert.equal(Object.hasOwn(snapshot.elements[1], "value"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});

test("old refs cannot click a different element after a new snapshot", async () => {
  const one = new Input(), two = new Input();
  const elements = [one, two]; environment(elements);
  const original = await pageAction({operation: "snapshot"});
  elements.reverse();
  await pageAction({operation: "snapshot"});
  await assert.rejects(pageAction({operation: "click", ref: original.elements[0].ref}), /古いか不明/);
  assert.equal(one.clicked, false); assert.equal(two.clicked, false);
});

test("fill uses the native setter and emits input/change events", async () => {
  const input = new Input(); environment([input]);
  const snapshot = await pageAction({operation: "snapshot"});
  await pageAction({operation: "fill", ref: snapshot.elements[0].ref, value: "こんにちは"});
  assert.equal(input.value, "こんにちは");
  assert.deepEqual(input.events, ["input", "change"]);
});

test("navigation cannot reuse an earlier document's ref or snapshot ID", async () => {
  environment([new Input()]);
  const old = await pageAction({operation:"snapshot"});
  const next = new Input(); environment([next]);
  await pageAction({operation:"snapshot"});
  await assert.rejects(pageAction({operation:"click",ref:old.elements[0].ref}),/古いか不明/);
  await assert.rejects(pageAction({operation:"click",element_index:1,snapshot_id:old.snapshot_id}),/snapshot_idが古い/);
  assert.equal(next.clicked,false);
});

test("LLM AX view exposes native roles, indices, focused/checked/disabled state",async()=>{
  const input=new Input(),check=new Input("checkbox"),button=new Input("button");
  check.checked=true;button.tagName="BUTTON";button.disabled=true;
  button.getAttribute=key=>key==="aria-label"?"送信":null;
  environment([input,check,button]);document.activeElement=input;
  const snapshot=await pageAction({operation:"snapshot"});
  assert.equal(snapshot.elements[0].role,"textbox");assert.equal(snapshot.elements[1].role,"checkbox");assert.equal(snapshot.elements[2].role,"button");
  assert.match(snapshot.ax_tree,/1 text field \(focused\)/);
  assert.match(snapshot.ax_tree,/2 checkbox \(checked\)/);
  assert.match(snapshot.ax_tree,/3 button \(disabled\) "送信"/);
  await pageAction({operation:"fill",element_index:1,snapshot_id:snapshot.snapshot_id,value:"番号で入力"});
  assert.equal(input.value,"番号で入力");
  await pageAction({operation:"snapshot"});
  await assert.rejects(pageAction({operation:"fill",element_index:1,snapshot_id:snapshot.snapshot_id,value:"古い"}),/snapshot_idが古い/);
});
