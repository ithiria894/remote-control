import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import type { ProviderKind } from "./types.js";

dotenv.config();

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function envOptional(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value === "1" || value.toLowerCase() === "true";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

function envProvider(name: string, fallback: ProviderKind): ProviderKind {
  const value = (process.env[name] ?? fallback).toLowerCase();
  if (value === "codex" || value === "gemini") {
    return value;
  }
  throw new Error(`Unsupported provider '${value}' in ${name}`);
}

export type AppConfig = {
  telegramBotToken: string | null;
  telegramAllowedChatIds: Set<string> | null;
  defaultProvider: ProviderKind;
  defaultCwd: string;
  dataDir: string;
  verboseTools: boolean;
  web: {
    host: string;
    port: number;
  };
  codex: {
    model: string | null;
    modelProvider: string | null;
    port: number;
    appServerUrl: string | null;
    autoSpawn: boolean;
    configOverrides: string[];
  };
};

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(env("REMOTE_CONTROL_DATA_DIR", path.join(process.cwd(), ".data")));
  const allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS
    ? new Set(
        process.env.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
          .map(value => value.trim())
          .filter(Boolean)
      )
    : null;

  return {
    telegramBotToken: envOptional("TELEGRAM_BOT_TOKEN"),
    telegramAllowedChatIds: allowedChatIds,
    defaultProvider: envProvider("REMOTE_CONTROL_DEFAULT_PROVIDER", "codex"),
    defaultCwd: path.resolve(env("REMOTE_CONTROL_DEFAULT_CWD", process.cwd())),
    dataDir,
    verboseTools: envBool("REMOTE_CONTROL_VERBOSE_TOOLS", false),
    web: {
      host: env("REMOTE_CONTROL_WEB_HOST", "127.0.0.1"),
      port: envInt("REMOTE_CONTROL_WEB_PORT", 4310)
    },
    codex: {
      model: process.env.REMOTE_CONTROL_CODEX_MODEL ?? null,
      modelProvider: process.env.REMOTE_CONTROL_CODEX_MODEL_PROVIDER ?? null,
      port: envInt("REMOTE_CONTROL_CODEX_PORT", 8787),
      appServerUrl: process.env.REMOTE_CONTROL_CODEX_APP_SERVER_URL ?? null,
      autoSpawn: envBool("REMOTE_CONTROL_CODEX_AUTO_SPAWN", true),
      configOverrides: (process.env.REMOTE_CONTROL_CODEX_CONFIG_OVERRIDES ?? "")
        .split("\n")
        .map(value => value.trim())
        .filter(Boolean)
    }
  };
}
