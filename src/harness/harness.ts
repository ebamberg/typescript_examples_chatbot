import { RequestOptions } from '@openrouter/sdk/lib/sdks.js';
import { ChatCompletionFn, NonStreamingChatCompletionRequest } from './types.js';
import { SpanStatusCode, trace, Tracer, metrics, Meter } from '@opentelemetry/api';
import { root_meter } from '../observability/otel.js';
import { log } from '../logger.js';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 250;
const BACKOFF_MULTIPLIER = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function withRetryOnError<F extends ChatCompletionFn<F>>(fn: F, maxRetries: number = MAX_RETRIES, initialBackoffMs: number = INITIAL_BACKOFF_MS, backoffMultiplier: number = BACKOFF_MULTIPLIER) {

    return ( (request: NonStreamingChatCompletionRequest, options?: RequestOptions) => {

        const model = request.chatRequest.model ?? "unknown";

        // Counters for stability monitoring: how often a call needs to be retried, and how
        // often it still fails after every retry has been exhausted (a give-up).
        const retryCounter = root_meter.createCounter("gen_ai.request.retries.count", {
            description: "Number of retry attempts made after a failed chat completion call",
        });
        const retryExhaustedCounter = root_meter.createCounter("gen_ai.request.retries_exhausted.count", {
            description: "Number of requests that still failed after exhausting all retries",
        });

        const attemptCall = (attempt: number, backoffMs: number): ReturnType<F> => {
            trace.getActiveSpan()?.setAttribute("retry.attempt", attempt);

            // the inner handle Error method
            const handleError = (error: unknown) => {
                const errorType = (error as Error)?.name ?? "unknown";
                if (attempt === MAX_RETRIES) {
                    retryExhaustedCounter.add(1, { "gen_ai.request.model": model, "error.type": errorType });
                    log.error("Retry", `giving up after ${MAX_RETRIES} attempts:`, error);
                    trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
                    throw error;
                }
                retryCounter.add(1, { "gen_ai.request.model": model, "error.type": errorType, "retry.attempt": attempt });
                trace.getActiveSpan()?.addEvent("retry.error", { "error.message": (error as Error).message, "retry.attempt": attempt });
                log.warn("Retry", `attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${backoffMs}ms...`, error);
            };

            try {
                const response = fn(request, options);

                if (response instanceof Promise) {
                    // async fn: retries happen in the rejection handler instead of a catch block
                    return response.catch((error) => {
                        handleError(error);
                        return sleep(backoffMs).then(() => attemptCall(attempt + 1, backoffMs * BACKOFF_MULTIPLIER));
                    }) as ReturnType<F>;
                }

                return response;
            } catch (error) {
                handleError(error);
                // wait for backoffMs before retrying. typsecript doesn't allow await in a non-async function, so we wrap the sleep in an async IIFE
                 (async () => { 
                    await new Promise(f => setTimeout(f, backoffMs));
                 })();
                return attemptCall(attempt + 1, backoffMs * BACKOFF_MULTIPLIER);
            }
        };

        return attemptCall(0, INITIAL_BACKOFF_MS);
    }) as F;
}
