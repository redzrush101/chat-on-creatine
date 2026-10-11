"use strict";
(() => {
  // src/shared/page-protocol.ts
  function conversationIdFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (!/(^|\.)chatgpt\.com$/.test(parsed.hostname)) return null;
      const match = /\/c\/([0-9a-f-]{8,})/i.exec(parsed.pathname);
      return match ? match[1].toLowerCase() : null;
    } catch {
      return null;
    }
  }
  var DRIVER_VERSION = 1;

  // src/page/errors.ts
  var DriverError = class extends Error {
    code;
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  };
  function fail(code, error) {
    return { ok: false, error, code };
  }

  // src/page/backend.ts
  var SESSION_TTL_MS = 5 * 6e4;
  function createBackend() {
    let session = null;
    async function getSession(force = false) {
      if (!force && session && Date.now() - session.at < SESSION_TTL_MS) return session;
      try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return session;
        const body = await response.json();
        const accessToken = typeof body.accessToken === "string" && body.accessToken ? body.accessToken : null;
        session = {
          signedIn: accessToken !== null,
          accessToken,
          email: typeof body.user?.email === "string" ? body.user.email : null,
          at: Date.now()
        };
        return session;
      } catch {
        return session;
      }
    }
    async function request(path) {
      const current = await getSession();
      const headers = {};
      if (current?.accessToken) headers.Authorization = `Bearer ${current.accessToken}`;
      const response = await fetch(path, { headers, credentials: "same-origin", cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        throw new DriverError(`ChatGPT refused ${path.split("?")[0]} (HTTP ${response.status})`, "signed-out");
      }
      if (!response.ok) throw new DriverError(`${path.split("?")[0]} failed (HTTP ${response.status})`, "failed");
      return response.json();
    }
    return { getSession, request };
  }

  // src/shared/errors.ts
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/shared/chatgpt-stream.ts
  var ROLES = /* @__PURE__ */ new Set(["user", "assistant", "tool", "system"]);
  function isObj(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function str(value) {
    return typeof value === "string" ? value : null;
  }
  function contentText(content) {
    if (Array.isArray(content.parts)) {
      return content.parts.filter((part) => typeof part === "string").join("");
    }
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (Array.isArray(content.thoughts)) {
      return content.thoughts.filter(isObj).map((thought) => [str(thought.summary), str(thought.content)].filter(Boolean).join("\n")).filter(Boolean).join("\n\n");
    }
    return "";
  }
  function normalizeMessage(raw, conversationId) {
    if (!isObj(raw)) return null;
    const id = str(raw.id);
    const author = isObj(raw.author) ? raw.author : {};
    const role = str(author.role);
    if (!id || !role || !ROLES.has(role)) return null;
    const content = isObj(raw.content) ? raw.content : {};
    const metadata = isObj(raw.metadata) ? raw.metadata : {};
    return {
      id,
      conversationId: str(raw.conversation_id) ?? conversationId,
      role,
      authorName: str(author.name),
      recipient: str(raw.recipient) ?? "all",
      channel: str(raw.channel),
      contentType: str(content.content_type) ?? "text",
      text: contentText(content),
      status: str(raw.status) ?? "in_progress",
      endTurn: typeof raw.end_turn === "boolean" ? raw.end_turn : null,
      model: str(metadata.model_slug) ?? str(metadata.default_model_slug),
      requestId: str(metadata.request_id),
      turnId: str(metadata.turn_exchange_id),
      parentId: str(metadata.parent_id),
      createTime: typeof raw.create_time === "number" ? raw.create_time : null,
      hidden: metadata.is_visually_hidden_from_conversation === true
    };
  }
  function unescapeToken(token) {
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
  }
  function pointerTokens(path) {
    return path === "" ? [] : path.split("/").slice(1).map(unescapeToken);
  }
  function lookup(root, tokens) {
    let node = root;
    for (const token of tokens) {
      if (Array.isArray(node)) {
        node = node[Number(token)];
      } else if (isObj(node)) {
        node = node[token];
      } else {
        return void 0;
      }
    }
    return node;
  }
  function applyOp(root, path, op, value) {
    const tokens = pointerTokens(path);
    if (tokens.length === 0) {
      switch (op) {
        case "add":
        case "replace":
          return value;
        case "append":
          if (isObj(root) && isObj(value)) Object.assign(root, value);
          return root;
        case "remove":
          return null;
        case "patch":
          return applyPatch(root, path, value);
        default:
          return root;
      }
    }
    const parent = lookup(root, tokens.slice(0, -1));
    const key = tokens[tokens.length - 1];
    if (op === "patch") return applyPatch(root, path, value);
    if (!Array.isArray(parent) && !isObj(parent)) return root;
    const list = Array.isArray(parent) ? parent : null;
    const index = list ? key === "-" ? list.length : Number(key) : NaN;
    const target = list ? list[index] : parent[key];
    switch (op) {
      case "add":
        if (list) {
          if (Number.isInteger(index) && index >= 0 && index <= list.length) list.splice(index, 0, value);
        } else {
          parent[key] = value;
        }
        break;
      case "replace":
        if (list) {
          if (Number.isInteger(index) && index >= 0 && index < list.length) list[index] = value;
        } else {
          parent[key] = value;
        }
        break;
      case "remove":
        if (list) {
          if (Number.isInteger(index) && index >= 0 && index < list.length) list.splice(index, 1);
        } else {
          delete parent[key];
        }
        break;
      case "append":
        if (target === void 0) {
          if (list) list.push(value);
          else parent[key] = value;
        } else if (typeof target === "string" && typeof value === "string") {
          if (list) list[index] = target + value;
          else parent[key] = target + value;
        } else if (Array.isArray(target)) {
          target.push(...Array.isArray(value) ? value : [value]);
        } else if (isObj(target) && isObj(value)) {
          Object.assign(target, value);
        }
        break;
      case "truncate":
        if (typeof target === "string" && typeof value === "number") {
          const cut = target.slice(0, value);
          if (list) list[index] = cut;
          else parent[key] = cut;
        } else if (Array.isArray(target) && typeof value === "number") {
          target.length = Math.min(target.length, value);
        }
        break;
    }
    return root;
  }
  function applyPatch(root, base, ops) {
    if (!Array.isArray(ops)) return root;
    let next = root;
    for (const sub of ops) {
      if (!isObj(sub)) continue;
      next = applyOp(next, base + (str(sub.p) ?? ""), str(sub.o) ?? "replace", sub.v);
    }
    return next;
  }
  var ConversationStreamParser = class {
    constructor(handlers) {
      this.handlers = handlers;
    }
    buffer = "";
    dataLines = [];
    envelope = null;
    lastPath = "";
    lastOp = "replace";
    conversationId = null;
    lastError = null;
    push(chunk) {
      this.buffer += chunk;
      let start2 = 0;
      for (; ; ) {
        const at = this.findLineEnd(start2);
        if (at < 0) break;
        const ch = this.buffer[at];
        if (ch === "\r" && at === this.buffer.length - 1) break;
        const skip = ch === "\r" && this.buffer[at + 1] === "\n" ? 2 : 1;
        this.line(this.buffer.slice(start2, at));
        start2 = at + skip;
      }
      this.buffer = this.buffer.slice(start2);
    }
    /** Flushes a final unterminated line and any pending event. Does not signal completion. */
    end() {
      if (this.buffer !== "") this.line(this.buffer);
      this.buffer = "";
      this.dispatch();
    }
    findLineEnd(from) {
      for (let i = from; i < this.buffer.length; i++) {
        const ch = this.buffer[i];
        if (ch === "\n" || ch === "\r") return i;
      }
      return -1;
    }
    line(line) {
      if (line === "") {
        this.dispatch();
        return;
      }
      if (line.startsWith(":")) return;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.dataLines.push(value);
    }
    dispatch() {
      if (this.dataLines.length === 0) return;
      const data = this.dataLines.join("\n");
      this.dataLines = [];
      this.event(data);
    }
    event(data) {
      if (data === "[DONE]") {
        this.handlers.complete?.();
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isObj(parsed)) return;
      this.noteConversation(parsed.conversation_id);
      if (typeof parsed.type === "string") {
        this.typedEvent(parsed);
        return;
      }
      if ("v" in parsed || "o" in parsed || "p" in parsed) this.delta(parsed);
    }
    typedEvent(event) {
      switch (event.type) {
        case "input_message": {
          const message = normalizeMessage(event.input_message, this.conversationId ?? "");
          if (message) this.handlers.message(message);
          break;
        }
        case "title_generation": {
          const title = str(event.title);
          if (title) this.handlers.title?.(this.conversationId ?? str(event.conversation_id) ?? "", title);
          break;
        }
        case "message_stream_complete":
          this.handlers.complete?.();
          break;
        default:
          break;
      }
    }
    noteConversation(value) {
      const id = str(value);
      if (!id || id === this.conversationId) return;
      this.conversationId = id;
      this.handlers.conversation?.(id);
    }
    delta(event) {
      if (typeof event.p === "string") this.lastPath = event.p;
      else if (typeof event.o === "string") this.lastPath = "";
      if (typeof event.o === "string") this.lastOp = event.o;
      if (event.p === void 0 && event.o === void 0 && isObj(event.v) && isObj(event.v.message)) {
        this.lastPath = "";
        this.lastOp = "add";
      }
      this.envelope = applyOp(this.envelope, this.lastPath, this.lastOp, event.v);
      if (!isObj(this.envelope)) return;
      this.noteConversation(this.envelope.conversation_id);
      const error = this.envelope.error;
      if (error && error !== this.lastError) {
        this.lastError = typeof error === "string" ? error : JSON.stringify(error);
        this.handlers.error?.(this.lastError);
      }
      const message = normalizeMessage(
        this.envelope.message,
        this.conversationId ?? str(this.envelope.conversation_id) ?? ""
      );
      if (message) this.handlers.message(message);
    }
  };
  function conversationToMessages(json) {
    if (!isObj(json) || !isObj(json.mapping)) return [];
    const mapping = json.mapping;
    const conversationId = str(json.conversation_id) ?? "";
    const path = [];
    const seen = /* @__PURE__ */ new Set();
    let nodeId = str(json.current_node);
    while (nodeId && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = mapping[nodeId];
      if (!isObj(node)) break;
      const message = isObj(node.message) ? normalizeMessage(node.message, conversationId) : null;
      if (message && !(message.hidden && message.role === "system")) path.push(message);
      nodeId = str(node.parent);
    }
    return path.reverse();
  }

  // src/page/dom.ts
  var SELECTORS = {
    composer: [
      'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
      'form [data-composer-markdown][contenteditable="true"][role="textbox"]'
    ],
    classicComposer: "#prompt-textarea",
    sendButton: [
      'button[data-testid="send-button"]',
      'form button[aria-label^="Send" i]',
      'form[data-chatgpt-composer] button[type="submit"]'
    ],
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[data-testid="composer-stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop answering"]'
    ],
    /** The primary-action slot (voice, send or stop) in the composer form; icon-matched when unlabelled. */
    primarySlot: 'button[class*="size-token-button-composer"][class*="bg-composer-primary"]',
    fileInput: 'input[type="file"]',
    uploadBusy: '[aria-busy="true"], [role="progressbar"], [data-inline-file-uploading]',
    alert: '[role="alert"]',
    dialog: '[role="dialog"], [role="alertdialog"]',
    modelTrigger: [
      "[data-codex-intelligence-trigger]",
      '[data-composer-navigation-target="reasoning"]'
    ],
    menuItem: '[role="menuitem"], [role="menuitemradio"], [role="option"], button'
  };
  var STOP_SQUARE = /^\s*M4\.5 5\.75/;
  var TRANSPORT_FAILURE = /^(?:message delivery timed out|connection interrupted|chatgpt stream recovery polling timed out|stream cache expired|unknown error occurred|there was an error generating|error in message stream|network error|a network error occurred|resume stream unavailable|something went wrong)/i;
  var EFFORT_LABELS = {
    none: null,
    pro: null,
    minimal: /minimal/i,
    low: /light|low/i,
    medium: /standard|medium/i,
    high: /extended|high/i,
    xhigh: /heavy|xhigh|max/i,
    max: /max/i
  };
  function visible(node) {
    if (!node.isConnected || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return node.getClientRects().length > 0;
  }
  function first(nodes, keep = () => true) {
    for (const node of nodes) if (keep(node)) return node;
    return null;
  }
  function normalize(text) {
    return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function compact(text) {
    return text.replace(/\s+/g, "");
  }
  function isStopSquare(button) {
    if (button.hasAttribute("data-state")) return false;
    const paths = button.querySelectorAll("svg path");
    return paths.length === 1 && STOP_SQUARE.test(paths[0].getAttribute("d") ?? "");
  }
  function findComposer() {
    const classic = first(document.querySelectorAll(SELECTORS.classicComposer), visible);
    if (classic) return classic;
    return first(
      document.querySelectorAll(SELECTORS.composer.join(", ")),
      (node) => visible(node) && !node.closest("[data-turn-key], .markdown")
    );
  }
  function composerForm() {
    return findComposer()?.closest("form") ?? null;
  }
  function composerText(box) {
    return box.innerText ?? box.textContent ?? "";
  }
  function primaryButtons(form) {
    return [...form.querySelectorAll(SELECTORS.primarySlot)].filter(visible);
  }
  function setComposerText(text) {
    const box = findComposer();
    if (!box) return false;
    const selectAll = () => {
      box.focus();
      const selection = document.getSelection();
      if (!selection) return;
      selection.selectAllChildren(box);
    };
    const clear = () => {
      selectAll();
      document.execCommand("delete", false);
    };
    const insert = () => {
      selectAll();
      document.execCommand("insertText", false, text);
    };
    const paste = () => {
      selectAll();
      const data = new DataTransfer();
      data.setData("text/plain", text);
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    };
    const matches = () => compact(composerText(box)) === compact(text);
    const attempts = text.length > 2e3 ? [paste, insert] : [insert, paste];
    for (const attempt of attempts) {
      clear();
      if (text === "") return matches();
      attempt();
      if (matches()) return true;
    }
    return false;
  }
  function findSendButton() {
    for (const selector of SELECTORS.sendButton) {
      const found = first(document.querySelectorAll(selector), visible);
      if (found) return found;
    }
    const form = composerForm();
    const box = findComposer();
    if (!form || !box || composerText(box).trim() === "" || isGenerating()) return null;
    const candidates = primaryButtons(form).filter((button) => {
      if (button.hasAttribute("data-state") || isStopSquare(button)) return false;
      const paths = button.querySelectorAll("svg path").length;
      return paths >= 1 && paths <= 2;
    });
    return candidates.length === 1 ? candidates[0] : null;
  }
  function findStopButton() {
    for (const selector of SELECTORS.stopButton) {
      const found = first(document.querySelectorAll(selector), visible);
      if (found) return found;
    }
    const form = composerForm();
    if (!form) return null;
    return first(primaryButtons(form), isStopSquare);
  }
  function isGenerating() {
    return findStopButton() !== null;
  }
  function enabled(button) {
    return !!button && !button.disabled && button.getAttribute("aria-disabled") !== "true";
  }
  function clickSend() {
    const button = findSendButton();
    if (enabled(button)) {
      button.click();
      return true;
    }
    const box = findComposer();
    if (!box || composerText(box).trim() === "" || isGenerating()) return false;
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  }
  function clickStop() {
    const button = findStopButton();
    if (!button) return false;
    button.click();
    return true;
  }
  async function attachFiles(files, timeoutMs = 12e4) {
    const form = composerForm() ?? document;
    const inputs = [...form.querySelectorAll(SELECTORS.fileInput)].filter((input2) => !input2.disabled);
    const images = files.every((file) => file.type.startsWith("image/"));
    const input = inputs.find((candidate) => images ? candidate.accept.includes("image") : !candidate.accept) ?? inputs[0];
    if (!input) return false;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const deadline = Date.now() + timeoutMs;
    await new Promise((resolve) => setTimeout(resolve, 300));
    while (Date.now() < deadline) {
      const current = composerForm();
      const labels = [...current?.querySelectorAll("button[aria-label]") ?? []].map((b) => b.getAttribute("aria-label") ?? "");
      const tiled = files.every((file) => labels.some((label) => label.includes(file.name.replace(/\.[^.]*$/, ""))));
      const busy = current?.querySelector(SELECTORS.uploadBusy) != null;
      if (tiled && !busy) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }
  function readErrorNotice() {
    for (const dialog of document.querySelectorAll(SELECTORS.dialog)) {
      if (!visible(dialog)) continue;
      const heading = dialog.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim() ?? "";
      if (/^too many requests$/i.test(heading)) {
        return { level: "warn", text: `${heading}: access to this conversation is temporarily limited.` };
      }
    }
    for (const alert of document.querySelectorAll(SELECTORS.alert)) {
      if (!visible(alert)) continue;
      const text = (alert.innerText || alert.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 2 && text.length < 500 && TRANSPORT_FAILURE.test(text)) return { level: "error", text };
    }
    return null;
  }
  async function selectModel(model, effort) {
    const menuButtons = composerForm()?.querySelectorAll('button[aria-haspopup="menu"]') ?? [];
    const trigger = first(
      [...document.querySelectorAll(SELECTORS.modelTrigger.join(", ")), ...menuButtons],
      visible
    );
    if (!trigger) return false;
    trigger.click();
    await wait(300);
    const clickItem = (pattern) => {
      const item = first(document.querySelectorAll(SELECTORS.menuItem), (node) => {
        if (!visible(node)) return false;
        const label = normalize((node.innerText || node.textContent || "").split("\n")[0] ?? "");
        return pattern(label);
      });
      if (!item) return false;
      item.click();
      return true;
    };
    const wanted = normalize(model);
    let ok = clickItem((label) => label === wanted || label.startsWith(`${wanted} `));
    if (ok && effort) {
      await wait(300);
      const pattern = EFFORT_LABELS[effort];
      ok = pattern !== null && clickItem((label) => pattern.test(label));
    }
    if (!ok) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return ok;
  }
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // src/page/models.ts
  var EFFORT_NAMES = {
    light: "low",
    standard: "medium",
    extended: "high",
    heavy: "xhigh",
    max: "xhigh"
  };
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function parseModels(body) {
    const root = isRecord(body) ? body : {};
    const list = (Array.isArray(root.models) ? root.models : []).filter(isRecord);
    const models = list.flatMap((model) => {
      const id = typeof model.slug === "string" ? model.slug : null;
      if (!id) return [];
      const label = typeof model.title === "string" ? model.title : id;
      const efforts = [];
      if (model.reasoning_type !== "none" && Array.isArray(model.thinking_efforts)) {
        for (const entry of model.thinking_efforts) {
          const name = isRecord(entry) && typeof entry.thinking_effort === "string" ? entry.thinking_effort : null;
          const effort = name ? EFFORT_NAMES[name] : void 0;
          if (effort && !efforts.includes(effort)) efforts.push(effort);
        }
      }
      return [{ id, label, efforts }];
    });
    const fallback = list.find((model) => model.is_default === true);
    const defaultModel = typeof root.default_model_slug === "string" ? root.default_model_slug : typeof fallback?.slug === "string" ? fallback.slug : null;
    return { defaultModel, models };
  }

  // src/page/commands.ts
  var MODELS_PATH = "/backend-api/models?iim=false&include_icons=false&is_gizmo=false";
  var DONE = { ok: true };
  function toFile(file) {
    const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
    return new File([bytes], file.name, { type: file.mime });
  }
  function wait2(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function waitFor(predicate, ms) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() >= deadline) return false;
      await wait2(100);
    }
    return true;
  }
  var PageCommands = class {
    constructor(backend, streams) {
      this.backend = backend;
      this.streams = streams;
    }
    models = null;
    async loadModels() {
      this.models = parseModels(await this.backend.request(MODELS_PATH));
      return this.models;
    }
    async status() {
      const current = await this.backend.getSession();
      return {
        url: location.href,
        conversationId: conversationIdFromUrl(location.href),
        signedIn: current?.signedIn ?? null,
        generating: isGenerating(),
        composerReady: findComposer() !== null
      };
    }
    async send(text, files) {
      if (!await waitFor(() => findComposer() !== null, 15e3)) return fail("not-ready", "composer not found");
      if (isGenerating()) return fail("busy", "a response is still generating");
      if (!setComposerText(text)) return fail("failed", "could not type into the composer");
      if (files.length > 0 && !await attachFiles(files.map(toFile))) {
        return fail("failed", "attachments did not finish uploading");
      }
      const sendable = () => {
        const button = findSendButton();
        return button !== null && !button.disabled && button.getAttribute("aria-disabled") !== "true";
      };
      if (!await waitFor(sendable, files.length > 0 ? 1500 : 5e3) && files.length === 0) return fail("not-ready", "send button is not available");
      const started = this.streams.waitForStart(2e4);
      if (!clickSend()) return fail("failed", "send button could not be clicked");
      const value = await started;
      return value ? { ok: true, value } : fail("timeout", "no conversation stream started after send");
    }
    async selectModel(model, effort) {
      if (!this.models) await this.loadModels().catch(() => void 0);
      const label = this.models?.models.find((entry) => entry.id === model)?.label ?? model;
      return await selectModel(label, effort) ? DONE : fail("not-found", `model ${model} not found in the picker`);
    }
    async run(command) {
      try {
        switch (command.type) {
          case "status":
            return { ok: true, value: await this.status() };
          case "send":
            return await this.send(command.text, command.files);
          case "stop":
            return clickStop() ? DONE : fail("not-found", "no stop control is visible");
          case "models":
            return { ok: true, value: await this.loadModels() };
          case "conversation": {
            const json = await this.backend.request(`/backend-api/conversation/${encodeURIComponent(command.conversationId)}`);
            return { ok: true, value: conversationToMessages(json) };
          }
          case "select-model":
            return await this.selectModel(command.model, command.effort);
          case "usage":
            return { ok: false, error: "unsupported" };
        }
      } catch (error) {
        if (error instanceof DriverError) return fail(error.code, error.message);
        return fail("failed", errorMessage(error));
      }
    }
  };

  // src/page/observe.ts
  var NOTICE_DEBOUNCE_MS = 200;
  var LOCATION_POLL_MS = 500;
  function observePage(emit) {
    let lastGenerating = null;
    let lastNotice = null;
    let lastUrl = location.href;
    function checkPage() {
      const generating = isGenerating();
      if (generating !== lastGenerating) {
        lastGenerating = generating;
        emit({ type: "generating", value: generating });
      }
      const notice = readErrorNotice();
      const key = notice ? `${notice.level}:${notice.text}` : null;
      if (notice && key !== lastNotice) emit({ type: "notice", level: notice.level, text: notice.text });
      lastNotice = key;
    }
    let checkTimer = null;
    const scheduleCheck = () => {
      if (checkTimer) return;
      checkTimer = setTimeout(() => {
        checkTimer = null;
        checkPage();
      }, NOTICE_DEBOUNCE_MS);
    };
    new MutationObserver(scheduleCheck).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid", "data-state", "class", "hidden", "aria-hidden"]
    });
    const checkLocation = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      emit({ type: "location", url: lastUrl, conversationId: conversationIdFromUrl(lastUrl) });
    };
    setInterval(checkLocation, LOCATION_POLL_MS);
    window.addEventListener("popstate", checkLocation);
    return checkPage;
  }

  // src/page/streams.ts
  var MESSAGE_INTERVAL_MS = 100;
  var StreamRelay = class {
    constructor(emit, conversationId) {
      this.emit = emit;
      this.conversationId = conversationId;
    }
    streams = /* @__PURE__ */ new Map();
    startWaiters = /* @__PURE__ */ new Set();
    handle(data) {
      switch (data.kind) {
        case "start":
          this.openStream(data.streamId, data.requestId ?? null);
          break;
        case "chunk":
          this.streams.get(data.streamId)?.parser.push(data.chunk ?? "");
          break;
        case "end":
          this.streams.get(data.streamId)?.parser.end();
          this.closeStream(data.streamId, null);
          break;
        case "error":
          this.streams.get(data.streamId)?.parser.end();
          this.closeStream(data.streamId, data.error ?? "stream failed");
          break;
      }
    }
    waitForStart(ms) {
      return new Promise((resolve) => {
        const waiter = (value) => done(value);
        const done = (value) => {
          clearTimeout(timer);
          this.startWaiters.delete(waiter);
          resolve(value);
        };
        const timer = setTimeout(() => done(null), ms);
        this.startWaiters.add(waiter);
      });
    }
    queueMessage(stream, message) {
      const now = Date.now();
      const last = stream.lastEmit.get(message.id) ?? 0;
      if (message.status !== "in_progress" || now - last >= MESSAGE_INTERVAL_MS) {
        stream.pending.delete(message.id);
        stream.lastEmit.set(message.id, now);
        this.emit({ type: "message", streamId: stream.id, message });
        return;
      }
      stream.pending.set(message.id, message);
      stream.timer ??= setTimeout(() => this.flushMessages(stream), MESSAGE_INTERVAL_MS - (now - last));
    }
    flushMessages(stream) {
      stream.timer = null;
      const now = Date.now();
      for (const [id, message] of stream.pending) {
        stream.lastEmit.set(id, now);
        this.emit({ type: "message", streamId: stream.id, message });
      }
      stream.pending.clear();
    }
    openStream(streamId, requestId) {
      const stream = {
        id: streamId,
        conversationId: this.conversationId(),
        complete: false,
        error: null,
        lastEmit: /* @__PURE__ */ new Map(),
        pending: /* @__PURE__ */ new Map(),
        timer: null,
        parser: new ConversationStreamParser({
          message: (message) => this.queueMessage(stream, message),
          conversation: (id) => {
            stream.conversationId = id;
          },
          title: (conversationId, title) => this.emit({ type: "title", conversationId, title }),
          complete: () => {
            stream.complete = true;
          },
          error: (text) => {
            stream.error = text;
          }
        })
      };
      this.streams.set(streamId, stream);
      this.emit({ type: "turn-start", streamId, conversationId: stream.conversationId, requestId });
      for (const waiter of [...this.startWaiters]) waiter({ conversationId: stream.conversationId, streamId });
    }
    closeStream(streamId, error) {
      const stream = this.streams.get(streamId);
      if (!stream) return;
      this.streams.delete(streamId);
      if (stream.timer) clearTimeout(stream.timer);
      this.flushMessages(stream);
      const outcome = stream.complete ? "complete" : error || stream.error ? "error" : "aborted";
      this.emit({
        type: "turn-end",
        streamId,
        conversationId: stream.conversationId,
        outcome,
        error: error ?? stream.error
      });
    }
  };

  // src/page/driver.ts
  function startDriver(transport2, tapChannel) {
    const emit = (event) => transport2.send(event);
    const backend = createBackend();
    const streams = new StreamRelay(emit, () => conversationIdFromUrl(location.href));
    const commands = new PageCommands(backend, streams);
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.channel !== tapChannel) return;
      streams.handle(data);
    });
    async function refreshAuth() {
      const current = await backend.getSession(true);
      if (current) emit({ type: "auth", signedIn: current.signedIn, email: current.email });
    }
    const checkPage = observePage(emit);
    transport2.onCommand((command) => commands.run(command));
    emit({
      type: "hello",
      driverVersion: DRIVER_VERSION,
      url: location.href,
      conversationId: conversationIdFromUrl(location.href),
      signedIn: null
    });
    void refreshAuth();
    checkPage();
  }

  // src/page/extension-entry.ts
  var TAP_CHANNEL = "creatine-tap";
  var PORT_NAME = "creatine-driver";
  var RECONNECT_MS = 500;
  var port = null;
  var detached = false;
  var lastHello = null;
  var handler = null;
  function post(message) {
    try {
      port?.postMessage(message);
    } catch {
    }
  }
  function connect() {
    let next;
    try {
      next = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      return;
    }
    port = next;
    next.onMessage.addListener((message) => {
      const msg = message;
      if (msg.type === "replay") {
        if (lastHello) post({ type: "event", event: lastHello });
      } else if (msg.type === "detach") {
        detached = true;
      } else if (msg.type === "command") {
        const run = handler ? handler(msg.command).catch((error) => ({ ok: false, error: String(error), code: "failed" })) : Promise.resolve({ ok: false, error: "Driver not started", code: "not-ready" });
        void run.then((result) => post({ type: "result", id: msg.id, result }));
      }
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      if (!detached) setTimeout(connect, RECONNECT_MS);
    });
  }
  var transport = {
    send(event) {
      if (event.type === "hello") lastHello = event;
      post({ type: "event", event });
    },
    onCommand(next) {
      handler = next;
    }
  };
  connect();
  var start = () => startDriver(transport, TAP_CHANNEL);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
