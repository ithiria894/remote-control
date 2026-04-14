const state = {
  clientId: localStorage.getItem("remote-control-client-id") || crypto.randomUUID(),
  activeSessionId: localStorage.getItem("remote-control-active-session-id") || null,
  connection: "connecting",
  view: null,
  liveBySession: {}
};

localStorage.setItem("remote-control-client-id", state.clientId);

const elements = {
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
  promptInput: document.getElementById("promptInput"),
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
  elements.newButton.addEventListener("click", () => send({ type: "new" }));
  elements.syncActiveButton.addEventListener("click", () => send({ type: "sync-active-local" }));
  elements.stopButton.addEventListener("click", () => send({ type: "stop" }));
  elements.applyCwdButton.addEventListener("click", () => {
    const cwd = elements.cwdInput.value.trim();
    if (cwd) {
      send({ type: "cwd", cwd });
    }
  });
  elements.providerSelect.addEventListener("change", () => {
    send({ type: "provider", provider: elements.providerSelect.value });
  });
  elements.composer.addEventListener("submit", event => {
    event.preventDefault();
    const text = elements.promptInput.value.trim();
    if (!text) {
      return;
    }

    const sessionId = currentSessionId();
    const live = ensureLive(sessionId);
    live.pendingPrompt = text;
    live.assistant = "";
    live.reasoning = "";
    live.command = "";
    addEvent(sessionId, `prompt: ${text.slice(0, 120)}`);
    render();
    send({ type: "prompt", text });
    elements.promptInput.value = "";
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
      state.view = message.data;
      if (state.view?.conversation) {
        setActiveSessionId(state.view.conversation.id);
        ensureLive(state.view.conversation.id);
        elements.providerSelect.value = state.view.conversation.provider;
        elements.cwdInput.value = state.view.conversation.cwd;
        elements.sessionState.textContent = state.view.conversation.status;
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
      addEvent(sessionId, `turn started: ${event.turnId}`);
      return;
    case "turn.completed":
      resetLive(sessionId);
      addEvent(sessionId, `turn ${event.status}`);
      return;
    case "status":
      addEvent(sessionId, event.message);
      return;
    case "error":
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

function setActiveSessionId(sessionId) {
  state.activeSessionId = sessionId;
  if (sessionId) {
    localStorage.setItem("remote-control-active-session-id", sessionId);
  } else {
    localStorage.removeItem("remote-control-active-session-id");
  }
}

function render() {
  elements.connectionStatus.textContent = state.connection;
  elements.connectionStatus.dataset.state = state.connection;

  const conversation = currentConversation();
  const activeThread = state.view?.activeThread;

  elements.sessionTitle.textContent = conversation?.title || "New session";
  elements.threadMeta.textContent = activeThread
    ? `${activeThread.name || conversation?.title || "Untitled"} · ${basename(activeThread.cwd)} · ${shortThreadId(activeThread.id)}`
    : conversation
      ? `${conversation.title} · ${basename(conversation.cwd)}`
      : "No active session";
  elements.cwdSummary.textContent = conversation?.cwd || "workspace";

  renderSessionList();
  renderNativeThreadList();
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
  const showLiveStream = currentConversation()?.status === "running";
  for (const entry of transcript) {
    container.appendChild(renderEntry(entry));
  }

  const live = currentLive();
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
  const parts = pathname.split("/").filter(Boolean);
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
