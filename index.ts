#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  BackgroundProcessManager,
  type BackgroundLifecycleEvent,
  type BackgroundProcessView,
} from "./src/background-manager.js";
import { parseAllowedHosts, validateHostHeader } from "./src/http-transport.js";
import { Observability } from "./src/observability.js";
import { registerTools } from "./src/tools.js";

const server = new McpServer({
  name: "bash-command-mcp",
  version: "1.0.0",
});

const observability = new Observability();
const transportMode = (process.env.BASH_COMMAND_MCP_TRANSPORT ?? "stdio").toLowerCase();
const httpHost = process.env.BASH_COMMAND_MCP_HOST ?? "127.0.0.1";
const httpPort = Number.parseInt(process.env.BASH_COMMAND_MCP_PORT ?? "3000", 10);
const allowedHosts = parseAllowedHosts(
  process.env.BASH_COMMAND_MCP_ALLOWED_HOSTS,
  httpHost,
);

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

async function runHttpTransport(): Promise<void> {
  const transport = new StreamableHTTPServerTransport();

  await server.connect(transport as never);

  const httpServer = createServer((req, res) => {
    if (!validateHostHeader(req, res, httpHost, allowedHosts)) {
      return;
    }

    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(httpPort, httpHost, () => resolve());
  });

  const status = observability.getStatus();
  console.error(
    `bash-command-mcp running on http://${httpHost}:${httpPort} (observability=${status.enabled ? "on" : "off"}, reason=${status.reason})`,
  );

  const shutdown = async (exitCode: number): Promise<void> => {
    try {
      await transport.close();
      await observability.shutdown();
    } catch (error) {
      console.error("Shutdown error:", error);
    } finally {
      httpServer.close();
      process.exit(exitCode);
    }
  };

  process.on("SIGINT", () => {
    void shutdown(0);
  });

  process.on("SIGTERM", () => {
    void shutdown(0);
  });
}

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

  if (transportMode === "http") {
    await runHttpTransport();
    return;
  }

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
