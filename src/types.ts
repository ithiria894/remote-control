export type ProviderKind = "codex" | "gemini";
export type TransportKind = "telegram" | "web";

export type SessionStatus = "idle" | "running" | "error";

export type ProviderCapabilities = {
  interrupt: boolean;
};

export type ProviderThreadSummary = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  status: string;
};

export type ProviderThreadDetails = ProviderThreadSummary & {
  path: string | null;
  transcript: ProviderTranscriptEntry[];
};

export type ProviderTranscriptEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "reasoning"; text: string; summary: string[]; content: string[] }
  | { id: string; kind: "plan"; text: string }
  | { id: string; kind: "tool"; title: string; text: string; status: string };

export type ProviderSessionHandle = {
  threadId: string;
  cwd: string;
};

export type ProviderStreamEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "assistant.delta"; delta: string }
  | { type: "assistant.completed"; text: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "tool.started"; label: string }
  | { type: "tool.completed"; label: string; success: boolean }
  | { type: "command.delta"; delta: string }
  | { type: "turn.completed"; turnId: string; status: "completed" | "interrupted" | "failed" }
  | { type: "error"; message: string };

export type StartSessionInput = {
  cwd: string;
  model?: string | null;
  modelProvider?: string | null;
};

export type ResumeSessionInput = StartSessionInput & {
  threadId: string;
};

export type RunTurnInput = {
  threadId: string;
  prompt: string;
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
};

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  start(): Promise<void>;
  close(): Promise<void>;
  startSession(input: StartSessionInput): Promise<ProviderSessionHandle>;
  resumeSession(input: ResumeSessionInput): Promise<ProviderSessionHandle>;
  listThreads(limit?: number): Promise<ProviderThreadSummary[]>;
  readThread(threadId: string, includeTurns?: boolean): Promise<ProviderThreadDetails>;
  runTurn(input: RunTurnInput): AsyncGenerator<ProviderStreamEvent>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}

export type StoredConversation = {
  id: string;
  key: string;
  transport: TransportKind;
  ownerId: string;
  title: string;
  sidebarPreview: string | null;
  provider: ProviderKind;
  cwd: string;
  providerThreadId: string | null;
  activeTurnId: string | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

export type SessionStoreState = {
  conversations: Record<string, StoredConversation>;
};
