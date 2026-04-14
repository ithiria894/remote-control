import WebSocket from "ws";

type JsonRpcId = number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: unknown;
};

type JsonRpcNotificationOut = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcServerRequest = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class JsonRpcWsClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<(message: JsonRpcNotification) => void>();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.socket = new WebSocket(this.url);

    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;

      socket.once("open", () => resolve());
      socket.once("error", error => reject(error));

      socket.on("message", data => {
        this.handleMessage(data.toString());
      });

      socket.on("close", () => {
        const pendingRequests = [...this.pending.values()];
        this.pending.clear();
        for (const pending of pendingRequests) {
          pending.reject(new Error("Codex app-server connection closed"));
        }
      });
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  onNotification(handler: (message: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const socket = this.requireSocket();
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject
      });
    });

    socket.send(JSON.stringify(payload));
    return responsePromise;
  }

  notify(method: string, params?: unknown): void {
    const socket = this.requireSocket();
    const payload: JsonRpcNotificationOut = {
      jsonrpc: "2.0",
      method
    };
    if (params !== undefined) {
      payload.params = params;
    }
    socket.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    const parsed = JSON.parse(raw) as JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

    if ("id" in parsed && "method" in parsed) {
      this.handleServerRequest(parsed);
      return;
    }

    if ("id" in parsed) {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pending.delete(parsed.id);

      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? "Unknown JSON-RPC error"));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if ("method" in parsed) {
      for (const handler of this.notificationHandlers) {
        handler(parsed);
      }
    }
  }

  private handleServerRequest(message: JsonRpcServerRequest): void {
    const socket = this.requireSocket();
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Unhandled app-server request: ${message.method}`
      }
    };
    socket.send(JSON.stringify(response));
  }

  private requireSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server socket is not connected");
    }
    return this.socket;
  }
}
