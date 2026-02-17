import { closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { terminateProcess, type CommandOverrides } from "./shell.js";
import { getErrorMessage } from "./error-utils.js";

export type BackgroundStatus = "running" | "exited" | "killed" | "error";

export type BackgroundProcessView = {
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  status: BackgroundStatus;
  exitCode: number | null;
  signal: string | null;
  endedAt: string | null;
  error: string | null;
  stdoutLogPath: string;
  stderrLogPath: string;
};

export type BackgroundLifecycleEvent =
  | "started"
  | "completed"
  | "killed"
  | "error";

type BackgroundProcessRecord = BackgroundProcessView & {
  child: ChildProcess;
  completed: boolean;
  completion: Promise<BackgroundProcessView>;
  resolveCompletion: (result: BackgroundProcessView) => void;
};

function defaultLogDir(): string {
  return (
    process.env.BASH_COMMAND_MCP_LOG_DIR || join(tmpdir(), "bash-command-mcp")
  );
}

async function readTail(filePath: string, lines: number): Promise<string> {
  const maxBytes = 256 * 1024;

  if (!existsSync(filePath)) {
    return "";
  }

  const fileSize = statSync(filePath).size;
  if (fileSize === 0) {
    return "";
  }

  const start = Math.max(0, fileSize - maxBytes);
  const length = fileSize - start;

  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);

    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
      }
    }

    const split = text.split(/\r?\n/);
    const trimmed = split.at(-1) === "" ? split.slice(0, -1) : split;
    return trimmed.slice(-lines).join("\n");
  } finally {
    await file.close();
  }
}

function toView(record: BackgroundProcessRecord): BackgroundProcessView {
  return {
    pid: record.pid,
    command: record.command,
    cwd: record.cwd,
    startedAt: record.startedAt,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    endedAt: record.endedAt,
    error: record.error,
    stdoutLogPath: record.stdoutLogPath,
    stderrLogPath: record.stderrLogPath,
  };
}

export class BackgroundProcessManager {
  private readonly records = new Map<number, BackgroundProcessRecord>();
  private readonly logDir: string;
  private readonly onLifecycleEvent?:
    | ((event: BackgroundLifecycleEvent, view: BackgroundProcessView) => void)
    | undefined;

  constructor(
    logDir = defaultLogDir(),
    onLifecycleEvent?: (
      event: BackgroundLifecycleEvent,
      view: BackgroundProcessView,
    ) => void,
  ) {
    this.logDir = logDir;
    this.onLifecycleEvent = onLifecycleEvent;
    mkdirSync(this.logDir, { recursive: true });
  }

  start(command: string, overrides: CommandOverrides): BackgroundProcessView {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stdoutLogPath = join(this.logDir, `bg-${unique}.stdout.log`);
    const stderrLogPath = join(this.logDir, `bg-${unique}.stderr.log`);

    const stdoutFd = openSync(stdoutLogPath, "a");
    const stderrFd = openSync(stderrLogPath, "a");

    try {
      const child = spawn(command, {
        shell: true,
        detached: true,
        cwd: overrides.cwd,
        env: overrides.env ? { ...process.env, ...overrides.env } : process.env,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      child.unref();

      if (!child.pid) {
        throw new Error("failed to start process (missing pid)");
      }

      let resolveCompletion: (result: BackgroundProcessView) => void = () => {};
      const completion = new Promise<BackgroundProcessView>((resolve) => {
        resolveCompletion = resolve;
      });

      const record: BackgroundProcessRecord = {
        pid: child.pid,
        command,
        cwd: overrides.cwd || process.cwd(),
        startedAt: new Date().toISOString(),
        status: "running",
        exitCode: null,
        signal: null,
        endedAt: null,
        error: null,
        stdoutLogPath,
        stderrLogPath,
        child,
        completion,
        resolveCompletion,
        completed: false,
      };
      this.records.set(record.pid, record);
      this.onLifecycleEvent?.("started", toView(record));

      child.on("close", (code, signal) => {
        const current = this.records.get(record.pid);
        if (!current) {
          return;
        }

        if (current.completed) {
          return;
        }

        current.exitCode = typeof code === "number" ? code : null;
        current.signal = signal ?? null;
        current.endedAt = new Date().toISOString();
        if (current.status === "running") {
          current.status = signal ? "killed" : "exited";
        }
        current.completed = true;
        this.onLifecycleEvent?.(
          signal ? "killed" : "completed",
          toView(current),
        );
        current.resolveCompletion(toView(current));
      });

      child.on("error", (error) => {
        const current = this.records.get(record.pid);
        if (!current || current.completed) {
          return;
        }

        current.status = "error";
        current.error = error.message;
        current.endedAt = new Date().toISOString();
        current.completed = true;
        this.onLifecycleEvent?.("error", toView(current));
        current.resolveCompletion(toView(current));
      });

      return toView(record);
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }

  list(): BackgroundProcessView[] {
    return Array.from(this.records.values())
      .sort((a, b) => a.pid - b.pid)
      .map((record) => toView(record));
  }

  get(pid: number): BackgroundProcessView | null {
    const record = this.records.get(pid);
    return record ? toView(record) : null;
  }

  countRunning(): number {
    return Array.from(this.records.values()).filter(
      (record) => record.status === "running",
    ).length;
  }

  kill(pid: number): {
    ok: boolean;
    message: string;
    view: BackgroundProcessView | null;
  } {
    const record = this.records.get(pid);
    if (!record) {
      return {
        ok: false,
        message: `No tracked background process found for PID ${pid}.`,
        view: null,
      };
    }

    if (record.status !== "running") {
      return {
        ok: true,
        message: `Process ${pid} is already ${record.status}.`,
        view: toView(record),
      };
    }

    try {
      terminateProcess(pid);
      record.status = "killed";
      record.signal = "SIGTERM";
      record.endedAt = new Date().toISOString();
      this.onLifecycleEvent?.("killed", toView(record));

      return {
        ok: true,
        message: `Sent SIGTERM to background process ${pid}.`,
        view: toView(record),
      };
    } catch (error: unknown) {
      return {
        ok: false,
        message: `Failed to kill process ${pid}: ${getErrorMessage(error)}`,
        view: toView(record),
      };
    }
  }

  async tail(
    pid: number,
    lines: number,
  ): Promise<{
    ok: boolean;
    message: string;
    view: BackgroundProcessView | null;
    stdout: string;
    stderr: string;
  }> {
    const record = this.records.get(pid);
    if (!record) {
      return {
        ok: false,
        message: `No tracked background process found for PID ${pid}.`,
        view: null,
        stdout: "",
        stderr: "",
      };
    }

    const stdout = await readTail(record.stdoutLogPath, lines);
    const stderr = await readTail(record.stderrLogPath, lines);

    return {
      ok: true,
      message: `Showing last ${lines} line(s) for PID ${pid}.`,
      view: toView(record),
      stdout,
      stderr,
    };
  }

  async wait(
    pid: number,
    timeoutSeconds: number,
  ): Promise<{
    ok: boolean;
    timedOut: boolean;
    message: string;
    view: BackgroundProcessView | null;
  }> {
    const record = this.records.get(pid);
    if (!record) {
      return {
        ok: false,
        timedOut: false,
        message: `No tracked background process found for PID ${pid}.`,
        view: null,
      };
    }

    if (record.status !== "running") {
      return {
        ok: true,
        timedOut: false,
        message: `Process ${pid} is already ${record.status}.`,
        view: toView(record),
      };
    }

    const timeoutMs = timeoutSeconds * 1000;
    const timeoutResult = await Promise.race([
      record.completion.then((view) => ({ type: "done" as const, view })),
      new Promise<{ type: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" as const }), timeoutMs);
      }),
    ]);

    if (timeoutResult.type === "timeout") {
      return {
        ok: false,
        timedOut: true,
        message: `Timed out waiting for PID ${pid} after ${timeoutSeconds} second(s).`,
        view: toView(record),
      };
    }

    return {
      ok: true,
      timedOut: false,
      message: `Process ${pid} completed with status ${timeoutResult.view.status}.`,
      view: timeoutResult.view,
    };
  }

  async readLogs(
    pid: number,
  ): Promise<{ stdout: string; stderr: string } | null> {
    const record = this.records.get(pid);
    if (!record) {
      return null;
    }

    const [stdout, stderr] = await Promise.all([
      readFile(record.stdoutLogPath, "utf8").catch(() => ""),
      readFile(record.stderrLogPath, "utf8").catch(() => ""),
    ]);

    return { stdout, stderr };
  }
}
