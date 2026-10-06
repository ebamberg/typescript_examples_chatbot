import { SendChatCompletionRequestRequest } from '@openrouter/sdk/models/operations/sendchatcompletionrequest.js';
import { RequestOptions } from '@openrouter/sdk/lib/sdks.js';

/**
 * A chat completion request restricted to non-streaming calls
 * (`chatRequest.stream` must be `false` or omitted).
 */
export type NonStreamingChatCompletionRequest = SendChatCompletionRequestRequest & {
    chatRequest: {
        stream?: false | undefined;
    };
};

/**
 * Signature of a function that performs a single non-streaming chat completion call,
 * e.g. the OpenRouter SDK's `sendChatCompletionRequest`. Used as a generic bound so
 * wrapper/decorator functions (retry, tracing, ...) can preserve the wrapped
 * function's return type.
 */
export type ChatCompletionFn<F extends (...args: any) => any> = (
    request: NonStreamingChatCompletionRequest,
    options?: RequestOptions,
) => ReturnType<F>;
