import { spawn } from "node:child_process";

/**
 * Accepted command input shape from tool arguments.
 */
export type CommandValue = string | string[] | undefined;

/**
 * Optional execution overrides applied to spawned commands.
 */
export type CommandOverrides = {
  cwd?: string;
  env?: Record<string, string>;
};

/**
 * Foreground command execution result.
 */
export type ForegroundResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorMessage: string | null;
};

function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Normalizes command input into a shell-safe command string.
 */
export function normalizeCommand(
  command?: CommandValue,
  cmd?: CommandValue,
): string | null {
  const raw = command ?? cmd;
  let normalized = "";

  if (Array.isArray(raw)) {
    normalized = raw
      .map((arg) => {
        if (/^[a-zA-Z0-9_./:,=+@\\-]+$/.test(arg)) {
          return arg;
        }
        if (!isWindows()) {
          return `'${arg.replace(/'/g, "'\"'\"'")}'`;
        } else {
          return `"${arg.replace(/"/g, '""')}"`;
        }
      })
      .join(" ");
  } else if (typeof raw === "string") {
    normalized = raw;
  }

  return normalized.trim() || null;
}

/**
 * Terminates a process, including the full process group on non-Windows hosts.
 */
export function terminateProcess(pid: number): void {
  if (!isWindows()) {
    process.kill(-pid, "SIGTERM");
    return;
  }
  process.kill(pid, "SIGTERM");
}

/**
 * Runs a shell command in the foreground and collects buffered output.
 */
export async function runForegroundCommand(
  command: string,
  timeoutSeconds: number,
  overrides: CommandOverrides,
): Promise<ForegroundResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      detached: !isWindows(),
      cwd: overrides.cwd,
      env: overrides.env ? { ...process.env, ...overrides.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) terminateProcess(child.pid);
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        errorMessage: error.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === "number" ? code : null,
        stdout,
        stderr,
        timedOut,
        errorMessage: null,
      });
    });
  });
}
