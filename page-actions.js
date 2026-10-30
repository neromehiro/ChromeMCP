// Executed in Chrome's isolated extension world, never eval'd from client text.
export async function pageAction(params) {
  const visible = element => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const state = globalThis.__LOCAL_CHROME_BRIDGE_V1__ ||= {refs: new Map(), indices: new Map(), generation: 0};
  state.indices ||= new Map();
  state.document_id ||= Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
  const locate = () => {
    let element;
    if (params.snapshot_id && params.snapshot_id !== state.snapshot_id) throw new Error("snapshot_idが古いです。画面を取り直してください。");
    if (params.element_index !== undefined && params.element_index !== null) {
      element = state.indices.get(params.element_index);
      if (!element?.isConnected) throw new Error("要素番号が不明です。画面を取り直してください。");
    } else if (params.ref) {
      element = state.refs.get(params.ref);
      if (!element?.isConnected) throw new Error("要素refが古いか不明です。page_snapshotを取り直してください。");
    } else if (params.selector) {
      const matches = document.querySelectorAll(params.selector);
      if (matches.length !== 1) throw new Error(`selectorは1要素に一致させてください（${matches.length}件）。`);
      element = matches[0];
    } else throw new Error("element_index、ref、selectorのいずれかを指定してください。");
    if (!visible(element)) throw new Error("対象要素が表示されていません。");
    return element;
  };
  const name = element => {
    const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map(id => document.getElementById(id)?.innerText || "").join(" ");
    return (element.getAttribute("aria-label") || labelled ||
      Array.from(element.labels || []).map(label => label.innerText).join(" ") ||
      element.innerText || element.getAttribute("placeholder") || element.getAttribute("title") || "").trim().slice(0, 180);
  };
  const role = element => {
    const explicit = element.getAttribute("role");
    if (explicit && !["none", "presentation"].includes(explicit)) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "input") return {checkbox:"checkbox", radio:"radio", range:"slider", number:"spinbutton", button:"button", submit:"button", reset:"button", search:"searchbox"}[element.type] || "textbox";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return {button:"button", a:"link", textarea:"textbox", option:"option", main:"main", nav:"navigation", header:"banner", footer:"contentinfo", aside:"complementary", form:"form", ul:"list", ol:"list", li:"listitem", dialog:"dialog", table:"table", tr:"row", th:"columnheader", td:"cell", summary:"button", progress:"progressbar"}[tag] || "container";
  };
  if (params.operation === "snapshot") {
    state.refs.clear();
    state.indices.clear();
    state.generation++;
    state.snapshot_id = `${state.document_id}:g${state.generation}`;
    const elements = [];
    const nodes = [];
    const limit = Math.min(Math.max(Number(params.max_elements) || 200, 1), 500);
    for (const element of document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,option,[contenteditable="true"],[role],h1,h2,h3,h4,h5,h6,main,nav,header,footer,aside,form,ul,ol,li,dialog,table,tr,th,td,summary,progress')) {
      if (!visible(element)) continue;
      const ref = `${state.snapshot_id}e${elements.length + 1}`;
      state.refs.set(ref, element);
      const index = elements.length + 1;
      state.indices.set(index, element);
      const semanticRole = role(element);
      const item = {index, ref, tag: element.tagName.toLowerCase(), role: semanticRole, name: name(element)};
      if (["container", "main", "navigation", "banner", "contentinfo", "complementary", "form", "list", "listitem", "row", "table"].includes(semanticRole)) item.name = (element.getAttribute("aria-label") || element.getAttribute("title") || "").trim();
      if (element.getAttribute("href")) item.href = element.href;
      if ("value" in element && !["button","heading","link"].includes(semanticRole) && element.type !== "password" && element.type !== "file") item.value = String(element.value).slice(0, 500);
      if (["checkbox", "radio"].includes(semanticRole) && "checked" in element) item.checked = Boolean(element.checked);
      if ("disabled" in element) item.disabled = Boolean(element.disabled);
      if (element.getAttribute("aria-disabled") === "true") item.disabled = true;
      item.focused = document.activeElement === element;
      for (const attribute of ["checked", "selected", "expanded", "pressed", "required", "readonly"]) {
        const value = element.getAttribute("aria-" + attribute);
        if (value !== null) item[attribute] = value === "true" ? true : value === "false" ? false : value;
      }
      if (["checkbox","radio"].includes(semanticRole) && item.checked !== undefined) item.value = item.checked ? "1" : "0";
      if (semanticRole === "combobox" && item.expanded === undefined) item.expanded = false;
      if (element.selected !== undefined) item.selected = Boolean(element.selected);
      if (semanticRole === "heading") item.level = Number(element.getAttribute("aria-level")) || Number(item.tag.slice(1));
      if (element.id) item.node_id = element.id;
      item.actions = ["button", "link", "checkbox", "radio", "option", "tab", "menuitem", "switch"].includes(semanticRole) ? ["click"] : ["textbox", "searchbox", "combobox", "spinbutton"].includes(semanticRole) ? ["click", "fill"] : [];
      elements.push(item);
      nodes.push(element);
      if (elements.length >= limit) break;
    }
    const maxChars = Math.min(Math.max(Number(params.max_chars) || 20000, 1), 50000);
    const text = document.body?.innerText || "";
    const selected = new Set(nodes);
    const roleNames = {textbox:"text field", searchbox:"search box", combobox:"combo box", listbox:"list box", listitem:"list item"};
    const tree = [`0 AXWebArea ${document.title}, URL: ${location.href}`];
    for (let n = 0; n < elements.length; n++) {
      const item = elements[n];
      let depth = 1;
      for (let parent = nodes[n].parentElement; parent; parent = parent.parentElement) if (selected.has(parent)) depth++;
      const states = [];
      for (const key of ["disabled", "focused", "checked", "selected", "pressed"]) if (item[key] === true || item[key] === "mixed") states.push(item[key] === "mixed" ? `${key}=mixed` : key);
      if (item.checked === false) states.push("unchecked");
      if (item.expanded !== undefined) states.push(item.expanded ? "expanded" : "collapsed");
      const suffix = states.length ? ` (${states.join(", ")})` : "";
      const value = item.value !== undefined ? `, Value: ${JSON.stringify(item.value)}` : "";
      const id = item.node_id ? `, ID: ${item.node_id}` : "";
      tree.push(`${"  ".repeat(depth)}${item.index} ${roleNames[item.role] || item.role}${suffix}${item.name ? " " + JSON.stringify(item.name) : ""}${value}${id}`);
    }
    const focused = elements.find(item => item.focused)?.index ?? 0;
    tree.push(`\nThe focused UI element is ${focused}. Snapshot ID: ${state.snapshot_id}`);
    return {title: document.title, url: location.href, snapshot_id: state.snapshot_id, ax_tree: tree.join("\n"), focused_element_index: focused, text: text.slice(0, maxChars), truncated: text.length > maxChars, elements};
  }
  if (params.operation === "click") {
    const element = locate();
    if (element.disabled) throw new Error("対象要素は無効です。");
    element.scrollIntoView({block: "center", inline: "nearest"});
    element.click();
    return {clicked: true};
  }
  if (params.operation === "fill") {
    const element = locate();
    if (element.disabled || element.readOnly) throw new Error("対象要素は編集できません。");
    const value = String(params.value ?? "");
    element.focus();
    if (element.isContentEditable) element.textContent = value;
    else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (["file", "checkbox", "radio", "submit", "button", "reset", "hidden"].includes(element.type)) throw new Error("この入力種類はfillに対応していません。");
      if (element instanceof HTMLSelectElement && !Array.from(element.options).some(option => option.value === value)) throw new Error("選択肢に存在しない値です。");
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      if (!setter) throw new Error("対象要素にvalue setterがありません。");
      setter.call(element, value);
    } else throw new Error("input/textarea/select/contenteditableを指定してください。");
    element.dispatchEvent(new InputEvent("input", {bubbles: true, composed: true, inputType: "insertText", data: value}));
    element.dispatchEvent(new Event("change", {bubbles: true}));
    return {filled: true};
  }
  if (params.operation === "scroll") {
    const top = Math.max(-20000, Math.min(20000, Number(params.y) || 0));
    const left = Math.max(-20000, Math.min(20000, Number(params.x) || 0));
    window.scrollBy({top, left, behavior: "instant"});
    return {x: window.scrollX, y: window.scrollY};
  }
  if (params.operation === "wait") {
    if (!params.selector) throw new Error("selectorを指定してください。");
    const deadline = Date.now() + Math.min(Math.max(Number(params.timeout_ms) || 15000, 1), 30000);
    do {
      const element = document.querySelector(params.selector);
      if (element && visible(element)) return {found: true};
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error("指定の要素が表示される前にタイムアウトしました。");
  }
  throw new Error("Unknown page operation");
}
