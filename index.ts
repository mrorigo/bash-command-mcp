#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BackgroundProcessManager,
  type BackgroundLifecycleEvent,
  type BackgroundProcessView,
} from "./src/background-manager.js";
import { Observability } from "./src/observability.js";
import { registerTools } from "./src/tools.js";

const server = new McpServer({
  name: "bash-command-mcp",
  version: "1.0.0",
});

const observability = new Observability();

function onBackgroundLifecycle(
  event: BackgroundLifecycleEvent,
  view: BackgroundProcessView,
): void {
  if (event === "started") {
    observability.backgroundEvent("started", {
      "mcp.command.pid": view.pid,
      "mcp.command.status": view.status,
      "mcp.command.cwd": view.cwd,
    });
    return;
  }

  observability.backgroundEvent("ended", {
    "mcp.command.pid": view.pid,
    "mcp.command.status": view.status,
    "mcp.command.exit_code": view.exitCode ?? -1,
    "mcp.command.signal": view.signal ?? "none",
  });
}

const backgroundManager = new BackgroundProcessManager(
  process.env.BASH_COMMAND_MCP_LOG_DIR,
  onBackgroundLifecycle,
);
registerTools(server, backgroundManager, observability);

async function shutdownWithCode(exitCode: number): Promise<void> {
  try {
    await observability.shutdown();
  } catch (error) {
    console.error("Observability shutdown error:", error);
  } finally {
    process.exit(exitCode);
  }
}

async function main() {
  await observability.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const status = observability.getStatus();
  console.error(
    `bash-command-mcp running on stdio (observability=${status.enabled ? "on" : "off"}, reason=${status.reason})`,
  );

  process.on("SIGINT", () => {
    void shutdownWithCode(0);
  });

  process.on("SIGTERM", () => {
    void shutdownWithCode(0);
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  void shutdownWithCode(1);
});
