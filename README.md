# bash-command-mcp

A highly sophisticated Bash MCP server for safe, structured command execution with first-class background job orchestration.

## Important Security Warning

This server executes shell commands on the machine where it is running.

If you run `bun run index.ts` directly on your host, commands run on your host with your user permissions.
Use Docker to isolate execution unless you fully trust the MCP client and prompts.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To run via npm/npx (published package):

```bash
npx -y bash-command-mcp
```

## Why This Server

- High-fidelity shell execution with clear exit-code semantics.
- Advanced background process lifecycle controls (`run_background`, `wait_background`, `kill_background`).
- Built-in observability via per-process stdout/stderr log files.
- OpenTelemetry traces and metrics for production visibility.
- Agent-friendly ergonomics with `cwd` and `env` overrides for precise execution context.

## Tool Behavior

Tools:
- `run`: run command in foreground.
  Args: `command` or `cmd`, `timeoutSeconds` (default `60`, min `1`; values above `86400` are capped with a hint), optional `cwd`, optional `env`.
- `run_background`: start command in background with stdout/stderr written to log files.
  Args: `command` or `cmd`, optional `cwd`, optional `env`.
- `list_background`: list tracked background processes, including log file paths.
- `kill_background`: stop tracked background process by `pid`.
- `tail_background`: show last N lines from background process logs.
  Args: `pid`, optional `lines` (default `200`, max `5000`).
- `wait_background`: wait for background process completion and return final status/output.
  Args: `pid`, optional `timeoutSeconds` (default `60`, min `1`; values above `86400` are capped with a hint).
## OpenTelemetry

This server includes built-in OpenTelemetry instrumentation for traces and metrics.

- OpenTelemetry packages are installed with the server package.
- Telemetry initializes unless `OTEL_ENABLED=false`.
- If `OTEL_EXPORTER_OTLP_ENDPOINT` is set, traces/metrics are exported via OTLP HTTP.
- If no OTLP endpoint is configured, console exporters are used.

Instrumented operations:
- Tool call spans for `run`, `run_background`, `list_background`, `tail_background`, `wait_background`, and `kill_background`.
- Background lifecycle spans/counters (`started`, `ended`).
- Metrics for tool calls, failures, timeouts, and duration histograms.

Common env vars:
- `OTEL_ENABLED=true|false`
- `OTEL_SERVICE_NAME=bash-command-mcp`
- `OTEL_SERVICE_VERSION=1.0.0`
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`
- `OTEL_METRIC_EXPORT_INTERVAL_MS=10000`
- `BASH_COMMAND_MCP_LOG_DIR=/path/to/log-dir`

Example (OTLP Collector on localhost):

```bash
OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=bash-command-mcp \
npx -y bash-command-mcp
```


## Docker

Build the image:

```bash
docker build -t bash-command-mcp .
```

Run with a local folder mounted at `/workspace`:

```bash
docker run --rm -i -v "$(pwd):/workspace" bash-command-mcp
```

`/workspace` mapping explained:
- Left side (`$(pwd)`) is a folder on your host machine.
- Right side (`/workspace`) is the path inside the container.
- Commands run by this MCP server should target files under `/workspace`; those changes are written back to the mapped host folder.

Example:
- If your host has `./project/file.txt` and you run the container from `./project`, the same file is available in the container at `/workspace/file.txt`.
