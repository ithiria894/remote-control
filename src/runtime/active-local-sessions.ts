import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { promisify } from "node:util";

export type ActiveLocalSessionSummary = {
  pid: number;
  tty: string | null;
  threadId: string;
  cwd: string;
  rolloutPath: string;
};

type SessionMetaPayload = {
  id?: string;
  cwd?: string;
  source?: {
    subagent?: unknown;
  };
};

const ROLLOUT_PATTERN = /[\\/]\.codex[\\/]sessions[\\/].+[\\/](rollout-[^\\/]+\.jsonl)$/;
const execFileAsync = promisify(execFile);

export function supportsActiveLocalCodexSessions(): boolean {
  return process.platform === "linux" || process.platform === "darwin";
}

export async function listActiveLocalCodexSessions(): Promise<ActiveLocalSessionSummary[]> {
  const summaries = new Map<string, ActiveLocalSessionSummary>();

  for (const processInfo of await listCandidateProcesses()) {
    for (const rolloutPath of await listRolloutPaths(processInfo.pid)) {
      const summary = await readSessionMeta(rolloutPath);
      if (!summary) {
        continue;
      }

      const existing = summaries.get(summary.threadId);
      if (!existing || existing.pid < processInfo.pid) {
        summaries.set(summary.threadId, {
          pid: processInfo.pid,
          tty: processInfo.tty,
          threadId: summary.threadId,
          cwd: summary.cwd,
          rolloutPath
        });
      }
    }
  }

  return [...summaries.values()].sort((a, b) => {
    const ttyA = a.tty ?? "";
    const ttyB = b.tty ?? "";
    return ttyA.localeCompare(ttyB) || a.threadId.localeCompare(b.threadId);
  });
}

async function listCandidateProcesses(): Promise<Array<{ pid: number; tty: string | null }>> {
  if (process.platform === "linux") {
    return listLinuxCandidateProcesses();
  }

  if (process.platform === "darwin") {
    return listDarwinCandidateProcesses();
  }

  return [];
}

async function listLinuxCandidateProcesses(): Promise<Array<{ pid: number; tty: string | null }>> {
  let procEntries: fs.Dirent[];
  try {
    procEntries = await fsPromises.readdir("/proc", { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<{ pid: number; tty: string | null }> = [];
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    const pid = Number(entry.name);
    const cmdline = await readText(`/proc/${pid}/cmdline`);
    if (!isInteractiveCodexCommand(cmdline)) {
      continue;
    }

    candidates.push({
      pid,
      tty: await readLinuxTty(pid)
    });
  }

  return candidates;
}

async function listDarwinCandidateProcesses(): Promise<Array<{ pid: number; tty: string | null }>> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,tty=,command="], {
      maxBuffer: 10 * 1024 * 1024
    });

    return stdout
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) {
          return [];
        }

        const [, pidText, ttyText, command] = match;
        if (!isInteractiveCodexCommand(command)) {
          return [];
        }

        return [
          {
            pid: Number(pidText),
            tty: ttyText === "??" || ttyText === "?" ? null : ttyText
          }
        ];
      });
  } catch {
    return [];
  }
}

async function listRolloutPaths(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    return listLinuxRolloutPaths(pid);
  }

  if (process.platform === "darwin") {
    return listDarwinRolloutPaths(pid);
  }

  return [];
}

async function listLinuxRolloutPaths(pid: number): Promise<string[]> {
  const fdDir = `/proc/${pid}/fd`;
  let fds: string[] = [];
  try {
    fds = await fsPromises.readdir(fdDir);
  } catch {
    return [];
  }

  const rolloutPaths = new Set<string>();
  for (const fd of fds) {
    const link = await readLink(path.join(fdDir, fd));
    if (link && ROLLOUT_PATTERN.test(link)) {
      rolloutPaths.add(link);
    }
  }

  return [...rolloutPaths];
}

async function listDarwinRolloutPaths(pid: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-Fn", "-p", String(pid)], {
      maxBuffer: 10 * 1024 * 1024
    });

    return [
      ...new Set(
        stdout
          .split("\n")
          .filter(line => line.startsWith("n"))
          .map(line => line.slice(1))
          .filter(filePath => ROLLOUT_PATTERN.test(filePath))
      )
    ];
  } catch {
    return [];
  }
}

function isInteractiveCodexCommand(command: string | null): boolean {
  if (!command) {
    return false;
  }

  return command.includes("codex") && !command.includes("app-server");
}

async function readSessionMeta(rolloutPath: string): Promise<{
  threadId: string;
  cwd: string;
} | null> {
  try {
    const firstLine = await readFirstLine(rolloutPath);
    if (!firstLine) {
      return null;
    }

    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: SessionMetaPayload;
    };
    if (parsed.type !== "session_meta" || !parsed.payload?.id || !parsed.payload.cwd) {
      return null;
    }
    if (parsed.payload.source?.subagent) {
      return null;
    }

    return {
      threadId: parsed.payload.id,
      cwd: parsed.payload.cwd
    };
  } catch {
    return null;
  }
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8"
  });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of reader) {
      return line;
    }
    return null;
  } finally {
    reader.close();
  }
}

async function readLinuxTty(pid: number): Promise<string | null> {
  const stdinTarget = await readLink(`/proc/${pid}/fd/0`);
  if (!stdinTarget || !stdinTarget.startsWith("/dev/pts/")) {
    return null;
  }
  return path.basename(stdinTarget);
}

async function readText(filePath: string): Promise<string | null> {
  try {
    const value = await fsPromises.readFile(filePath);
    return value.toString("utf8").replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

async function readLink(filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readlink(filePath);
  } catch {
    return null;
  }
}
