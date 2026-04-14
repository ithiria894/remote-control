import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SessionStore } from "../storage/session-store.js";
import type {
  ProviderKind,
  ProviderThreadDetails,
  ProviderThreadSummary,
  StoredConversation,
  TransportKind
} from "../types.js";

export type ChatStreamEvent =
  | { type: "status"; message: string }
  | { type: "assistant.delta"; delta: string }
  | { type: "assistant.completed"; text: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.started"; label: string }
  | { type: "tool.completed"; label: string; success: boolean }
  | { type: "command.delta"; delta: string }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.completed"; turnId: string; status: "completed" | "interrupted" | "failed" }
  | { type: "error"; message: string };

export type ConversationView = {
  conversation: StoredConversation;
  sessions: StoredConversation[];
  activeThread: ProviderThreadDetails | null;
};

type PromptStreamOptions = {
  transport: TransportKind;
  transportId: string;
  sessionId?: string | null;
  prompt: string;
};

type AttachThreadResult = {
  conversation: StoredConversation;
  thread: ProviderThreadDetails;
};

export class ChatService {
  private readonly runningConversations = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly providers: ProviderRegistry
  ) {}

  async ensureConversation(
    transport: TransportKind,
    transportId: string,
    sessionId?: string | null
  ): Promise<StoredConversation> {
    return this.store.getOrCreateConversation(
      transport,
      transportId,
      sessionId ?? this.defaultSessionId(transport),
      this.config.defaultProvider,
      this.config.defaultCwd
    );
  }

  async createConversation(
    transport: TransportKind,
    transportId: string,
    title = "New session"
  ): Promise<StoredConversation> {
    return this.store.createConversation(
      transport,
      transportId,
      this.config.defaultProvider,
      this.config.defaultCwd,
      undefined,
      title
    );
  }

  async getConversation(
    transport: TransportKind,
    transportId: string,
    sessionId?: string | null
  ): Promise<StoredConversation> {
    return this.ensureConversation(transport, transportId, sessionId);
  }

  async getConversationView(
    transport: TransportKind,
    transportId: string,
    sessionId?: string | null
  ): Promise<ConversationView> {
    let conversation = await this.ensureConversation(transport, transportId, sessionId);
    const sessions = this.store.listOwned(transport, transportId);
    const provider = this.providers.get(conversation.provider);
    const activeThread = conversation.providerThreadId
      ? await provider.readThread(conversation.providerThreadId, true)
      : null;

    if (activeThread) {
      const updates: Partial<
        Omit<StoredConversation, "id" | "key" | "transport" | "ownerId" | "createdAt">
      > = {};

      if (conversation.title === "New session" && activeThread.name) {
        updates.title = activeThread.name;
      }
      if (!conversation.sidebarPreview && activeThread.preview) {
        updates.sidebarPreview = activeThread.preview;
      }
      if (conversation.cwd !== activeThread.cwd) {
        updates.cwd = activeThread.cwd;
      }

      if (Object.keys(updates).length > 0) {
        conversation = await this.store.patch(conversation.key, updates);
      }
    }

    return {
      conversation,
      sessions: this.store.listOwned(transport, transportId),
      activeThread
    };
  }

  async resetConversation(
    transport: TransportKind,
    transportId: string,
    sessionId?: string | null
  ): Promise<StoredConversation> {
    const conversation = await this.ensureConversation(transport, transportId, sessionId);
    return this.store.resetThread(conversation.key);
  }

  async stopConversation(
    transport: TransportKind,
    transportId: string,
    sessionId?: string | null
  ): Promise<string> {
    const conversation = await this.ensureConversation(transport, transportId, sessionId);
    if (!conversation.providerThreadId || !conversation.activeTurnId) {
      return "而家冇 active turn。";
    }

    const provider = this.providers.get(conversation.provider);
    if (!provider.capabilities.interrupt) {
      return `${conversation.provider} provider 暫時唔支援 interrupt。`;
    }

    await provider.interruptTurn(conversation.providerThreadId, conversation.activeTurnId);
    return "已送出 interrupt。";
  }

  async setConversationProvider(
    transport: TransportKind,
    transportId: string,
    sessionId: string | null | undefined,
    provider: ProviderKind
  ): Promise<StoredConversation> {
    const conversation = await this.ensureConversation(transport, transportId, sessionId);
    if (conversation.status === "running") {
      throw new Error("呢個 session 仲有 active turn，請等佢完或者先用 /stop。");
    }

    return this.store.patch(conversation.key, {
      provider,
      providerThreadId: null,
      activeTurnId: null,
      status: "idle",
      lastError: null
    });
  }

  async setConversationCwd(
    transport: TransportKind,
    transportId: string,
    sessionId: string | null | undefined,
    nextCwd: string
  ): Promise<StoredConversation> {
    const conversation = await this.ensureConversation(transport, transportId, sessionId);
    const resolved = path.resolve(nextCwd);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`唔係 directory: ${resolved}`);
    }

    return this.store.patch(conversation.key, {
      cwd: resolved
    });
  }

  async listThreads(
    transport: TransportKind,
    transportId: string,
    sessionId: string | null | undefined,
    limit = 10
  ): Promise<ProviderThreadSummary[]> {
    const conversation = await this.ensureConversation(transport, transportId, sessionId);
    const provider = this.providers.get(conversation.provider);
    return provider.listThreads(limit);
  }

  async attachThread(
    transport: TransportKind,
    transportId: string,
    sessionId: string | null | undefined,
    threadId: string
  ): Promise<AttachThreadResult> {
    const conversation = await this.ensureConversation(transport, transportId, sessionId);
    if (conversation.status === "running") {
      throw new Error("呢個 session 仲有 active turn，請等佢完或者先用 /stop。");
    }

    const provider = this.providers.get(conversation.provider);
    const thread = await provider.readThread(threadId, true);
    const updated = await this.store.patch(conversation.key, {
      title: thread.name || conversation.title,
      sidebarPreview: thread.preview || conversation.sidebarPreview,
      providerThreadId: thread.id,
      cwd: thread.cwd,
      activeTurnId: null,
      status: "idle",
      lastError: null
    });

    return {
      conversation: updated,
      thread
    };
  }

  async *runPrompt(options: PromptStreamOptions): AsyncGenerator<ChatStreamEvent> {
    const conversation = await this.ensureConversation(
      options.transport,
      options.transportId,
      options.sessionId
    );
    if (this.runningConversations.has(conversation.key) || conversation.status === "running") {
      throw new Error("呢個 session 已經有一個 turn 跑緊。等佢完，或者用 /stop。");
    }

    this.runningConversations.add(conversation.key);
    let current = await this.store.patch(conversation.key, {
      title: this.nextConversationTitle(conversation, options.prompt),
      sidebarPreview: this.previewText(options.prompt),
      status: "running",
      lastError: null
    });

    try {
      const provider = this.providers.get(current.provider);
      await provider.start();

      if (!current.providerThreadId) {
        const handle = await provider.startSession({
          cwd: current.cwd,
          model: this.providerModel(current.provider),
          modelProvider: this.providerModelProvider(current.provider)
        });

        current = await this.store.patch(current.key, {
          providerThreadId: handle.threadId,
          cwd: handle.cwd
        });

        yield {
          type: "status",
          message: `已建立新 ${current.provider} thread`
        };
      }

      for await (const event of provider.runTurn({
        threadId: current.providerThreadId!,
        prompt: options.prompt,
        cwd: current.cwd,
        model: this.providerModel(current.provider),
        modelProvider: this.providerModelProvider(current.provider)
      })) {
        if (event.type === "turn.started") {
          current = await this.store.patch(current.key, {
            activeTurnId: event.turnId,
            status: "running"
          });
          yield event;
          continue;
        }

        if (event.type === "turn.completed") {
          current = await this.store.patch(current.key, {
            activeTurnId: null,
            status: event.status === "failed" ? "error" : "idle"
          });
          yield event;
          continue;
        }

        if (event.type === "error") {
          current = await this.store.patch(current.key, {
            lastError: event.message,
            status: "error"
          });
          yield event;
          continue;
        }

        yield event;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.patch(current.key, {
        activeTurnId: null,
        status: "error",
        lastError: message
      });
      yield {
        type: "error",
        message
      };
    } finally {
      const latest = this.store.get(current.key);
      if (latest?.status === "running") {
        await this.store.patch(current.key, {
          activeTurnId: null,
          status: "idle"
        });
      }
      this.runningConversations.delete(current.key);
    }
  }

  private providerModel(provider: ProviderKind): string | null {
    if (provider === "codex") {
      return this.config.codex.model;
    }
    return null;
  }

  private providerModelProvider(provider: ProviderKind): string | null {
    if (provider === "codex") {
      return this.config.codex.modelProvider;
    }
    return null;
  }

  private defaultSessionId(transport: TransportKind): string | null {
    if (transport === "telegram") {
      return "default";
    }
    return null;
  }

  private nextConversationTitle(conversation: StoredConversation, prompt: string): string {
    if (conversation.title !== "New session") {
      return conversation.title;
    }

    return this.previewText(prompt, 48) || "New session";
  }

  private previewText(input: string, limit = 96): string | null {
    const normalized = input.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return null;
    }
    return normalized.slice(0, limit);
  }
}
