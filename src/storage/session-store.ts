import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderKind, SessionStoreState, StoredConversation, TransportKind } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(): SessionStoreState {
  return { conversations: {} };
}

export class SessionStore {
  private readonly filePath: string;
  private state: SessionStoreState = emptyState();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "sessions.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.state = this.normalizeState(JSON.parse(raw) as SessionStoreState);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.state = emptyState();
      await this.flush();
      return;
    }

    await this.flush();
  }

  list(): StoredConversation[] {
    return Object.values(this.state.conversations).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  get(key: string): StoredConversation | null {
    return this.state.conversations[key] ?? null;
  }

  listOwned(transport: TransportKind, ownerId: string): StoredConversation[] {
    return this.list().filter(
      conversation => conversation.transport === transport && conversation.ownerId === ownerId
    );
  }

  getOwned(transport: TransportKind, ownerId: string, sessionId: string): StoredConversation | null {
    return this.get(this.buildKey(transport, ownerId, sessionId));
  }

  getLatestOwned(transport: TransportKind, ownerId: string): StoredConversation | null {
    return this.listOwned(transport, ownerId)[0] ?? null;
  }

  async getOrCreateConversation(
    transport: TransportKind,
    ownerId: string,
    sessionId: string | null,
    provider: ProviderKind,
    cwd: string
  ): Promise<StoredConversation> {
    if (sessionId) {
      const existing = this.getOwned(transport, ownerId, sessionId);
      if (existing) {
        return existing;
      }

      return this.createConversation(transport, ownerId, provider, cwd, sessionId);
    }

    const latest = this.getLatestOwned(transport, ownerId);
    if (latest) {
      return latest;
    }

    return this.createConversation(transport, ownerId, provider, cwd);
  }

  async createConversation(
    transport: TransportKind,
    ownerId: string,
    provider: ProviderKind,
    cwd: string,
    sessionId: string = randomUUID(),
    title = "New session"
  ): Promise<StoredConversation> {
    const key = this.buildKey(transport, ownerId, sessionId);
    const created: StoredConversation = {
      id: sessionId,
      key,
      transport,
      ownerId,
      title,
      sidebarPreview: null,
      provider,
      cwd,
      providerThreadId: null,
      activeTurnId: null,
      status: "idle",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastError: null
    };

    this.state.conversations[key] = created;
    await this.flush();
    return created;
  }

  async getOrCreateTelegramConversation(
    ownerId: string,
    provider: ProviderKind,
    cwd: string
  ): Promise<StoredConversation> {
    return this.getOrCreateConversation("telegram", ownerId, "default", provider, cwd);
  }

  async getOrCreateWebConversation(
    ownerId: string,
    provider: ProviderKind,
    cwd: string,
    sessionId: string | null
  ): Promise<StoredConversation> {
    return this.getOrCreateConversation("web", ownerId, sessionId, provider, cwd);
  }

  async patch(
    key: string,
    updates: Partial<Omit<StoredConversation, "id" | "key" | "transport" | "ownerId" | "createdAt">>
  ): Promise<StoredConversation> {
    const current = this.get(key);
    if (!current) {
      throw new Error(`Conversation not found: ${key}`);
    }

    const next: StoredConversation = {
      ...current,
      ...updates,
      updatedAt: nowIso()
    };
    this.state.conversations[key] = next;
    await this.flush();
    return next;
  }

  async resetThread(key: string): Promise<StoredConversation> {
    return this.patch(key, {
      providerThreadId: null,
      activeTurnId: null,
      status: "idle",
      lastError: null
    });
  }

  private async flush(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  private buildKey(transport: TransportKind, ownerId: string, sessionId: string): string {
    return `${transport}:${ownerId}:${sessionId}`;
  }

  private normalizeState(input: SessionStoreState): SessionStoreState {
    const normalizedEntries = Object.entries(input.conversations ?? {}).map(([rawKey, rawConversation]) => {
      const transport = rawConversation.transport;
      const ownerId =
        typeof rawConversation.ownerId === "string"
          ? rawConversation.ownerId
          : typeof (rawConversation as { chatId?: unknown }).chatId === "string"
            ? String((rawConversation as { chatId?: unknown }).chatId)
            : rawKey.split(":")[1] ?? "default";
      const id = typeof rawConversation.id === "string" ? rawConversation.id : "default";

      const normalized: StoredConversation = {
        id,
        key: this.buildKey(transport, ownerId, id),
        transport,
        ownerId,
        title: typeof rawConversation.title === "string" ? rawConversation.title : "New session",
        sidebarPreview:
          typeof rawConversation.sidebarPreview === "string" ? rawConversation.sidebarPreview : null,
        provider: rawConversation.provider,
        cwd: rawConversation.cwd,
        providerThreadId: rawConversation.providerThreadId,
        activeTurnId: rawConversation.activeTurnId,
        status: rawConversation.status,
        createdAt: rawConversation.createdAt,
        updatedAt: rawConversation.updatedAt,
        lastError: rawConversation.lastError
      };

      return [normalized.key, normalized] as const;
    });

    return {
      conversations: Object.fromEntries(normalizedEntries)
    };
  }
}
