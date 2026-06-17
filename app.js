const STORAGE_KEY = "simple_ai_chats_v2";
const SETTINGS_KEY = "simple_ai_settings_v1";
const DISMISSED_INSTALL_KEY = "simple_ai_install_dismissed";
const PASSWORD_KEY = "simple_ai_site_password";

// Point this at your deployed Cloudflare Worker URL.
const WORKER_URL = "https://gentle-waterfall-c55d.musatoseef10.workers.dev";
const MODEL = "llama-3.3-70b-versatile";

const DEFAULT_SYSTEM_PROMPT =
  "You are Simple AI, a helpful assistant that chats naturally like ChatGPT. Understand casual language, slang, abbreviations, typos, fragments, and very short messages. If the user says something like \"wsp\", \"yo\", \"sup\", or \"wyd\", understand it as a casual greeting and reply warmly. Do not say you do not understand common slang. Ask a clarifying question only when the meaning is truly unclear. Keep normal chat replies friendly and concise, but give detailed help when the user asks for work, code, explanations, or plans. Format code in fenced blocks.";

const defaultSettings = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT
};

let chats = readJson(STORAGE_KEY, []);
let settings = normalizeSettings({ ...defaultSettings, ...readJson(SETTINGS_KEY, {}) });
let activeChatId = chats[0]?.id || null;
let loading = false;
let abortController = null;
let deferredPrompt = null;
let sitePassword = localStorage.getItem(PASSWORD_KEY) || "";

const els = {
  passwordDialog: document.getElementById("passwordDialog"),
  passwordForm: document.getElementById("passwordForm"),
  passwordInput: document.getElementById("passwordInput"),
  passwordMessage: document.getElementById("passwordMessage"),
  sidebar: document.getElementById("sidebar"),
  sidebarButton: document.getElementById("sidebarButton"),
  chatList: document.getElementById("chatList"),
  chatSearch: document.getElementById("chatSearch"),
  newChatButton: document.getElementById("newChatButton"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  promptInput: document.getElementById("promptInput"),
  sendButton: document.getElementById("sendButton"),
  activeTitle: document.getElementById("activeTitle"),
  activeMeta: document.getElementById("activeMeta"),
  providerLabel: document.getElementById("providerLabel"),
  statusDot: document.getElementById("statusDot"),
  installButton: document.getElementById("installButton"),
  installToast: document.getElementById("installToast"),
  installToastButton: document.getElementById("installToastButton"),
  dismissInstall: document.getElementById("dismissInstall"),
  settingsButton: document.getElementById("settingsButton"),
  settingsDialog: document.getElementById("settingsDialog"),
  closeSettingsButton: document.getElementById("closeSettingsButton"),
  systemPromptInput: document.getElementById("systemPromptInput"),
  testConnectionButton: document.getElementById("testConnectionButton"),
  settingsMessage: document.getElementById("settingsMessage")
};

init();

function init() {
  bindEvents();
  applySettingsToForm();
  updateProviderLabel();
  render();
  registerServiceWorker();
  setupInstallPrompt();
  updatePasswordGate();
}

function updatePasswordGate() {
  if (sitePassword) {
    if (els.passwordDialog.open) els.passwordDialog.close();
  } else {
    if (!els.passwordDialog.open) els.passwordDialog.showModal();
  }
}

function bindEvents() {
  els.sidebarButton.addEventListener("click", () => {
    els.sidebar.classList.toggle("closed");
  });

  els.newChatButton.addEventListener("click", () => {
    createChat();
    render();
    focusPrompt();
  });

  els.chatSearch.addEventListener("input", renderChatList);

  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });

  els.promptInput.addEventListener("input", () => {
    autosizePrompt();
    updateSendState();
  });

  els.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  els.installButton.addEventListener("click", showInstall);
  els.installToastButton.addEventListener("click", installApp);
  els.dismissInstall.addEventListener("click", () => {
    localStorage.setItem(DISMISSED_INSTALL_KEY, "1");
    els.installToast.hidden = true;
  });

  els.settingsButton.addEventListener("click", () => {
    applySettingsToForm();
    els.settingsMessage.textContent = "";
    els.settingsDialog.showModal();
  });

  els.settingsDialog.addEventListener("close", () => {
    saveSettingsFromForm();
  });

  els.closeSettingsButton.addEventListener("click", () => {
    els.settingsDialog.close("cancel");
  });

  els.testConnectionButton.addEventListener("click", testConnection);

  els.passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.passwordInput.value.trim();
    if (!value) return;
    sitePassword = value;
    localStorage.setItem(PASSWORD_KEY, value);
    els.passwordMessage.textContent = "";
    updatePasswordGate();
  });
}

async function sendMessage() {
  const text = els.promptInput.value.trim();
  if (!text || loading) return;

  if (!activeChatId) createChat(text);
  const chat = getActiveChat();
  const userMessage = makeMessage("user", text);
  chat.messages.push(userMessage);
  if (!chat.title || chat.title === "New chat") chat.title = text.slice(0, 58);
  saveChats();

  els.promptInput.value = "";
  autosizePrompt();
  loading = true;
  updateSendState();
  render();

  const assistantMessage = makeMessage("assistant", "");
  chat.messages.push(assistantMessage);
  renderMessages();

  abortController = new AbortController();

  try {
    await streamReply(chat, assistantMessage, abortController.signal);
    markStatus("online");
  } catch (error) {
    assistantMessage.content = formatError(error);
    markStatus("error");
  } finally {
    loading = false;
    abortController = null;
    saveChats();
    updateSendState();
    render();
  }
}

async function streamReply(chat, assistantMessage, signal) {
  const response = await fetch(chatUrl(), {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(chatPayload(chat, assistantMessage, true)),
    signal
  });

  if (response.status === 401) {
    sitePassword = "";
    localStorage.removeItem(PASSWORD_KEY);
    updatePasswordGate();
    throw new Error("Incorrect password. Please re-enter it.");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(cleanProviderError(body) || `Simple AI returned HTTP ${response.status}`);
  }

  if (!response.body) {
    const data = await response.json();
    assistantMessage.content = extractNonStreamContent(data);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const chunkText = parseStreamChunk(trimmed);
      if (!chunkText && isDoneStreamChunk(trimmed)) return;
      assistantMessage.content += chunkText;
      renderMessages();
      scrollToBottom();
    }
  }
}

function requestHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Site-Password": sitePassword
  };
}

function chatUrl() {
  return WORKER_URL;
}

function chatPayload(chat, assistantMessage, stream) {
  const messages = [
    { role: "system", content: settings.systemPrompt },
    ...chat.messages
      .filter((message) => message.content && message.id !== assistantMessage.id)
      .map((message) => ({ role: message.role, content: message.content }))
  ];

  return {
    model: MODEL,
    stream,
    messages
  };
}

function createChat(title = "New chat") {
  const chat = {
    id: genId(),
    title,
    createdAt: Date.now(),
    messages: []
  };
  chats.unshift(chat);
  activeChatId = chat.id;
  saveChats();
  return chat;
}

function deleteChat(id) {
  if (abortController && id === activeChatId) abortController.abort();
  chats = chats.filter((chat) => chat.id !== id);
  if (activeChatId === id) activeChatId = chats[0]?.id || null;
  saveChats();
  render();
}

function render() {
  renderChatList();
  renderMessages();
  updateHeader();
  updateSendState();
}

function renderChatList() {
  const query = els.chatSearch.value.trim().toLowerCase();
  const visibleChats = chats.filter((chat) => chat.title.toLowerCase().includes(query));
  els.chatList.innerHTML = "";

  if (!visibleChats.length) {
    const empty = document.createElement("div");
    empty.className = "active-meta";
    empty.textContent = "No chats";
    els.chatList.append(empty);
    return;
  }

  for (const chat of visibleChats) {
    const item = document.createElement("button");
    item.className = `chat-item${chat.id === activeChatId ? " active" : ""}`;
    item.type = "button";
    item.addEventListener("click", () => {
      activeChatId = chat.id;
      render();
      focusPrompt();
    });

    const name = document.createElement("div");
    name.className = "chat-name";
    name.textContent = chat.title || "New chat";

    const date = document.createElement("div");
    date.className = "chat-date";
    date.textContent = formatDate(chat.createdAt);

    const remove = document.createElement("button");
    remove.className = "delete-chat";
    remove.type = "button";
    remove.textContent = "×";
    remove.ariaLabel = `Delete ${chat.title || "chat"}`;
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });

    item.append(name, remove, date);
    els.chatList.append(item);
  }
}

function renderMessages() {
  const chat = getActiveChat();
  els.messages.innerHTML = "";

  if (!chat || !chat.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="brand-mark">AI</div>
      <div>
        <h1>Simple AI</h1>
        <p>Simple AI is ready.</p>
      </div>
      <div class="prompt-row"></div>
    `;
    const chips = [
      "Explain this simply",
      "Write a clean email",
      "Plan my next step",
      "Debug this code"
    ];
    const row = empty.querySelector(".prompt-row");
    for (const prompt of chips) {
      const chip = document.createElement("button");
      chip.className = "prompt-chip";
      chip.type = "button";
      chip.textContent = prompt;
      chip.addEventListener("click", () => {
        if (!activeChatId) createChat();
        els.promptInput.value = prompt;
        autosizePrompt();
        focusPrompt();
        updateSendState();
      });
      row.append(chip);
    }
    els.messages.append(empty);
    return;
  }

  for (const message of chat.messages) {
    const row = document.createElement("div");
    row.className = `message-row ${message.role}`;

    if (message.role === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = "AI";
      row.append(avatar);
    }

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = renderMarkdown(message.content || (loading ? "Thinking..." : ""));
    row.append(bubble);

    els.messages.append(row);
  }

  scrollToBottom();
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const withCodeBlocks = escaped.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  return withCodeBlocks
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function updateHeader() {
  const chat = getActiveChat();
  els.activeTitle.textContent = chat?.title || "Simple AI";
  els.activeMeta.textContent = chat ? `${chat.messages.length} messages` : "Ready";
  updateProviderLabel();
}

function updateProviderLabel() {
  els.providerLabel.textContent = "Simple AI";
}

function updateSendState() {
  els.sendButton.disabled = loading || !els.promptInput.value.trim();
}

function markStatus(state) {
  els.statusDot.classList.remove("online", "error");
  if (state) els.statusDot.classList.add(state);
}

function getActiveChat() {
  return chats.find((chat) => chat.id === activeChatId) || null;
}

function saveChats() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
}

function saveSettingsFromForm() {
  settings = {
    systemPrompt: els.systemPromptInput.value.trim() || defaultSettings.systemPrompt
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  updateProviderLabel();
  render();
}

function normalizeSettings(value) {
  const next = { ...value };
  if (!next.systemPrompt) {
    next.systemPrompt = defaultSettings.systemPrompt;
  }
  return next;
}

function applySettingsToForm() {
  els.systemPromptInput.value = settings.systemPrompt;
}

async function testConnection() {
  saveSettingsFromForm();
  els.settingsMessage.textContent = "Testing...";
  try {
    const response = await fetch(chatUrl(), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
          { role: "system", content: settings.systemPrompt },
          { role: "user", content: "Reply with OK." }
        ]
      })
    });
    if (response.status === 401) {
      throw new Error("Incorrect password. Re-enter it to continue.");
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(cleanProviderError(body) || `HTTP ${response.status}`);
    }
    els.settingsMessage.textContent = "Connection works.";
    markStatus("online");
  } catch (error) {
    els.settingsMessage.textContent = formatError(error);
    markStatus("error");
  }
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    if (!localStorage.getItem(DISMISSED_INSTALL_KEY)) {
      setTimeout(() => {
        els.installToast.hidden = false;
      }, 1200);
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    els.installToast.hidden = true;
    localStorage.setItem(DISMISSED_INSTALL_KEY, "1");
  });
}

async function showInstall() {
  if (deferredPrompt) {
    await installApp();
    return;
  }
  els.installToast.querySelector("span").textContent = isIos()
    ? "On iPhone/iPad: tap the Share icon, then \"Add to Home Screen.\""
    : "Use your browser menu (⋮ or ...) and choose \"Install app\" or \"Add to Home Screen.\"";
  els.installToast.hidden = false;
}

async function installApp() {
  if (!deferredPrompt) {
    els.installToast.querySelector("span").textContent = isIos()
      ? "On iPhone/iPad: tap the Share icon, then \"Add to Home Screen.\""
      : "Use your browser menu (⋮ or ...) and choose \"Install app\" or \"Add to Home Screen.\"";
    return;
  }
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  els.installToast.hidden = true;
  if (choice?.outcome !== "accepted") {
    localStorage.setItem(DISMISSED_INSTALL_KEY, "1");
  }
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").then((registration) => {
      registration.update().catch(() => {});
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
    }).catch(() => {});
  }
}

function autosizePrompt() {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(els.promptInput.scrollHeight, 170)}px`;
}

function focusPrompt() {
  setTimeout(() => els.promptInput.focus(), 0);
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatError(error) {
  const message = String(error?.message || error || "Something went wrong.");
  if (message.includes("Failed to fetch")) {
    return "I could not reach Simple AI. Check your internet connection and try again.";
  }
  if (/model .+ not found/i.test(message)) {
    return "The configured model is not available right now. Try again later.";
  }
  return `Error: ${message}`;
}

function cleanProviderError(body) {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message || parsed.message || "";
  } catch {
    return body;
  }
}

function parseStreamChunk(line) {
  const text = line.startsWith("data:") ? line.slice(5).trim() : line;
  if (!text || text === "[DONE]") return "";
  const chunk = JSON.parse(text);
  return chunk.choices?.[0]?.delta?.content || "";
}

function isDoneStreamChunk(line) {
  const text = line.startsWith("data:") ? line.slice(5).trim() : line;
  return text === "[DONE]";
}

function extractNonStreamContent(data) {
  return data.choices?.[0]?.message?.content || "";
}

function makeMessage(role, content) {
  return { id: genId(), role, content, ts: Date.now() };
}

function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
