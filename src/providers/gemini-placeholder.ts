import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderSessionHandle,
  ProviderStreamEvent,
  ProviderThreadDetails,
  ProviderThreadSummary,
  ResumeSessionInput,
  RunTurnInput,
  StartSessionInput
} from "../types.js";

const GEMINI_NOT_READY =
  "Gemini transport is not implemented yet. The provider abstraction is in place so we can add it later without rewriting the transport layer.";

export class GeminiPlaceholderProvider implements ProviderAdapter {
  readonly kind = "gemini" as const;
  readonly capabilities: ProviderCapabilities = {
    interrupt: false
  };

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  async startSession(_input: StartSessionInput): Promise<ProviderSessionHandle> {
    throw new Error(GEMINI_NOT_READY);
  }

  async resumeSession(_input: ResumeSessionInput): Promise<ProviderSessionHandle> {
    throw new Error(GEMINI_NOT_READY);
  }

  async listThreads(_limit?: number): Promise<ProviderThreadSummary[]> {
    throw new Error(GEMINI_NOT_READY);
  }

  async readThread(_threadId: string): Promise<ProviderThreadDetails> {
    throw new Error(GEMINI_NOT_READY);
  }

  async *runTurn(_input: RunTurnInput): AsyncGenerator<ProviderStreamEvent> {
    throw new Error(GEMINI_NOT_READY);
  }

  async interruptTurn(_threadId: string, _turnId: string): Promise<void> {
    throw new Error(GEMINI_NOT_READY);
  }
}
