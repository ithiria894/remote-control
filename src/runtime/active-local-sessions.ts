import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

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

const ROLLOUT_PATTERN = /\/\.codex\/sessions\/.+\/(rollout-[^/]+\.jsonl)$/;

export async function listActiveLocalCodexSessions(): Promise<ActiveLocalSessionSummary[]> {
  const procEntries = await fsPromises.readdir("/proc", { withFileTypes: true });
  const summaries = new Map<string, ActiveLocalSessionSummary>();

  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    const pid = Number(entry.name);
    const cmdline = await readText(`/proc/${pid}/cmdline`);
    if (!cmdline || !cmdline.includes("codex") || cmdline.includes("app-server")) {
      continue;
    }

    const tty = await readTty(pid);
    const fdDir = `/proc/${pid}/fd`;
    let fds: string[] = [];
    try {
      fds = await fsPromises.readdir(fdDir);
    } catch {
      continue;
    }

    for (const fd of fds) {
      const link = await readLink(path.join(fdDir, fd));
      if (!link || !ROLLOUT_PATTERN.test(link)) {
        continue;
      }

      const summary = await readSessionMeta(link);
      if (!summary) {
        continue;
      }

      const existing = summaries.get(summary.threadId);
      if (!existing || existing.pid < pid) {
        summaries.set(summary.threadId, {
          pid,
          tty,
          threadId: summary.threadId,
          cwd: summary.cwd,
          rolloutPath: link
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

async function readTty(pid: number): Promise<string | null> {
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
