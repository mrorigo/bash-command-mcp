import { createRequire } from "node:module";
import { getErrorMessage } from "./error-utils.js";

export type TelemetryAttributes = Record<
  string,
  string | number | boolean | undefined
>;

type SanitizedAttributes = Record<string, string | number | boolean>;

type SpanLike = {
  setAttribute: (key: string, value: string | number | boolean) => void;
  addEvent: (name: string, attributes?: SanitizedAttributes) => void;
  recordException: (error: Error) => void;
  setStatus: (status: { code: number }) => void;
  end: () => void;
};

type TracerLike = {
  startSpan: (
    name: string,
    options?: { attributes?: SanitizedAttributes },
  ) => SpanLike;
};

type CounterLike = {
  add: (value: number, attributes?: SanitizedAttributes) => void;
};

type HistogramLike = {
  record: (value: number, attributes?: SanitizedAttributes) => void;
};

type MeterLike = {
  createCounter: (
    name: string,
    options?: { description?: string },
  ) => CounterLike;
  createHistogram: (
    name: string,
    options?: { description?: string; unit?: string },
  ) => HistogramLike;
};

type OTelApiLike = {
  trace: {
    getTracer: (name: string, version?: string) => TracerLike;
  };
  metrics: {
    getMeter: (name: string, version?: string) => MeterLike;
  };
  SpanStatusCode: {
    ERROR: number;
  };
};

type NodeSdkLike = {
  start: () => Promise<void> | void;
  shutdown: () => Promise<void>;
};

type NodeSdkCtor = new (options: {
  resource: unknown;
  traceExporter: unknown;
  metricReader: unknown;
}) => NodeSdkLike;

type ResourceCtor = new (attributes: Record<string, string>) => unknown;

type ToolSpan = {
  setAttribute: (key: string, value: string | number | boolean) => void;
  addEvent: (name: string, attrs?: TelemetryAttributes) => void;
  recordException: (error: unknown) => void;
  end: (ok: boolean, attrs?: TelemetryAttributes) => void;
};

type ObservabilityStatus = {
  enabled: boolean;
  reason: string;
  serviceName: string;
  exporter: string;
};

function sanitizeAttributes(attrs: TelemetryAttributes): SanitizedAttributes {
  const out: SanitizedAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function assertObject(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`${context}: expected object`);
  }
  return value as Record<string, unknown>;
}

function asCallable<T extends (...args: never[]) => unknown>(
  value: unknown,
  context: string,
): T {
  if (typeof value !== "function") {
    throw new Error(`${context}: expected function`);
  }
  return value as T;
}

function asConstructor<T extends new (...args: never[]) => unknown>(
  value: unknown,
  context: string,
): T {
  if (typeof value !== "function") {
    throw new Error(`${context}: expected constructor`);
  }
  return value as T;
}

function asTracerLike(value: unknown): TracerLike {
  const obj = assertObject(value, "tracer");
  const startSpan = asCallable(obj.startSpan, "tracer.startSpan").bind(obj);
  return {
    startSpan: startSpan as TracerLike["startSpan"],
  };
}

function asMeterLike(value: unknown): MeterLike {
  const obj = assertObject(value, "meter");
  const createCounter = asCallable(
    obj.createCounter,
    "meter.createCounter",
  ).bind(obj);
  const createHistogram = asCallable(
    obj.createHistogram,
    "meter.createHistogram",
  ).bind(obj);
  return {
    createCounter: createCounter as MeterLike["createCounter"],
    createHistogram: createHistogram as MeterLike["createHistogram"],
  };
}

class NoopToolSpan implements ToolSpan {
  setAttribute(): void {}
  addEvent(): void {}
  recordException(): void {}
  end(): void {}
}

export class Observability {
  private tracer: TracerLike | null = null;
  private sdk: NodeSdkLike | null = null;
  private spanStatusCodeError: number | null = null;
  private status: ObservabilityStatus;

  private toolCalls: CounterLike | null = null;
  private toolFailures: CounterLike | null = null;
  private toolTimeouts: CounterLike | null = null;
  private toolDuration: HistogramLike | null = null;
  private bgStarted: CounterLike | null = null;
  private bgEnded: CounterLike | null = null;

  constructor() {
    this.status = {
      enabled: false,
      reason: "not_initialized",
      serviceName: process.env.OTEL_SERVICE_NAME || "bash-command-mcp",
      exporter: "none",
    };
  }

  async init(): Promise<void> {
    if (process.env.OTEL_ENABLED === "false") {
      this.status = {
        ...this.status,
        enabled: false,
        reason: "disabled_by_env",
      };
      return;
    }

    const requireFn = createRequire(import.meta.url);

    try {
      const otelApiUnknown = requireFn("@opentelemetry/api") as unknown;
      const sdkNodeUnknown = requireFn("@opentelemetry/sdk-node") as unknown;
      const resourcesUnknown = requireFn("@opentelemetry/resources") as unknown;

      const otelApiObj = assertObject(otelApiUnknown, "@opentelemetry/api");
      const sdkNodeObj = assertObject(
        sdkNodeUnknown,
        "@opentelemetry/sdk-node",
      );
      const resourcesObj = assertObject(
        resourcesUnknown,
        "@opentelemetry/resources",
      );

      const traceObj = assertObject(otelApiObj.trace, "otelApi.trace");
      const metricsObj = assertObject(otelApiObj.metrics, "otelApi.metrics");
      const spanStatusObj = assertObject(
        otelApiObj.SpanStatusCode,
        "otelApi.SpanStatusCode",
      );

      const getTracer = asCallable<(name: string, version?: string) => unknown>(
        traceObj.getTracer,
        "otelApi.trace.getTracer",
      ).bind(traceObj);
      const getMeter = asCallable<(name: string, version?: string) => unknown>(
        metricsObj.getMeter,
        "otelApi.metrics.getMeter",
      ).bind(metricsObj);

      const otelApi: OTelApiLike = {
        trace: {
          getTracer: (name, version) => asTracerLike(getTracer(name, version)),
        },
        metrics: {
          getMeter: (name, version) => asMeterLike(getMeter(name, version)),
        },
        SpanStatusCode: {
          ERROR:
            typeof spanStatusObj.ERROR === "number" ? spanStatusObj.ERROR : 2,
        },
      };

      const nodeSdkCtor = asConstructor<NodeSdkCtor>(
        sdkNodeObj.NodeSDK,
        "NodeSDK",
      );
      const resourceCtor = asConstructor<ResourceCtor>(
        resourcesObj.Resource,
        "Resource",
      );

      const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

      let traceExporter: unknown;
      let metricReader: unknown;
      let exporterName = "console";

      if (endpoint) {
        const traceHttpUnknown = requireFn(
          "@opentelemetry/exporter-trace-otlp-http",
        ) as unknown;
        const metricHttpUnknown = requireFn(
          "@opentelemetry/exporter-metrics-otlp-http",
        ) as unknown;
        const metricsSdkUnknown = requireFn(
          "@opentelemetry/sdk-metrics",
        ) as unknown;

        const traceHttpObj = assertObject(
          traceHttpUnknown,
          "trace exporter module",
        );
        const metricHttpObj = assertObject(
          metricHttpUnknown,
          "metric exporter module",
        );
        const metricsSdkObj = assertObject(
          metricsSdkUnknown,
          "metrics sdk module",
        );

        const otlpTraceCtor = asConstructor<
          new (opts: { url: string }) => unknown
        >(traceHttpObj.OTLPTraceExporter, "OTLPTraceExporter");
        const otlpMetricCtor = asConstructor<
          new (opts: { url: string }) => unknown
        >(metricHttpObj.OTLPMetricExporter, "OTLPMetricExporter");
        const periodicReaderCtor = asConstructor<
          new (opts: {
            exporter: unknown;
            exportIntervalMillis: number;
          }) => unknown
        >(
          metricsSdkObj.PeriodicExportingMetricReader,
          "PeriodicExportingMetricReader",
        );

        const baseEndpoint = endpoint.replace(/\/$/, "");
        traceExporter = new otlpTraceCtor({
          url: `${baseEndpoint}/v1/traces`,
        });

        const metricExporter = new otlpMetricCtor({
          url: `${baseEndpoint}/v1/metrics`,
        });

        metricReader = new periodicReaderCtor({
          exporter: metricExporter,
          exportIntervalMillis: Number(
            process.env.OTEL_METRIC_EXPORT_INTERVAL_MS || 10000,
          ),
        });

        exporterName = "otlp_http";
      } else {
        const traceBaseUnknown = requireFn(
          "@opentelemetry/sdk-trace-base",
        ) as unknown;
        const metricsSdkUnknown = requireFn(
          "@opentelemetry/sdk-metrics",
        ) as unknown;

        const traceBaseObj = assertObject(
          traceBaseUnknown,
          "trace base module",
        );
        const metricsSdkObj = assertObject(
          metricsSdkUnknown,
          "metrics sdk module",
        );

        const consoleSpanCtor = asConstructor<new () => unknown>(
          traceBaseObj.ConsoleSpanExporter,
          "ConsoleSpanExporter",
        );
        const periodicReaderCtor = asConstructor<
          new (opts: {
            exporter: unknown;
            exportIntervalMillis: number;
          }) => unknown
        >(
          metricsSdkObj.PeriodicExportingMetricReader,
          "PeriodicExportingMetricReader",
        );
        const consoleMetricCtor = asConstructor<new () => unknown>(
          metricsSdkObj.ConsoleMetricExporter,
          "ConsoleMetricExporter",
        );

        traceExporter = new consoleSpanCtor();
        metricReader = new periodicReaderCtor({
          exporter: new consoleMetricCtor(),
          exportIntervalMillis: Number(
            process.env.OTEL_METRIC_EXPORT_INTERVAL_MS || 15000,
          ),
        });
      }

      const serviceName = process.env.OTEL_SERVICE_NAME || "bash-command-mcp";
      const serviceVersion = process.env.OTEL_SERVICE_VERSION || "1.0.0";

      const resource = new resourceCtor({
        "service.name": serviceName,
        "service.version": serviceVersion,
      });

      this.sdk = new nodeSdkCtor({
        resource,
        traceExporter,
        metricReader,
      });

      await this.sdk.start();

      this.tracer = otelApi.trace.getTracer(serviceName, serviceVersion);
      const meter = otelApi.metrics.getMeter(serviceName, serviceVersion);

      this.spanStatusCodeError = otelApi.SpanStatusCode.ERROR;
      this.toolCalls = meter.createCounter("mcp_tool_calls_total", {
        description: "Total MCP tool invocations",
      });
      this.toolFailures = meter.createCounter("mcp_tool_failures_total", {
        description: "Total failed MCP tool invocations",
      });
      this.toolTimeouts = meter.createCounter("mcp_tool_timeouts_total", {
        description: "Total timed out MCP tool invocations",
      });
      this.toolDuration = meter.createHistogram("mcp_tool_duration_ms", {
        description: "MCP tool execution duration",
        unit: "ms",
      });
      this.bgStarted = meter.createCounter("mcp_background_started_total", {
        description: "Total started background processes",
      });
      this.bgEnded = meter.createCounter("mcp_background_ended_total", {
        description: "Total ended background processes",
      });

      this.status = {
        enabled: true,
        reason: "active",
        serviceName,
        exporter: exporterName,
      };
    } catch (error: unknown) {
      this.status = {
        enabled: false,
        reason: `otel_unavailable: ${getErrorMessage(error)}`,
        serviceName: process.env.OTEL_SERVICE_NAME || "bash-command-mcp",
        exporter: "none",
      };
    }
  }

  getStatus(): ObservabilityStatus {
    return this.status;
  }

  toolSpan(name: string, attrs: TelemetryAttributes = {}): ToolSpan {
    if (!this.tracer) {
      return new NoopToolSpan();
    }

    const startedAt = process.hrtime.bigint();
    const span = this.tracer.startSpan(`mcp.tool.${name}`, {
      attributes: sanitizeAttributes({
        "mcp.tool.name": name,
        ...attrs,
      }),
    });

    this.toolCalls?.add(1, { tool: name });

    return {
      setAttribute: (key, value) => span.setAttribute(key, value),
      addEvent: (eventName, eventAttrs) => {
        span.addEvent(eventName, sanitizeAttributes(eventAttrs || {}));
      },
      recordException: (error) => {
        if (error instanceof Error) {
          span.recordException(error);
        } else {
          span.recordException(new Error(getErrorMessage(error)));
        }
      },
      end: (ok, endAttrs = {}) => {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        this.toolDuration?.record(durationMs, { tool: name, ok: String(ok) });

        if (!ok) {
          this.toolFailures?.add(1, { tool: name });
          if (this.spanStatusCodeError !== null) {
            span.setStatus({
              code: this.spanStatusCodeError,
            });
          }
        }

        const finalAttrs = sanitizeAttributes(endAttrs);
        for (const [k, v] of Object.entries(finalAttrs)) {
          span.setAttribute(k, v);
        }
        span.end();
      },
    };
  }

  markTimeout(toolName: string): void {
    this.toolTimeouts?.add(1, { tool: toolName });
  }

  backgroundEvent(
    event: "started" | "ended",
    attrs: TelemetryAttributes = {},
  ): void {
    const span = this.tracer?.startSpan(`mcp.background.${event}`, {
      attributes: sanitizeAttributes(attrs),
    });
    if (event === "started") {
      this.bgStarted?.add(1);
    }
    if (event === "ended") {
      this.bgEnded?.add(1);
    }
    span?.end();
  }

  async shutdown(): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.shutdown();
  }
}
