import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import type { AppConfig } from "../config.js";
import { ChatService } from "../runtime/chat-service.js";
import type { ProviderKind } from "../types.js";

type ServerMessage =
  | { type: "hello"; clientId: string | null }
  | { type: "state"; data: unknown }
  | { type: "event"; sessionId: string | null; event: unknown }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

type ClientMessage =
  | { type: "init"; clientId: string; sessionId?: string | null }
  | { type: "refresh" }
  | { type: "new" }
  | { type: "import"; threadId: string }
  | { type: "sync-active-local" }
  | { type: "select"; sessionId: string }
  | { type: "stop" }
  | { type: "attach"; threadId: string }
  | { type: "prompt"; text: string }
  | { type: "cwd"; cwd: string }
  | { type: "provider"; provider: ProviderKind };

type SocketState = {
  clientId: string | null;
  sessionId: string | null;
};

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

export async function createWebServer(config: AppConfig, chatService: ChatService): Promise<{
  start(): Promise<void>;
  close(): Promise<void>;
}> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = request.url ?? "/";
      if (url === "/api/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url === "/" || url === "/index.html") {
        await sendStaticFile(path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8", response);
        return;
      }

      if (url === "/app.js") {
        await sendStaticFile(path.join(PUBLIC_DIR, "app.js"), "text/javascript; charset=utf-8", response);
        return;
      }

      if (url === "/styles.css") {
        await sendStaticFile(path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8", response);
        return;
      }

      if (url === "/manifest.webmanifest") {
        await sendStaticFile(
          path.join(PUBLIC_DIR, "manifest.webmanifest"),
          "application/manifest+json; charset=utf-8",
          response
        );
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(message);
    }
  });

  const wsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if ((request.url ?? "") !== "/ws") {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, ws => {
      wsServer.emit("connection", ws, request);
    });
  });

  wsServer.on("connection", socket => {
    const state: SocketState = { clientId: null, sessionId: null };
    send(socket, { type: "hello", clientId: null });

    socket.on("message", async raw => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(socket, { type: "error", message: "Malformed JSON message." });
        return;
      }

      try {
        switch (message.type) {
          case "init": {
            state.clientId = message.clientId;
            state.sessionId = message.sessionId ?? null;
            await chatService.ensureConversation("web", message.clientId, state.sessionId);
            await sendState(socket, chatService, state);
            return;
          }
          case "refresh":
            await withClient(socket, state, () => sendState(socket, chatService, state));
            return;
          case "new":
            await withClient(socket, state, async clientId => {
              const created = await chatService.createConversation("web", clientId);
              state.sessionId = created.id;
              await sendState(socket, chatService, state);
            });
            return;
          case "import":
            await withClient(socket, state, async clientId => {
              const created = await chatService.createConversation("web", clientId, "Imported thread");
              state.sessionId = created.id;
              await chatService.attachThread("web", clientId, state.sessionId, message.threadId);
              await sendState(socket, chatService, state);
            });
            return;
          case "sync-active-local":
            await withClient(socket, state, async clientId => {
              const result = await chatService.syncActiveLocalConversations("web", clientId);
              send(
                socket,
                {
                  type: "info",
                  message: `Imported ${result.imported} of ${result.active} active local terminal sessions.`
                }
              );
              await sendState(socket, chatService, state);
            });
            return;
          case "select":
            await withClient(socket, state, async () => {
              state.sessionId = message.sessionId;
              await sendState(socket, chatService, state);
            });
            return;
          case "stop":
            await withClient(socket, state, async clientId => {
              const status = await chatService.stopConversation("web", clientId, state.sessionId);
              send(socket, { type: "info", message: status });
              await sendState(socket, chatService, state);
            });
            return;
          case "attach":
            await withClient(socket, state, async clientId => {
              await chatService.attachThread("web", clientId, state.sessionId, message.threadId);
              await sendState(socket, chatService, state);
            });
            return;
          case "cwd":
            await withClient(socket, state, async clientId => {
              await chatService.setConversationCwd("web", clientId, state.sessionId, message.cwd);
              await sendState(socket, chatService, state);
            });
            return;
          case "provider":
            await withClient(socket, state, async clientId => {
              await chatService.setConversationProvider(
                "web",
                clientId,
                state.sessionId,
                message.provider
              );
              await sendState(socket, chatService, state);
            });
            return;
          case "prompt":
            await withClient(socket, state, async clientId => {
              const targetSessionId = state.sessionId;
              for await (const event of chatService.runPrompt({
                transport: "web",
                transportId: clientId,
                sessionId: targetSessionId,
                prompt: message.text
              })) {
                send(socket, { type: "event", sessionId: targetSessionId, event });
              }
              await sendState(socket, chatService, state);
            });
            return;
          default:
            send(socket, { type: "error", message: "Unsupported client message." });
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        send(socket, { type: "error", message: text });
      }
    });
  });

  return {
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.web.port, config.web.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async close(): Promise<void> {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          wsServer.close(error => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          server.close(error => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
      ]);
    }
  };
}

async function sendStaticFile(
  filePath: string,
  contentType: string,
  response: http.ServerResponse
): Promise<void> {
  const contents = await fs.readFile(filePath);
  response.writeHead(200, { "content-type": contentType });
  response.end(contents);
}

async function withClient(
  socket: WebSocket,
  state: SocketState,
  fn: (clientId: string) => Promise<void>
): Promise<void> {
  if (!state.clientId) {
    send(socket, { type: "error", message: "Client is not initialized yet." });
    return;
  }
  await fn(state.clientId);
}

async function sendState(socket: WebSocket, chatService: ChatService, state: SocketState): Promise<void> {
  if (!state.clientId) {
    return;
  }
  const view = await chatService.getConversationView("web", state.clientId, state.sessionId);
  state.sessionId = view.conversation.id;
  send(socket, { type: "state", data: view });
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}
