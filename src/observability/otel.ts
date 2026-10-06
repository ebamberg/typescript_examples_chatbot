import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { SpanStatusCode, trace, Tracer, metrics, Meter } from '@opentelemetry/api';
import { RequestOptions } from '@openrouter/sdk/lib/sdks.js';
import { ChatResult } from '@openrouter/sdk/models';
import { MeterProvider, PeriodicExportingMetricReader, AggregationType } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { ChatCompletionFn, NonStreamingChatCompletionRequest } from '../harness/types.js';
import { log } from '../logger.js';

// Bucket boundaries tuned for LLM traffic (default OTel buckets are tuned for web request
// latencies in ms, not multi-second LLM calls or fractional-cent costs) so that
// histogram_quantile(0.9|0.95|0.99, ...) in Grafana gets meaningful resolution.
const DURATION_BUCKETS_S = [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
const COST_BUCKETS_USD = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];
const TOKEN_BUCKETS = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];

let openTelemetryClient: NodeSDK;
export let root_tracer: Tracer;
export let root_meter: Meter;

// Critical for standalone apps: flush buffers before the process ends
export async function shutdownOpenTelemetry(): Promise<void> {
  if (openTelemetryClient) {
        await openTelemetryClient.shutdown();
        log.success('OTel', 'shutdown complete — traces flushed.');
  }
}

const shutdown = () => {
        shutdownOpenTelemetry()
                .catch((error) => log.error('OTel', 'shutdown failed:', error))
                .finally(() => process.exit(0));
};

export function initOpenTelemetry(appName: string, appVersion: string) {

    const resource= resourceFromAttributes ({
            [ATTR_SERVICE_NAME]: appName,
            [ATTR_SERVICE_VERSION]: appVersion,
    });

    const traceExporter = new OTLPTraceExporter({
        url: 'http://localhost:4317', // Port 4317 is the OTLP gRPC port from the docker setup
    });

    openTelemetryClient = new NodeSDK({
        resource: resource,
        traceExporter: traceExporter,
    });

    const metricExporter = new OTLPMetricExporter({
        url: 'http://localhost:4317', // same OTLP gRPC endpoint the collector exposes for traces
    });

    const metricReader = new PeriodicExportingMetricReader({
        exporter: metricExporter,
        // Default is 60000ms (60 seconds). 10 sec just for testing, but in production you might want to increase this to reduce load on the collector.
        exportIntervalMillis: 10000,
        });

    const globalServiceMeterProvider = new MeterProvider({
        resource: resource,
        readers: [metricReader],
        views: [
            {
                instrumentName: "gen_ai.request.duration",
                aggregation: {
                    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                    options: { boundaries: DURATION_BUCKETS_S },
                },
            },
            {
                instrumentName: "gen_ai.response.cost",
                aggregation: {
                    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                    options: { boundaries: COST_BUCKETS_USD },
                },
            },
            {
                instrumentName: "gen_ai.response.total_tokens",
                aggregation: {
                    type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
                    options: { boundaries: TOKEN_BUCKETS },
                },
            },
        ],
    });

    // Set this MeterProvider to be global to the app being instrumented.
    metrics.setGlobalMeterProvider(globalServiceMeterProvider);

    try {
        openTelemetryClient.start();
        log.success('OTel', `initialized (service=${appName} v${appVersion})`);
        // shutting own on exit
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);

        root_tracer = trace.getTracer(appName, appVersion);
        root_meter = metrics.getMeter(appName, appVersion);
    } catch (error) {
        log.error('OTel', 'initialization failed:', error);
        throw error;
    }
}

export function withTraceRequest<F extends ChatCompletionFn<F>>(fn: F) {

    return ( (request: NonStreamingChatCompletionRequest, options?: RequestOptions) =>  {

        const currentSpan = trace.getActiveSpan();
        const model = request.chatRequest.model ?? "unknown";

        const requestCounter = root_meter.createCounter("gen_ai.request.count");
        const errorCounter = root_meter.createCounter("gen_ai.request.errors.count");
        const inputTokenCounter = root_meter.createCounter("gen_ai.request.input_tokens.count");
        const outputTokenCounter = root_meter.createCounter("gen_ai.response.output_tokens.count");
        const totalTokenCounter = root_meter.createCounter("gen_ai.response.total_tokens.count");
        const cacheTokenCounter = root_meter.createCounter("gen_ai.cache.token.count");
        const priceCounter = root_meter.createCounter("gen_ai.response.price.count");

        // Histograms: per-request distributions (needed for p90/p95/p99), as opposed to the
        // counters above which only give running totals/rates.
        const durationHistogram = root_meter.createHistogram("gen_ai.request.duration", {
            description: "Duration of a single chat completion request",
            unit: "s",
        });
        const costHistogram = root_meter.createHistogram("gen_ai.response.cost", {
            description: "Cost of a single chat completion response",
            unit: "usd",
        });
        const tokenHistogram = root_meter.createHistogram("gen_ai.response.total_tokens", {
            description: "Total tokens (prompt + completion) consumed by a single response",
            unit: "tokens",
        });

        if (currentSpan) {
            request.chatRequest.model && currentSpan.setAttribute("gen_ai.request.model", request.chatRequest.model);
            request.chatRequest.temperature && currentSpan.setAttribute("gen_ai.request.temperature", request.chatRequest.temperature);
            request.chatRequest.messages && currentSpan.setAttribute("gen_ai.request.messages", JSON.stringify(request.chatRequest.messages));
            request.chatRequest.maxTokens && currentSpan.setAttribute("gen_ai.request.max_tokens", request.chatRequest.maxTokens);
            request.chatRequest.topP && currentSpan.setAttribute("gen_ai.request.top_p", request.chatRequest.topP);
        }

        requestCounter.add(1, { "gen_ai.request.model": model });

        const startTime = performance.now();
        const recordDuration = (status: "ok" | "error") => {
            durationHistogram.record((performance.now() - startTime) / 1000, {
                "gen_ai.request.model": model,
                "gen_ai.response.status": status,
            });
        };

        const reportResponse = (resp: ChatResult) => {
            const totalTokens = resp.usage?.totalTokens ?? 0;
            const cost = resp.usage?.cost ?? 0;

            if (currentSpan) {
                currentSpan.setAttribute("gen_ai.response.id", resp.id);
                currentSpan.setAttribute("gen_ai.response.model", resp.model);
                currentSpan.setAttribute("gen_ai.response.finish_reason", resp.choices[0].finishReason ?? "unknown");
                currentSpan.setAttribute("gen_ai.response.usage", JSON.stringify(resp.usage ?? {}));
                currentSpan.setAttribute("gen_ai.response.cost", cost);
            }

            totalTokenCounter.add(totalTokens, { "gen_ai.request.model": model });
            inputTokenCounter.add(resp.usage?.promptTokens ?? 0, { "gen_ai.request.model": model });
            outputTokenCounter.add(resp.usage?.completionTokens ?? 0, { "gen_ai.request.model": model });
            cacheTokenCounter.add(resp.usage?.promptTokensDetails?.cachedTokens ?? 0, { "gen_ai.request.model": model });
            priceCounter.add(cost, { "gen_ai.request.model": model });

            tokenHistogram.record(totalTokens, { "gen_ai.request.model": model });
            costHistogram.record(cost, { "gen_ai.request.model": model });
            recordDuration("ok");
        };

        const reportError = (error: any) => {
            errorCounter.add(1, {
                "gen_ai.request.model": model,
                "error.type": error?.name ?? "unknown",
            });
            recordDuration("error");
        };

        let response: ReturnType<F>;
        try {
            response = fn(request, options);
        } catch (error) {
            reportError(error);
            throw error;
        }

        if (response instanceof Promise) {
            response = response.then((res) => {
                reportResponse(res as ChatResult);
                return res;
            }).catch((error) => {
                reportError(error);
                throw error;
            }) as ReturnType<F>;
        } else {
            reportResponse(response as ChatResult);
        }

        return response;
    });
}

export function withTrace<F extends (...args: any[]) => any>(spanName: string, fn: F) {
    return ((...args: Parameters<F>) => {
        return root_tracer.startActiveSpan(spanName, (span) => {
            let result: any;
            try {
                result = fn(...args);
            } catch (error: any) {
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                span.end();
                throw error;
            }

            if (result instanceof Promise) {
                // async: don't end the span until the promise settles
                return result
                    .then((res) => {
                        span.setStatus({ code: SpanStatusCode.OK });
                        return res;
                    })
                    .catch((error) => {
                        span.recordException(error);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                        throw error;
                    })
                    .finally(() => {
                        span.end();
                    });
            } else {
                // sync: end the span immediately
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return result;
            }
        });
    });
};


