import process from "node:process";
import { Telegraf } from "telegraf";
import { loadConfig } from "./config.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ChatService } from "./runtime/chat-service.js";
import { SessionStore } from "./storage/session-store.js";
import { createTelegramBot } from "./transports/telegram-bot.js";
import { createWebServer } from "./web/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new SessionStore(config.dataDir);
  await store.init();

  const providers = new ProviderRegistry(config);
  const chatService = new ChatService(config, store, providers);
  const webServer = await createWebServer(config, chatService);

  let bot: Telegraf | null = null;
  if (config.telegramBotToken) {
    bot = new Telegraf(config.telegramBotToken);
    await createTelegramBot(bot, config, chatService);
  }

  const shutdown = async (): Promise<void> => {
    bot?.stop("shutdown");
    await webServer.close();
    await providers.close();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await webServer.start();
  if (bot) {
    await bot.launch();
  }
  process.stdout.write(
    `remote-control web is running at http://${config.web.host}:${config.web.port}\n`
  );
}

void main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
