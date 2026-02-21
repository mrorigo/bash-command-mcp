import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeCommand,
  runForegroundCommand,
  type CommandOverrides,
} from "./shell.js";
import {
  BackgroundProcessManager,
  type BackgroundProcessView,
} from "./background-manager.js";
import { Observability } from "./observability.js";
import { getErrorMessage } from "./error-utils.js";

const commandSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Command as a string or string array.");

const envSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe("Environment variable overrides for the command.");

const MAX_TIMEOUT_SECONDS = 24 * 3600;

function formatCommandResult(
  exitCode: string,
  stdout: string,
  stderr: string,
  fallback: string,
): string {
  let output = `EXIT_CODE: ${exitCode}\n`;
  if (stdout) output += `STDOUT:\n${stdout}\n`;
  if (stderr) output += `STDERR:\n${stderr}\n`;
  return output.trim() || `EXIT_CODE: ${exitCode}\n${fallback}`;
}

function formatBackgroundView(view: BackgroundProcessView): string {
  return [
    `PID: ${view.pid}`,
    `STATUS: ${view.status}`,
    `EXIT_CODE: ${view.exitCode ?? "N/A"}`,
    `SIGNAL: ${view.signal ?? "N/A"}`,
    `STARTED_AT: ${view.startedAt}`,
    `ENDED_AT: ${view.endedAt ?? "N/A"}`,
    `CWD: ${view.cwd}`,
    `STDOUT_LOG: ${view.stdoutLogPath}`,
    `STDERR_LOG: ${view.stderrLogPath}`,
    `COMMAND: ${view.command}`,
    view.error ? `ERROR: ${view.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveOverrides(
  cwd?: string,
  env?: Record<string, string>,
): CommandOverrides {
  return { cwd, env };
}

function clampTimeoutSeconds(timeoutSeconds: number): {
  effectiveTimeoutSeconds: number;
  timeoutHint: string | null;
} {
  if (timeoutSeconds <= MAX_TIMEOUT_SECONDS) {
    return { effectiveTimeoutSeconds: timeoutSeconds, timeoutHint: null };
  }

  return {
    effectiveTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    timeoutHint: `Requested timeoutSeconds=${timeoutSeconds} exceeds max ${MAX_TIMEOUT_SECONDS}; capped to ${MAX_TIMEOUT_SECONDS}.`,
  };
}

function appendHint(text: string, hint: string | null): string {
  return hint ? `${text}\n\nHINT: ${hint}` : text;
}

export function registerTools(
  server: McpServer,
  backgroundManager: BackgroundProcessManager,
  observability: Observability,
): void {
  server.registerTool(
    "run",
    {
      description:
        "Run a shell command in the foreground and return stdout/stderr with exit code.",
      inputSchema: {
        command: commandSchema,
        cmd: commandSchema,
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .default(60)
          .describe("Execution timeout in seconds. Default 60."),
        cwd: z.string().optional().describe("Working directory override."),
        env: envSchema,
      },
    },
    async ({ command, cmd, timeoutSeconds, cwd, env }) => {
      const { effectiveTimeoutSeconds, timeoutHint } =
        clampTimeoutSeconds(timeoutSeconds);
      const span = observability.toolSpan("run", {
        "mcp.command.cwd": cwd,
        "mcp.command.timeout_seconds": effectiveTimeoutSeconds,
      });
      span.setAttribute("mcp.command.timeout_seconds.requested", timeoutSeconds);
      span.setAttribute(
        "mcp.command.timeout_seconds.capped",
        effectiveTimeoutSeconds !== timeoutSeconds,
      );

      try {
        const normalizedCommand = normalizeCommand(command, cmd);
        if (!normalizedCommand) {
          span.end(false, { "mcp.command.valid": false });
          return {
            content: [
              {
                type: "text",
                text: 'EXIT_CODE: unknown\nEither "command" or "cmd" must be provided.',
              },
            ],
            isError: true,
          };
        }

        span.setAttribute("mcp.command.value", normalizedCommand);
        const result = await runForegroundCommand(
          normalizedCommand,
          effectiveTimeoutSeconds,
          resolveOverrides(cwd, env),
        );

        if (result.errorMessage) {
          span.recordException(new Error(result.errorMessage));
          span.end(false, {
            "mcp.command.status": "spawn_error",
          });
          return {
            content: [
              {
                type: "text",
                text: appendHint(
                  formatCommandResult(
                    "unknown",
                    result.stdout,
                    result.stderr,
                    `Command failed with error:\n${result.errorMessage}`,
                  ),
                  timeoutHint,
                ),
              },
            ],
            isError: true,
          };
        }

        const exitCode =
          typeof result.exitCode === "number"
            ? String(result.exitCode)
            : "unknown";
        const timedOutMessage = result.timedOut
          ? `Command timed out after ${effectiveTimeoutSeconds} second(s).`
          : "No output returned.";

        if (result.timedOut) {
          observability.markTimeout("run");
        }

        const ok = !result.timedOut && result.exitCode === 0;
        span.end(ok, {
          "mcp.command.exit_code":
            typeof result.exitCode === "number" ? result.exitCode : -1,
          "mcp.command.timed_out": result.timedOut,
        });

        return {
          content: [
            {
              type: "text",
              text: appendHint(
                formatCommandResult(
                  exitCode,
                  result.stdout,
                  result.stderr,
                  timedOutMessage,
                ),
                timeoutHint,
              ),
            },
          ],
          isError: !ok,
        };
      } catch (error: unknown) {
        span.recordException(error);
        span.end(false, { "mcp.command.status": "exception" });
        return {
          content: [
            {
              type: "text",
              text: `EXIT_CODE: unknown\nUnexpected error:\n${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "run_background",
    {
      description:
        "Start a shell command in the background and capture stdout/stderr to log files.",
      inputSchema: {
        command: commandSchema,
        cmd: commandSchema,
        cwd: z.string().optional().describe("Working directory override."),
        env: envSchema,
      },
    },
    async ({ command, cmd, cwd, env }) => {
      const span = observability.toolSpan("run_background", {
        "mcp.command.cwd": cwd,
      });

      try {
        const normalizedCommand = normalizeCommand(command, cmd);
        if (!normalizedCommand) {
          span.end(false, { "mcp.command.valid": false });
          return {
            content: [
              {
                type: "text",
                text: 'Either "command" or "cmd" must be provided.',
              },
            ],
            isError: true,
          };
        }

        span.setAttribute("mcp.command.value", normalizedCommand);
        const started = backgroundManager.start(
          normalizedCommand,
          resolveOverrides(cwd, env),
        );

        span.end(true, {
          "mcp.command.pid": started.pid,
        });

        return {
          content: [
            {
              type: "text",
              text: `Started background process.\n${formatBackgroundView(started)}`,
            },
          ],
        };
      } catch (error: unknown) {
        span.recordException(error);
        span.end(false);
        return {
          content: [
            {
              type: "text",
              text: `Failed to start background process:\n${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_background",
    {
      description:
        "List tracked background processes and their status/log paths.",
      inputSchema: {},
    },
    async () => {
      const span = observability.toolSpan("list_background");
      const entries = backgroundManager.list();
      span.end(true, {
        "mcp.background.count": entries.length,
      });

      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No tracked background processes.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: entries
              .map((entry) => formatBackgroundView(entry))
              .join("\n\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "kill_background",
    {
      description: "Stop a tracked background process by PID.",
      inputSchema: {
        pid: z
          .number()
          .int()
          .positive()
          .describe("PID of the process to stop."),
      },
    },
    async ({ pid }) => {
      const span = observability.toolSpan("kill_background", {
        "mcp.command.pid": pid,
      });
      const result = backgroundManager.kill(pid);
      span.end(result.ok, {
        "mcp.command.status": result.ok ? "ok" : "error",
      });
      return {
        content: [
          {
            type: "text",
            text: result.view
              ? `${result.message}\n${formatBackgroundView(result.view)}`
              : result.message,
          },
        ],
        isError: !result.ok,
      };
    },
  );

  server.registerTool(
    "tail_background",
    {
      description:
        "Read the last N lines from stdout/stderr logs for a tracked background process.",
      inputSchema: {
        pid: z.number().int().positive().describe("PID to inspect."),
        lines: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(200)
          .describe("Number of lines to read from the end of each log."),
      },
    },
    async ({ pid, lines }) => {
      const span = observability.toolSpan("tail_background", {
        "mcp.command.pid": pid,
        "mcp.command.tail_lines": lines,
      });

      const result = await backgroundManager.tail(pid, lines);
      if (!result.ok || !result.view) {
        span.end(false);
        return {
          content: [
            {
              type: "text",
              text: result.message,
            },
          ],
          isError: true,
        };
      }

      span.end(true, {
        "mcp.command.status": result.view.status,
      });

      return {
        content: [
          {
            type: "text",
            text: [
              result.message,
              formatBackgroundView(result.view),
              `STDOUT_TAIL:\n${result.stdout || "<empty>"}`,
              `STDERR_TAIL:\n${result.stderr || "<empty>"}`,
            ].join("\n\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "wait_background",
    {
      description:
        "Wait for a tracked background process to finish and return final status.",
      inputSchema: {
        pid: z.number().int().positive().describe("PID to wait on."),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .default(60)
          .describe("How long to wait before returning timeout."),
      },
    },
    async ({ pid, timeoutSeconds }) => {
      const { effectiveTimeoutSeconds, timeoutHint } =
        clampTimeoutSeconds(timeoutSeconds);
      const span = observability.toolSpan("wait_background", {
        "mcp.command.pid": pid,
        "mcp.command.timeout_seconds": effectiveTimeoutSeconds,
      });
      span.setAttribute("mcp.command.timeout_seconds.requested", timeoutSeconds);
      span.setAttribute(
        "mcp.command.timeout_seconds.capped",
        effectiveTimeoutSeconds !== timeoutSeconds,
      );

      const result = await backgroundManager.wait(pid, effectiveTimeoutSeconds);
      if (!result.view) {
        span.end(false, { "mcp.command.status": "missing_process" });
        return {
          content: [
            {
              type: "text",
              text: appendHint(result.message, timeoutHint),
            },
          ],
          isError: true,
        };
      }

      if (result.timedOut) {
        observability.markTimeout("wait_background");
      }

      const logs = await backgroundManager.readLogs(pid);
      const failed =
        !result.ok ||
        result.timedOut ||
        (typeof result.view.exitCode === "number" &&
          result.view.exitCode !== 0);

      span.end(!failed, {
        "mcp.command.status": result.view.status,
        "mcp.command.exit_code": result.view.exitCode ?? -1,
        "mcp.command.timed_out": result.timedOut,
      });

      return {
        content: [
          {
            type: "text",
            text: appendHint(
              [
                result.message,
                formatBackgroundView(result.view),
                `STDOUT:\n${logs?.stdout?.trim() || "<empty>"}`,
                `STDERR:\n${logs?.stderr?.trim() || "<empty>"}`,
              ].join("\n\n"),
              timeoutHint,
            ),
          },
        ],
        isError: failed,
      };
    },
  );}
