import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import process from "node:process";
import { AsyncQueue } from "../runtime/async-queue.js";
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSessionHandle,
  ProviderStreamEvent,
  ProviderThreadDetails,
  ProviderThreadSummary,
  ProviderTranscriptEntry,
  ResumeSessionInput,
  RunTurnInput,
  StartSessionInput
} from "../types.js";
import { JsonRpcWsClient } from "./json-rpc-client.js";

type CodexConfig = {
  model: string | null;
  modelProvider: string | null;
  port: number;
  appServerUrl: string | null;
  autoSpawn: boolean;
  configOverrides: string[];
};

type ThreadStartResponse = {
  thread: {
    id: string;
    cwd: string;
  };
};

type ThreadResumeResponse = ThreadStartResponse;

type ThreadListResponse = {
  data: Array<{
    id: string;
    name: string | null;
    preview: string;
    cwd: string;
    path: string | null;
    updatedAt: number;
    status: { type: string };
  }>;
};

type ThreadReadResponse = {
  thread: {
    id: string;
    name: string | null;
    preview: string;
    cwd: string;
    path: string | null;
    updatedAt: number;
    status: { type: string };
    turns: Array<{
      items: Array<Record<string, unknown>>;
    }>;
  };
};

type TurnStartResponse = {
  turn: {
    id: string;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  interrupt: true
};

export class CodexAppServerProvider implements ProviderAdapter {
  readonly kind = "codex" as const;
  readonly capabilities = DEFAULT_CAPABILITIES;

  private client: JsonRpcWsClient | null = null;
  private process: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly config: CodexConfig) {}

  async start(): Promise<void> {
    if (this.client) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = null;

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
    this.process = null;
  }

  async startSession(input: StartSessionInput): Promise<ProviderSessionHandle> {
    await this.start();
    const response = await this.client!.request<ThreadStartResponse>("thread/start", {
      cwd: input.cwd,
      model: input.model ?? this.config.model,
      modelProvider: input.modelProvider ?? this.config.modelProvider,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });

    return {
      threadId: response.thread.id,
      cwd: response.thread.cwd
    };
  }

  async resumeSession(input: ResumeSessionInput): Promise<ProviderSessionHandle> {
    await this.start();
    const response = await this.client!.request<ThreadResumeResponse>("thread/resume", {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model ?? this.config.model,
      modelProvider: input.modelProvider ?? this.config.modelProvider,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      persistExtendedHistory: false
    });

    return {
      threadId: response.thread.id,
      cwd: response.thread.cwd
    };
  }

  async listThreads(limit = 10): Promise<ProviderThreadSummary[]> {
    await this.start();
    const response = await this.client!.request<ThreadListResponse>("thread/list", {
      limit,
      archived: false
    });

    return response.data.map(thread => ({
      id: thread.id,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
      status: thread.status.type
    }));
  }

  async readThread(threadId: string, includeTurns = false): Promise<ProviderThreadDetails> {
    await this.start();
    const response = await this.client!.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns
    });

    return {
      id: response.thread.id,
      name: response.thread.name,
      preview: response.thread.preview,
      cwd: response.thread.cwd,
      path: response.thread.path,
      updatedAt: response.thread.updatedAt,
      status: response.thread.status.type,
      transcript: includeTurns ? this.mapTranscript(response.thread.turns) : []
    };
  }

  async *runTurn(input: RunTurnInput): AsyncGenerator<ProviderStreamEvent> {
    await this.start();

    const queue = new AsyncQueue<ProviderStreamEvent>();
    let completed = false;

    const unsubscribe = this.client!.onNotification((message: JsonRpcNotification) => {
      this.handleTurnNotification(message, input.threadId, queue);
    });

    try {
      const response = await this.client!.request<TurnStartResponse>("turn/start", {
        threadId: input.threadId,
        input: [
          {
            type: "text",
            text: input.prompt,
            text_elements: []
          }
        ],
        cwd: input.cwd ?? null,
        model: input.model ?? this.config.model,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      });

      queue.push({ type: "turn.started", turnId: response.turn.id });

      while (true) {
        const next = await queue.next();
        if (next.done) {
          break;
        }

        if (next.value.type === "turn.completed") {
          completed = true;
        }

        yield next.value;
      }
    } finally {
      unsubscribe();
      if (!completed) {
        queue.close();
      }
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.start();
    await this.client!.request<Record<string, never>>("turn/interrupt", {
      threadId,
      turnId
    });
  }

  private async startInternal(): Promise<void> {
    const url = this.config.appServerUrl ?? `ws://127.0.0.1:${this.config.port}`;

    if (!this.config.appServerUrl && this.config.autoSpawn) {
      const args = [
        "app-server",
        "--listen",
        url,
        ...this.config.configOverrides.flatMap(value => ["-c", value])
      ];
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
      this.process = child;

      child.stdout.on("data", chunk => {
        const text = chunk.toString();
        if (text.trim() !== "") {
          process.stdout.write(`[codex-app-server] ${text}`);
        }
      });

      child.stderr.on("data", chunk => {
        const text = chunk.toString();
        if (text.trim() !== "") {
          process.stderr.write(`[codex-app-server] ${text}`);
        }
      });

      await this.waitForReady(url);
    }

    this.client = new JsonRpcWsClient(url);
    await this.client.connect();
    await this.client.request("initialize", {
      clientInfo: {
        name: "remote-control",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.client.notify("initialized");
  }

  private async waitForReady(url: string): Promise<void> {
    const readyUrl = url.replace("ws://", "http://").replace("wss://", "https://") + "/readyz";
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(readyUrl);
        if (response.ok) {
          return;
        }
      } catch {
        // ignore and retry
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for Codex app-server readyz at ${readyUrl}`);
  }

  private handleTurnNotification(
    message: JsonRpcNotification,
    threadId: string,
    queue: AsyncQueue<ProviderStreamEvent>
  ): void {
    if (!message.params || typeof message.params !== "object") {
      return;
    }

    const params = message.params as Record<string, unknown>;
    const eventThreadId = typeof params.threadId === "string" ? params.threadId : null;
    if (eventThreadId !== null && eventThreadId !== threadId) {
      return;
    }

    switch (message.method) {
      case "item/agentMessage/delta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta !== "") {
          queue.push({ type: "assistant.delta", delta });
        }
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta !== "") {
          queue.push({ type: "reasoning.delta", delta });
        }
        return;
      }
      case "item/commandExecution/outputDelta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta !== "") {
          queue.push({ type: "command.delta", delta });
        }
        return;
      }
      case "item/completed": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item || typeof item.type !== "string") {
          return;
        }

        if (item.type === "agentMessage" && typeof item.text === "string") {
          queue.push({ type: "assistant.completed", text: item.text });
          return;
        }

        if (item.type === "commandExecution" && typeof item.command === "string") {
          const success = item.exitCode === 0;
          queue.push({
            type: "tool.completed",
            label: item.command,
            success
          });
          return;
        }

        if (item.type === "mcpToolCall" && typeof item.tool === "string") {
          queue.push({
            type: "tool.completed",
            label: `${String(item.server ?? "mcp")}::${item.tool}`,
            success: item.error == null
          });
        }
        return;
      }
      case "item/started": {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item || typeof item.type !== "string") {
          return;
        }

        if (item.type === "commandExecution" && typeof item.command === "string") {
          queue.push({ type: "tool.started", label: item.command });
        } else if (item.type === "mcpToolCall" && typeof item.tool === "string") {
          queue.push({
            type: "tool.started",
            label: `${String(item.server ?? "mcp")}::${item.tool}`
          });
        }
        return;
      }
      case "turn/completed": {
        const turn = params.turn as Record<string, unknown> | undefined;
        const turnId = typeof turn?.id === "string" ? turn.id : "";
        const status = turn?.status;
        const normalizedStatus =
          status === "interrupted" || status === "failed" ? status : "completed";

        queue.push({
          type: "turn.completed",
          turnId,
          status: normalizedStatus
        });
        queue.close();
        return;
      }
      case "error": {
        const nestedError =
          params.error && typeof params.error === "object"
            ? (params.error as Record<string, unknown>)
            : null;
        const messageText =
          typeof nestedError?.message === "string"
            ? nestedError.message
            : typeof params.message === "string"
              ? params.message
              : "Unknown Codex error";
        queue.push({ type: "error", message: messageText });
        return;
      }
      default:
        return;
    }
  }

  private mapTranscript(
    turns: Array<{
      items: Array<Record<string, unknown>>;
    }>
  ): ProviderTranscriptEntry[] {
    const transcript: ProviderTranscriptEntry[] = [];

    for (const turn of turns) {
      for (const item of turn.items) {
        const entry = this.mapTranscriptItem(item);
        if (entry) {
          transcript.push(entry);
        }
      }
    }

    return transcript;
  }

  private mapTranscriptItem(item: Record<string, unknown>): ProviderTranscriptEntry | null {
    const id = typeof item.id === "string" ? item.id : `item-${Math.random().toString(36).slice(2)}`;
    const type = typeof item.type === "string" ? item.type : null;
    if (!type) {
      return null;
    }

    switch (type) {
      case "userMessage": {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content
          .map(part =>
            part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
              ? String((part as Record<string, unknown>).text ?? "")
              : ""
          )
          .filter(Boolean)
          .join("\n");
        return { id, kind: "user", text };
      }
      case "agentMessage":
        return { id, kind: "assistant", text: String(item.text ?? "") };
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? item.summary.map(value => String(value)) : [];
        const content = Array.isArray(item.content) ? item.content.map(value => String(value)) : [];
        return {
          id,
          kind: "reasoning",
          text: [...summary, ...content].join("\n"),
          summary,
          content
        };
      }
      case "plan":
        return { id, kind: "plan", text: String(item.text ?? "") };
      case "commandExecution":
        return {
          id,
          kind: "tool",
          title: String(item.command ?? "command"),
          text: String(item.aggregatedOutput ?? ""),
          status: String(item.status ?? "unknown")
        };
      case "mcpToolCall":
        return {
          id,
          kind: "tool",
          title: `${String(item.server ?? "mcp")}::${String(item.tool ?? "tool")}`,
          text: item.result == null ? "" : JSON.stringify(item.result, null, 2),
          status: String(item.status ?? "unknown")
        };
      case "dynamicToolCall":
        return {
          id,
          kind: "tool",
          title: String(item.tool ?? "dynamic tool"),
          text: item.contentItems == null ? "" : JSON.stringify(item.contentItems, null, 2),
          status: String(item.status ?? "unknown")
        };
      default:
        return null;
    }
  }
}
