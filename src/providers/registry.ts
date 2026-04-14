import type { AppConfig } from "../config.js";
import type { ProviderAdapter, ProviderKind } from "../types.js";
import { CodexAppServerProvider } from "./codex-app-server.js";
import { GeminiPlaceholderProvider } from "./gemini-placeholder.js";

export class ProviderRegistry {
  private readonly providers = new Map<ProviderKind, ProviderAdapter>();

  constructor(config: AppConfig) {
    this.providers.set(
      "codex",
      new CodexAppServerProvider({
        model: config.codex.model,
        modelProvider: config.codex.modelProvider,
        port: config.codex.port,
        appServerUrl: config.codex.appServerUrl,
        autoSpawn: config.codex.autoSpawn,
        configOverrides: config.codex.configOverrides
      })
    );
    this.providers.set("gemini", new GeminiPlaceholderProvider());
  }

  get(kind: ProviderKind): ProviderAdapter {
    const provider = this.providers.get(kind);
    if (!provider) {
      throw new Error(`Unsupported provider: ${kind}`);
    }
    return provider;
  }

  async close(): Promise<void> {
    await Promise.all([...this.providers.values()].map(provider => provider.close()));
  }
}
