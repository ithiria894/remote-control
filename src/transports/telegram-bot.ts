import process from "node:process";
import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Update } from "telegraf/types";
import type { AppConfig } from "../config.js";
import { ChatService, type ChatStreamEvent } from "../runtime/chat-service.js";
import type { ProviderKind, ProviderThreadSummary, StoredConversation } from "../types.js";

type TextContext = Context<Update>;

type EditableMessage = {
  messageId: number;
};

function chunkText(text: string, size = 3900): string[] {
  if (text.length <= size) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function conversationSummary(conversation: StoredConversation): string {
  const parts = [
    `provider: ${conversation.provider}`,
    `cwd: ${conversation.cwd}`,
    `thread: ${conversation.providerThreadId ?? "none"}`,
    `status: ${conversation.status}`
  ];
  if (conversation.lastError) {
    parts.push(`last_error: ${conversation.lastError}`);
  }
  return parts.join("\n");
}

function formatThreadList(threads: ProviderThreadSummary[]): string {
  if (threads.length === 0) {
    return "搵唔到 thread。";
  }

  return threads
    .map(
      (thread, index) =>
        `${index + 1}. ${thread.id}\n${thread.name ?? "(untitled)"}\n${thread.cwd}\n${thread.preview}`
    )
    .join("\n\n");
}

class StreamingReply {
  private readonly toolLines: string[] = [];
  private assistantText = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private currentText = "";
  private message: EditableMessage | null = null;
  private dirty = false;

  constructor(
    private readonly ctx: TextContext,
    private readonly verboseTools: boolean
  ) {}

  async init(): Promise<void> {
    const sent = await this.ctx.reply("連緊 Codex...");
    this.message = {
      messageId: sent.message_id
    };
  }

  onEvent(event: ChatStreamEvent): void {
    switch (event.type) {
      case "status":
        this.pushToolLine(event.message);
        return;
      case "assistant.delta":
        this.assistantText += event.delta;
        this.scheduleFlush();
        return;
      case "assistant.completed":
        this.assistantText = event.text;
        this.scheduleFlush(true);
        return;
      case "tool.started":
        this.pushToolLine(`tool: ${event.label}`);
        return;
      case "tool.completed":
        this.pushToolLine(`${event.success ? "ok" : "fail"}: ${event.label}`);
        return;
      case "turn.started":
        this.pushToolLine(`turn: ${event.turnId}`);
        return;
      case "turn.completed":
        this.pushToolLine(`done: ${event.status}`);
        return;
      case "error":
        this.pushToolLine(`error: ${event.message}`);
        return;
      default:
        return;
    }
  }

  async finish(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
    await this.sendOverflowChunks();
  }

  private pushToolLine(line: string): void {
    if (!this.verboseTools) {
      return;
    }

    this.toolLines.push(line);
    if (this.toolLines.length > 6) {
      this.toolLines.shift();
    }
    this.scheduleFlush();
  }

  private scheduleFlush(immediate = false): void {
    this.dirty = true;
    if (immediate) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      void this.flush();
      return;
    }

    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 500);
  }

  private buildRenderText(): string {
    const status = this.verboseTools && this.toolLines.length > 0 ? this.toolLines.join("\n") : "";
    const body = this.assistantText.trim() === "" ? "…" : this.assistantText;
    const combined = status === "" ? body : `${status}\n\n${body}`;
    if (combined.length <= 3900) {
      return combined;
    }

    return `…\n${combined.slice(-3800)}`;
  }

  private async flush(): Promise<void> {
    if (!this.dirty || !this.message) {
      return;
    }

    const nextText = this.buildRenderText();
    if (nextText === this.currentText) {
      this.dirty = false;
      return;
    }

    this.currentText = nextText;
    this.dirty = false;

    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat!.id,
        this.message.messageId,
        undefined,
        nextText
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.includes("message is not modified")) {
        process.stderr.write(`[telegram] edit failed: ${text}\n`);
      }
    }
  }

  private async sendOverflowChunks(): Promise<void> {
    const combined = this.assistantText.trim() === "" ? this.currentText : this.assistantText;
    const chunks = chunkText(combined);
    if (chunks.length <= 1) {
      return;
    }

    if (this.message) {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat!.id,
        this.message.messageId,
        undefined,
        chunks[0]
      );
    }

    for (const chunk of chunks.slice(1)) {
      await this.ctx.reply(chunk);
    }
  }
}

export async function createTelegramBot(
  bot: Telegraf<Context<Update>>,
  config: AppConfig,
  chatService: ChatService
): Promise<void> {
  bot.use(async (ctx, next) => {
    if (!ctx.chat) {
      return;
    }

    if (config.telegramAllowedChatIds && !config.telegramAllowedChatIds.has(String(ctx.chat.id))) {
      if ("reply" in ctx) {
        await ctx.reply("呢個 chat 未授權。先喺 TELEGRAM_ALLOWED_CHAT_IDS 加入 chat id。");
      }
      return;
    }

    await next();
  });

  bot.command("start", async ctx => {
    await chatService.ensureConversation("telegram", String(ctx.chat.id));
    await ctx.reply(
      [
        "remote-control ready",
        "",
        "/status 查看目前 session",
        "/new 開新 thread",
        "/stop 中斷目前 turn",
        "/threads 列最近 threads",
        "/attach <threadId> 接返舊 thread",
        "/cwd <path> 改工作目錄",
        "/provider <codex|gemini> 切 provider",
        "",
        "直接 send message 就會同 Codex 傾。"
      ].join("\n")
    );
  });

  bot.command("help", async ctx => {
    await ctx.reply(
      [
        "/status",
        "/new",
        "/stop",
        "/threads",
        "/attach <threadId>",
        "/cwd <path>",
        "/provider <codex|gemini>"
      ].join("\n")
    );
  });

  bot.command("status", async ctx => {
    const conversation = await chatService.getConversation("telegram", String(ctx.chat.id));
    await ctx.reply(conversationSummary(conversation));
  });

  bot.command("new", async ctx => {
    const conversation = await chatService.resetConversation("telegram", String(ctx.chat.id));
    await ctx.reply(`已清走目前 thread 綁定。\n${conversationSummary(conversation)}`);
  });

  bot.command("stop", async ctx => {
    const status = await chatService.stopConversation("telegram", String(ctx.chat.id));
    await ctx.reply(status);
  });

  bot.command("threads", async ctx => {
    const threads = await chatService.listThreads("telegram", String(ctx.chat.id), null, 10);
    await ctx.reply(formatThreadList(threads));
  });

  bot.command("attach", async ctx => {
    const input = readCommandArgument(ctx.message.text);
    if (!input) {
      await ctx.reply("用法: /attach <threadId>");
      return;
    }

    const result = await chatService.attachThread("telegram", String(ctx.chat.id), null, input);
    await ctx.reply(
      [
        `已 attach ${result.thread.id}`,
        result.thread.name ?? "(untitled)",
        result.thread.cwd,
        "",
        conversationSummary(result.conversation)
      ].join("\n")
    );
  });

  bot.command("cwd", async ctx => {
    const input = readCommandArgument(ctx.message.text);
    if (!input) {
      await ctx.reply("用法: /cwd /absolute/path");
      return;
    }

    const conversation = await chatService.setConversationCwd(
      "telegram",
      String(ctx.chat.id),
      null,
      input
    );
    await ctx.reply(`cwd 已改成 ${conversation.cwd}`);
  });

  bot.command("provider", async ctx => {
    const input = readCommandArgument(ctx.message.text);
    if (input !== "codex" && input !== "gemini") {
      await ctx.reply("用法: /provider codex");
      return;
    }

    const conversation = await chatService.setConversationProvider(
      "telegram",
      String(ctx.chat.id),
      null,
      input as ProviderKind
    );
    await ctx.reply(`provider 已改成 ${conversation.provider}`);
  });

  bot.on(message("text"), async ctx => {
    if (ctx.message.text.startsWith("/")) {
      return;
    }

    const stream = new StreamingReply(ctx, config.verboseTools);
    await stream.init();

    try {
      for await (const event of chatService.runPrompt({
        transport: "telegram",
        transportId: String(ctx.chat.id),
        prompt: ctx.message.text
      })) {
        stream.onEvent(event);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      stream.onEvent({
        type: "error",
        message: text
      });
    }

    await stream.finish();
  });
}

function readCommandArgument(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return "";
  }
  return trimmed.slice(firstSpace + 1).trim();
}
