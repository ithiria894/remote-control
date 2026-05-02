import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import WebSocket from "ws";

const repoDir = process.cwd();
const webPort = Number.parseInt(process.env.REMOTE_CONTROL_E2E_PORT ?? "4311", 10);
const codexPort = Number.parseInt(process.env.REMOTE_CONTROL_E2E_CODEX_PORT ?? "8788", 10);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-control-e2e-"));
const serverLogs = [];
const execFileAsync = promisify(execFile);

let serverProcess;
let browser;

try {
  const chromeLaunchOptions = await resolveChromeLaunchOptions();

  serverProcess = spawn(process.execPath, [path.join(repoDir, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"], {
    cwd: repoDir,
    env: {
      ...process.env,
      REMOTE_CONTROL_WEB_HOST: "127.0.0.1",
      REMOTE_CONTROL_WEB_PORT: String(webPort),
      REMOTE_CONTROL_DEFAULT_CWD: repoDir,
      REMOTE_CONTROL_DATA_DIR: dataDir,
      REMOTE_CONTROL_CODEX_PORT: String(codexPort),
      REMOTE_CONTROL_CODEX_AUTO_SPAWN: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  serverProcess.stdout.on("data", chunk => {
    serverLogs.push(`[stdout] ${chunk.toString()}`);
  });
  serverProcess.stderr.on("data", chunk => {
    serverLogs.push(`[stderr] ${chunk.toString()}`);
  });

  await waitForHealth(`http://127.0.0.1:${webPort}/api/health`);

  browser = await chromium.launch({
    ...chromeLaunchOptions,
    headless: true
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("console", message => {
    if (message.type() === "error") {
      pageErrors.push(`console:${message.text()}`);
    }
  });
  page.on("pageerror", error => {
    pageErrors.push(`pageerror:${error.message}`);
  });

  await page.goto(`http://127.0.0.1:${webPort}`);
  await page.waitForFunction(
    () =>
      document.getElementById("connectionStatus")?.textContent === "connected" &&
      !document.getElementById("newButton")?.disabled,
    null,
    { timeout: 15_000 }
  );

  await page.locator("#newButton").click();
  await page.locator("#promptInput").fill("Reply with exactly OK and nothing else.");
  await page.getByRole("button", { name: /^(Submit|Send)$/ }).click();

  await page.waitForFunction(
    () => document.getElementById("sessionState")?.textContent === "running",
    null,
    { timeout: 15_000 }
  );
  const mid = await page.evaluate(() => ({
    sessionTitle: document.getElementById("sessionTitle")?.textContent,
    sessionState: document.getElementById("sessionState")?.textContent,
    transcriptText: document.getElementById("transcript")?.innerText,
    eventFeed: document.getElementById("eventFeed")?.innerText
  }));

  assert(mid.sessionState === "running", `Expected running state mid-turn, got '${mid.sessionState}'`);
  assert(
    mid.transcriptText?.includes("PENDING"),
    `Expected pending prompt mid-turn, got '${mid.transcriptText}'`
  );

  await page.waitForFunction(
    () => (document.getElementById("transcript")?.innerText || "").includes("YOU"),
    null,
    { timeout: 90_000 }
  );

  const end = await page.evaluate(() => ({
    sessionTitle: document.getElementById("sessionTitle")?.textContent,
    sessionState: document.getElementById("sessionState")?.textContent,
    transcriptText: document.getElementById("transcript")?.innerText,
    threadMeta: document.getElementById("threadMeta")?.textContent
  }));

  assert(end.sessionState === "idle", `Expected idle state after completion, got '${end.sessionState}'`);
  assert(
    end.transcriptText?.includes("YOU") && end.transcriptText?.includes("ASSISTANT\nOK"),
    `Expected final transcript to include user prompt and OK reply, got '${end.transcriptText}'`
  );
  assert(pageErrors.length === 0, `Browser reported errors:\n${pageErrors.join("\n")}`);

  const routing = await verifyExplicitSessionRouting(`ws://127.0.0.1:${webPort}/ws`);

  process.stdout.write(
    `${JSON.stringify({ ok: true, mid, end, routing }, null, 2)}\n`
  );
} catch (error) {
  const text = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${text}\n`);
  if (serverLogs.length > 0) {
    process.stderr.write(`\nRecent server logs:\n${serverLogs.slice(-20).join("")}\n`);
  }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await onceExit(serverProcess).catch(() => {});
  }
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling while the local server starts.
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for health endpoint at ${url}`);
}

async function onceExit(child) {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
    setTimeout(resolve, 5_000);
  });
}

async function resolveChromeLaunchOptions() {
  if (process.env.REMOTE_CONTROL_E2E_CHROME_PATH) {
    return {
      executablePath: process.env.REMOTE_CONTROL_E2E_CHROME_PATH
    };
  }

  const platform = process.platform;
  if (platform === "darwin") {
    const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (await exists(macPath)) {
      return { executablePath: macPath };
    }
  }

  if (platform === "win32") {
    const winPaths = [
      path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe"
      ),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
    ].filter(Boolean);

    for (const candidate of winPaths) {
      if (await exists(candidate)) {
        return { executablePath: candidate };
      }
    }
  }

  const executableName =
    platform === "win32"
      ? await findOnPath(["chrome.exe"])
      : await findOnPath(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);
  if (executableName) {
    return { executablePath: executableName };
  }

  return { channel: "chrome" };
}

async function verifyExplicitSessionRouting(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const messages = [];
  const waiters = [];

  socket.on("message", raw => {
    const parsed = JSON.parse(raw.toString());
    messages.push(parsed);

    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(parsed)) {
        waiters.splice(index, 1);
        waiter.resolve(parsed);
      }
    }
  });

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const waitForMessage = (predicate, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const existing = messages.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }

      const waiter = {
        predicate,
        resolve(message) {
          clearTimeout(timeout);
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          resolve(message);
        }
      };
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for routing message after ${timeoutMs}ms.`));
      }, timeoutMs);

      waiters.push(waiter);
    });

  await waitForMessage(message => message.type === "hello");

  const clientId = `route-e2e-${Date.now()}`;
  socket.send(JSON.stringify({ type: "init", clientId }));

  const initialState = await waitForMessage(message => message.type === "state");
  const initialSessionId = initialState.data?.conversation?.id;
  assert(initialSessionId, "Expected init to create a default session.");

  socket.send(JSON.stringify({ type: "new" }));
  const newSessionState = await waitForMessage(
    message => message.type === "state" && message.data?.conversation?.id !== initialSessionId
  );
  const currentSessionId = newSessionState.data?.conversation?.id;
  assert(currentSessionId, "Expected new to create a second session.");

  const marker = `ROUTE-OK-${Date.now()}`;
  socket.send(
    JSON.stringify({
      type: "prompt",
      text: `Reply with exactly ${marker} and nothing else.`,
      sessionId: initialSessionId
    })
  );

  await waitForMessage(
    message =>
      message.type === "event" &&
      message.sessionId === initialSessionId &&
      message.event?.type === "turn.started",
    20_000
  );
  await waitForMessage(
    message =>
      message.type === "event" &&
      message.sessionId === initialSessionId &&
      message.event?.type === "turn.completed",
    120_000
  );

  const routedState = await waitForMessage(
    message =>
      message.type === "state" &&
      message.data?.conversation?.id === initialSessionId &&
      message.data?.conversation?.providerThreadId,
    15_000
  );

  const routedSession = routedState.data.conversation;
  const parkedSession = (routedState.data.sessions || []).find(session => session.id === currentSessionId);

  assert(
    routedSession.sidebarPreview?.includes(marker),
    `Expected routed session preview to include ${marker}, got '${routedSession.sidebarPreview}'`
  );
  assert(
    parkedSession && parkedSession.providerThreadId === null && parkedSession.status === "idle",
    `Expected non-target session to stay idle without a thread, got '${JSON.stringify(parkedSession)}'`
  );

  socket.close();

  return {
    initialSessionId,
    currentSessionId,
    routedConversationId: routedSession.id,
    routedThreadId: routedSession.providerThreadId
  };
}

async function findOnPath(names) {
  const locator = process.platform === "win32" ? "where" : "which";
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync(locator, [name]);
      const match = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
      if (match) {
        return match;
      }
    } catch {
      // Try the next executable name.
    }
  }
  return null;
}

async function exists(filePath) {
  if (!filePath) {
    return false;
  }

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
