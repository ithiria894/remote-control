const state = {
  clientId: localStorage.getItem("remote-control-client-id") || crypto.randomUUID(),
  activeSessionId: localStorage.getItem("remote-control-active-session-id") || null,
  connection: "connecting",
  view: null,
  liveBySession: {},
  creatingSession: false,
  creatingSessionFromId: null,
  queuedPrompt: null,
  mobileSidebarOpen: false,
  composerSettingsOpen: false
};

localStorage.setItem("remote-control-client-id", state.clientId);

const elements = {
  sidebar: document.querySelector(".sidebar"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  sidebarToggleButton: document.getElementById("sidebarToggleButton"),
  sidebarCloseButton: document.getElementById("sidebarCloseButton"),
  connectionStatus: document.getElementById("connectionStatus"),
  sessionTitle: document.getElementById("sessionTitle"),
  threadMeta: document.getElementById("threadMeta"),
  sessionState: document.getElementById("sessionState"),
  sessionGroups: document.getElementById("sessionGroups"),
  syncActiveButton: document.getElementById("syncActiveButton"),
  nativeThreadList: document.getElementById("nativeThreadList"),
  cwdSummary: document.getElementById("cwdSummary"),
  transcript: document.getElementById("transcript"),
  composer: document.getElementById("composer"),
  composerSettings: document.getElementById("composerSettings"),
  composerSettingsButton: document.getElementById("composerSettingsButton"),
  promptInput: document.getElementById("promptInput"),
  submitButton: document.getElementById("submitButton"),
  providerPills: document.getElementById("providerPills"),
  refreshButton: document.getElementById("refreshButton"),
  newButton: document.getElementById("newButton"),
  stopButton: document.getElementById("stopButton"),
  providerSelect: document.getElementById("providerSelect"),
  cwdInput: document.getElementById("cwdInput"),
  applyCwdButton: document.getElementById("applyCwdButton"),
  eventFeed: document.getElementById("eventFeed")
};

let socket = null;

connect();
bindUi();

function bindUi() {
  elements.refreshButton.addEventListener("click", () => send({ type: "refresh" }));
  elements.newButton.addEventListener("click", () => {
    closeSidebar();
    state.creatingSession = true;
    state.creatingSessionFromId = currentSessionId();
    render();
    send({ type: "new" });
  });
  elements.sidebarToggleButton.addEventListener("click", toggleSidebar);
  elements.sidebarCloseButton.addEventListener("click", closeSidebar);
  elements.sidebarBackdrop.addEventListener("click", closeSidebar);
  elements.syncActiveButton.addEventListener("click", () => send({ type: "sync-active-local" }));
  elements.stopButton.addEventListener("click", () => {
    send({ type: "stop", sessionId: currentSessionId() });
  });
  elements.applyCwdButton.addEventListener("click", () => {
    const cwd = elements.cwdInput.value.trim();
    if (cwd) {
      state.composerSettingsOpen = false;
      render();
      send({ type: "cwd", cwd, sessionId: currentSessionId() });
    }
  });
  elements.composerSettingsButton.addEventListener("click", () => {
    state.composerSettingsOpen = !state.composerSettingsOpen;
    render();
  });
  elements.providerSelect.addEventListener("change", () => {
    send({
      type: "provider",
      provider: elements.providerSelect.value,
      sessionId: currentSessionId()
    });
  });
  elements.providerPills.addEventListener("click", event => {
    const button = event.target.closest(".provider-pill");
    if (!button || button.disabled) {
      return;
    }
    const provider = button.dataset.provider;
    if (!provider || provider === elements.providerSelect.value) {
      return;
    }
    elements.providerSelect.value = provider;
    elements.providerSelect.dispatchEvent(new Event("change"));
  });
  elements.promptInput.addEventListener("input", () => render());
  elements.composer.addEventListener("submit", event => {
    event.preventDefault();
    const text = elements.promptInput.value.trim();
    if (!text) {
      return;
    }

    elements.promptInput.value = "";
    state.composerSettingsOpen = false;

    if (state.creatingSession) {
      state.queuedPrompt = text;
      render();
      return;
    }

    submitPrompt(text);
  });

  window.addEventListener("resize", () => {
    if (!isMobileViewport()) {
      closeSidebar();
    }
  });

  window.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeSidebar();
    }
  });
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener("open", () => {
    state.connection = "connected";
    render();
    send({
      type: "init",
      clientId: state.clientId,
      sessionId: state.activeSessionId
    });
  });

  socket.addEventListener("close", () => {
    state.connection = "disconnected";
    render();
    setTimeout(connect, 1000);
  });

  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });
}

function handleMessage(message) {
  switch (message.type) {
    case "hello":
      return;
    case "state":
      {
        const queuedPrompt = state.queuedPrompt;

        state.view = message.data;
        if (state.view?.conversation) {
          setActiveSessionId(state.view.conversation.id);
          ensureLive(state.view.conversation.id);
          if (state.view.conversation.status !== "running") {
            resetLive(state.view.conversation.id);
          }
          elements.providerSelect.value = state.view.conversation.provider;
          elements.cwdInput.value = state.view.conversation.cwd;
          elements.sessionState.textContent = state.view.conversation.status;

          if (
            state.creatingSession &&
            queuedPrompt &&
            state.view.conversation.id !== state.creatingSessionFromId
          ) {
            state.creatingSession = false;
            state.creatingSessionFromId = null;
            state.queuedPrompt = null;
            submitPrompt(queuedPrompt);
          } else if (
            state.creatingSession &&
            state.view.conversation.id !== state.creatingSessionFromId
          ) {
            state.creatingSession = false;
            state.creatingSessionFromId = null;
          }
        }
      }
      render();
      return;
    case "event":
      consumeEvent(message.sessionId, message.event);
      render();
      return;
    case "info":
      addEvent(currentSessionId(), message.message);
      render();
      return;
    case "error":
      addEvent(currentSessionId(), `error: ${message.message}`);
      render();
      return;
    default:
      return;
  }
}

function consumeEvent(sessionId, event) {
  const live = ensureLive(sessionId);
  switch (event.type) {
    case "assistant.delta":
      live.assistant += event.delta;
      return;
    case "assistant.completed":
      live.assistant = event.text;
      return;
    case "reasoning.delta":
      live.reasoning += event.delta;
      return;
    case "command.delta":
      live.command += event.delta;
      return;
    case "tool.started":
      addEvent(sessionId, `tool start: ${event.label}`);
      return;
    case "tool.completed":
      addEvent(sessionId, `tool ${event.success ? "ok" : "fail"}: ${event.label}`);
      return;
    case "turn.started":
      patchSession(sessionId, {
        status: "running",
        activeTurnId: event.turnId,
        lastError: null
      });
      addEvent(sessionId, `turn started: ${event.turnId}`);
      return;
    case "turn.completed":
      patchSession(sessionId, {
        status: event.status === "failed" ? "error" : "idle",
        activeTurnId: null
      });
      addEvent(sessionId, `turn ${event.status}`);
      return;
    case "status":
      addEvent(sessionId, event.message);
      return;
    case "error":
      patchSession(sessionId, {
        status: "error",
        activeTurnId: null,
        lastError: event.message
      });
      resetLive(sessionId);
      addEvent(sessionId, `error: ${event.message}`);
      return;
    default:
      return;
  }
}

function addEvent(sessionId, text) {
  const live = ensureLive(sessionId);
  live.events.unshift({
    text,
    at: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
  });
  live.events = live.events.slice(0, 40);
}

function ensureLive(sessionId) {
  const key = sessionId || "__detached__";
  if (!state.liveBySession[key]) {
    state.liveBySession[key] = {
      pendingPrompt: "",
      assistant: "",
      reasoning: "",
      command: "",
      events: []
    };
  }
  return state.liveBySession[key];
}

function resetLive(sessionId) {
  const live = ensureLive(sessionId);
  live.pendingPrompt = "";
  live.assistant = "";
  live.reasoning = "";
  live.command = "";
}

function currentSessionId() {
  return state.view?.conversation?.id || state.activeSessionId || null;
}

function currentConversation() {
  return state.view?.conversation || null;
}

function currentLive() {
  return ensureLive(currentSessionId());
}

function submitPrompt(text) {
  const sessionId = currentSessionId();
  const live = ensureLive(sessionId);
  live.pendingPrompt = text;
  live.assistant = "";
  live.reasoning = "";
  live.command = "";
  patchSession(sessionId, conversation => ({
    status: "running",
    activeTurnId: null,
    lastError: null,
    sidebarPreview: previewText(text, 96),
    title:
      conversation?.title === "New session"
        ? previewText(text, 48) || conversation.title
        : conversation?.title
  }));
  addEvent(sessionId, `prompt: ${text.slice(0, 120)}`);
  render();
  send({ type: "prompt", text, sessionId });
}

function patchSession(sessionId, updates) {
  if (!state.view || !sessionId) {
    return;
  }

  const current =
    state.view.conversation?.id === sessionId
      ? state.view.conversation
      : (state.view.sessions || []).find(session => session.id === sessionId) || null;
  const nextPatch = typeof updates === "function" ? updates(current) : updates;

  if (!nextPatch) {
    return;
  }

  if (state.view.conversation?.id === sessionId) {
    state.view.conversation = {
      ...state.view.conversation,
      ...nextPatch
    };
  }

  if (Array.isArray(state.view.sessions)) {
    state.view.sessions = state.view.sessions.map(session =>
      session.id === sessionId
        ? {
            ...session,
            ...nextPatch
          }
        : session
    );
  }
}

function setActiveSessionId(sessionId) {
  state.activeSessionId = sessionId;
  if (sessionId) {
    localStorage.setItem("remote-control-active-session-id", sessionId);
  } else {
    localStorage.removeItem("remote-control-active-session-id");
  }
}

function render() {
  document.body.classList.toggle("sidebar-open", state.mobileSidebarOpen);
  document.body.classList.toggle("composer-settings-open", state.composerSettingsOpen);
  elements.sidebarToggleButton.setAttribute("aria-expanded", String(state.mobileSidebarOpen));
  elements.connectionStatus.textContent = state.connection;
  elements.connectionStatus.dataset.state = state.connection;

  const conversation = currentConversation();
  const activeThread = state.view?.activeThread;
  const hasState = Boolean(state.view?.conversation);
  const canInteract = state.connection === "connected" && hasState;

  elements.sessionTitle.textContent = conversation?.title || "New session";
  elements.threadMeta.textContent = activeThread
    ? `${activeThread.name || conversation?.title || "Untitled"} · ${basename(activeThread.cwd)} · ${shortThreadId(activeThread.id)}`
    : conversation
      ? `${conversation.title} · ${basename(conversation.cwd)}`
      : "No active session";
  elements.sessionState.textContent = conversation?.status || "idle";
  elements.cwdSummary.textContent = conversation?.cwd || "workspace";
  elements.refreshButton.disabled = !canInteract;
  elements.newButton.disabled = !canInteract;
  elements.syncActiveButton.disabled = !canInteract;
  elements.stopButton.disabled = !canInteract || conversation?.status !== "running";
  elements.stopButton.hidden = conversation?.status !== "running";
  elements.providerSelect.disabled = !canInteract || conversation?.status === "running";
  elements.composerSettingsButton.disabled = !canInteract || conversation?.status === "running";
  elements.cwdInput.disabled = !canInteract || conversation?.status === "running";
  elements.applyCwdButton.disabled = !canInteract || conversation?.status === "running";
  elements.promptInput.disabled = !canInteract;
  elements.submitButton.disabled = !canInteract || !elements.promptInput.value.trim();
  elements.composerSettings.hidden = !state.composerSettingsOpen;
  elements.composerSettingsButton.setAttribute("aria-expanded", String(state.composerSettingsOpen));
  elements.composerSettingsButton.textContent = workspaceButtonLabel(conversation?.cwd);

  renderSessionList();
  renderNativeThreadList();
  renderProviderPills(conversation?.provider || elements.providerSelect.value);
  renderTranscript();
  renderActivity();
}

function renderSessionList() {
  const activeId = currentSessionId();
  const sessions = (state.view?.sessions || []).filter(
    session =>
      session.id === activeId ||
      session.status === "running" ||
      Boolean(session.providerThreadId)
  );
  elements.sessionGroups.innerHTML = "";

  if (sessions.length === 0) {
    elements.sessionGroups.innerHTML = '<div class="empty-sidebar">No remote sessions yet.</div>';
    return;
  }

  const groups = groupSessionsByDay(sessions);
  for (const group of groups) {
    if (!group.sessions.length) {
      continue;
    }

    const wrapper = document.createElement("section");
    wrapper.className = "session-group";
    wrapper.innerHTML = `<div class="session-group-label">${escapeHtml(group.label)}</div>`;

    for (const session of group.sessions) {
      const button = document.createElement("button");
      button.className = `thread-item${session.id === activeId ? " active" : ""}`;
      button.innerHTML = `
        <div class="thread-item-topline">
          <div class="thread-item-title">${escapeHtml(session.title || "New session")}</div>
          <div class="thread-item-status ${escapeHtml(session.status)}">${escapeHtml(shortStatus(session.status))}</div>
        </div>
        <div class="thread-item-preview">${escapeHtml(sessionPreview(session))}</div>
      `;
      button.addEventListener("click", () => {
        closeSidebar();
        setActiveSessionId(session.id);
        send({ type: "select", sessionId: session.id });
      });
      wrapper.appendChild(button);
    }

    elements.sessionGroups.appendChild(wrapper);
  }
}

function renderNativeThreadList() {
  const container = elements.nativeThreadList;
  container.innerHTML = "";

  if (state.view?.activeLocalSessionsSupported === false) {
    container.innerHTML = `<div class="empty-sidebar">Active local terminal sync is not available on ${escapeHtml(
      state.view.platform || "this OS"
    )} yet.</div>`;
    return;
  }

  const sessions = state.view?.sessions || [];
  const attachedSessionsByThreadId = new Map(
    sessions
      .filter(session => session.providerThreadId)
      .map(session => [session.providerThreadId, session])
  );
  const activeLocalSessions = state.view?.activeLocalSessions || [];

  if (!activeLocalSessions.length) {
    container.innerHTML = '<div class="empty-sidebar">No active local terminals right now.</div>';
    return;
  }

  const wrapper = document.createElement("section");
  wrapper.className = "session-group";

  for (const thread of activeLocalSessions) {
    const attachedSession = attachedSessionsByThreadId.get(thread.threadId);
    const button = document.createElement("button");
    button.className = "thread-item native-thread-item";
    button.innerHTML = `
      <div class="thread-item-topline">
        <div class="thread-item-titleline">
          <span class="active-dot"></span>
          <div class="thread-item-title">${escapeHtml(thread.tty ? `pts/${thread.tty}` : "local terminal")}</div>
        </div>
        <div class="thread-item-status">${escapeHtml(attachedSession ? "synced" : shortThreadId(thread.threadId))}</div>
      </div>
      <div class="thread-item-preview">${escapeHtml(attachedSession?.title || basename(thread.cwd))} · ${escapeHtml(thread.cwd)}</div>
    `;
    button.addEventListener("click", () => {
      closeSidebar();
      if (attachedSession) {
        setActiveSessionId(attachedSession.id);
        send({ type: "select", sessionId: attachedSession.id });
        return;
      }
      send({ type: "import", threadId: thread.threadId });
    });
    wrapper.appendChild(button);
  }

  container.appendChild(wrapper);
}

function renderTranscript() {
  const container = elements.transcript;
  container.innerHTML = "";

  const transcript = state.view?.activeThread?.transcript || [];
  const live = currentLive();
  const showLiveStream =
    currentConversation()?.status === "running" ||
    Boolean(
      live.pendingPrompt.trim() ||
        live.reasoning.trim() ||
        live.assistant.trim() ||
        live.command.trim()
    );

  for (const entry of transcript) {
    container.appendChild(renderEntry(entry));
  }

  if (showLiveStream && live.pendingPrompt) {
    container.appendChild(renderBubble("user", live.pendingPrompt, "Pending"));
  }
  if (showLiveStream && live.reasoning.trim()) {
    container.appendChild(renderBubble("reasoning", live.reasoning, "Thinking"));
  }
  if (showLiveStream && live.assistant.trim()) {
    container.appendChild(renderBubble("assistant", live.assistant, "Assistant"));
  }
  if (showLiveStream && live.command.trim()) {
    container.appendChild(renderBubble("tool", live.command, "Command output"));
  }

  if (!transcript.length && !live.pendingPrompt && !live.reasoning && !live.assistant) {
    container.appendChild(
      renderBubble(
        "plan",
        "This sidebar now shows only remote-control sessions. Start a prompt here and this session will stay lightweight and local to this client.",
        "Ready"
      )
    );
  }

  container.scrollTop = container.scrollHeight;
}

function renderEntry(entry) {
  switch (entry.kind) {
    case "user":
      return renderBubble("user", entry.text, "You");
    case "assistant":
      return renderBubble("assistant", entry.text, "Assistant");
    case "reasoning":
      return renderBubble("reasoning", entry.text, "Thinking");
    case "plan":
      return renderBubble("plan", entry.text, "Plan");
    case "tool":
      return renderBubble("tool", `${entry.title}\n${entry.text}`.trim(), entry.status);
    default:
      return renderBubble("assistant", JSON.stringify(entry), "Unknown");
  }
}

function renderBubble(kind, text, label) {
  const article = document.createElement("article");
  article.className = `bubble ${kind}`;
  article.innerHTML = `
    <div class="bubble-label">${escapeHtml(label)}</div>
    <pre class="bubble-body">${escapeHtml(text || "")}</pre>
  `;
  return article;
}

function renderActivity() {
  const live = currentLive();
  elements.eventFeed.innerHTML = live.events
    .slice(0, 8)
    .map(item => `<div class="event-pill">${escapeHtml(item.at)} · ${escapeHtml(item.text)}</div>`)
    .join("");
  elements.eventFeed.hidden = live.events.length === 0;
}

function sessionPreview(session) {
  if (session.lastError) {
    return `Error: ${session.lastError}`;
  }
  if (session.sidebarPreview) {
    return session.sidebarPreview;
  }
  if (session.providerThreadId) {
    return "Attached to native thread";
  }
  return "No turns yet";
}

function shortThreadId(threadId) {
  return threadId ? threadId.slice(0, 8) : "native";
}

function relativeTime(iso) {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return "now";
  }

  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function shortStatus(status) {
  if (status === "running") {
    return "Live";
  }
  if (status === "error") {
    return "Error";
  }
  return "Idle";
}

function workspaceButtonLabel(cwd) {
  const name = basename(cwd || "");
  if (!name || name === "/") {
    return "Workspace";
  }
  return `Workspace: ${name}`;
}

function renderProviderPills(activeProvider) {
  for (const button of elements.providerPills.querySelectorAll(".provider-pill")) {
    const isActive = button.dataset.provider === activeProvider;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
    button.disabled = elements.providerSelect.disabled;
  }
}

function toggleSidebar() {
  state.mobileSidebarOpen = !state.mobileSidebarOpen;
  render();
}

function closeSidebar() {
  if (!state.mobileSidebarOpen) {
    return;
  }
  state.mobileSidebarOpen = false;
  render();
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function groupSessionsByDay(sessions) {
  const today = [];
  const yesterday = [];
  const older = [];
  const now = new Date();
  const todayKey = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterdayKey = dayKey(yesterdayDate);

  for (const session of sessions) {
    const key = dayKey(new Date(session.updatedAt));
    if (key === todayKey) {
      today.push(session);
    } else if (key === yesterdayKey) {
      yesterday.push(session);
    } else {
      older.push(session);
    }
  }

  return [
    { label: "Today", sessions: today },
    { label: "Yesterday", sessions: yesterday },
    { label: "Older", sessions: older }
  ];
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function basename(pathname) {
  if (!pathname) {
    return "workspace";
  }
  const parts = String(pathname).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || pathname;
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addEvent(currentSessionId(), "socket not connected");
    render();
    return;
  }
  socket.send(JSON.stringify(payload));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function previewText(input, limit) {
  const normalized = String(input || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, limit);
}
