
import {OpenRouter} from '@openrouter/sdk';
import { SendChatCompletionRequestResponse } from '@openrouter/sdk/models/operations';
import * as TJS from "typescript-json-schema";
import { resolve } from "path";
import { ChatMessages, ChatToolCall, ChatToolMessage } from '@openrouter/sdk/models';
import { ToolDefinition } from './tools/tools';
import { withTrace, withTraceRequest } from './observability/otel';
import { withRetryOnError } from './harness/harness';
import { add_to_history, with_history_lock } from './chathistory/chathistory';
import { log } from './logger';

// const model = "openai/gpt-4o-mini"; // doesn't follows rules in the okf files+system prompt.
// const model = "google/gemini-3-flash-preview"; // good but structured output fails often
const model = "google/gemini-3.5-flash"
// const model = "qwen/qwen3.8-27b"; // doesn't work at all
const TEMPERATURE = 0.1;
const MAX_TURNS = 20;
export const client = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY
});
export const send_chat_request = withTrace("ChatRequest "+model, 
                                withRetryOnError(
                                    withTraceRequest(client.chat.send.bind(client.chat))
                                )
                            );

export class LLMError extends Error {
}

export class ToolCallError extends LLMError {  
}

export function generateJsonSchema(typename: string): TJS.Definition {
    const compilerOptions: TJS.CompilerOptions = {
        strictNullChecks: true,
    };
    const program = TJS.getProgramFromFiles(
        [resolve("src/model.ts")],
        compilerOptions,
        "./src",
    );
    let schema =TJS.generateSchema(program, typename, {
        required: true,
        ref: false,
    });
    if (schema) {
        schema.additionalProperties = false;
        return schema;
    } else {
        throw new Error("Failed to generate schema");
    }
}

export interface LLMResponse<Type> {
    parsed: Type;
    plannedToolExecutions: Array<Promise<void>>;
}

export async function call_llm<Type>(targetHistory: ChatMessages[], prompt: string, output_typename: string, tools: Array<ToolDefinition> = []): Promise<LLMResponse<Type>> {
    return with_history_lock(targetHistory, async () => {
        const my_schema = generateJsonSchema(output_typename);
        const tools_schemas = tools.map((tool) => tool.schema);
        let turns = 0;
        const plannedToolExecutions: Array<Promise<void>> = [];

        if (prompt.trim().length === 0) {
            throw new LLMError("Prompt is empty");
        } else if (prompt === 'TOOL_RESULTS_AVAILABLE') {
            log.info("Chatbot", "Tool results are available now.");
            add_to_history({ role: 'assistant', content: "new tool results available from background I can find them in the chat history. Analyse the chat history for unavailable information at a previous time and answer the users previous question based on the new information." }, targetHistory);
        } else {
            add_to_history({ role: 'user', content: prompt }, targetHistory);
        }

        while (turns < MAX_TURNS) {
            turns += 1;
            const response: SendChatCompletionRequestResponse = await send_chat_request({
                chatRequest: {
                    model: model,
                    messages: targetHistory,
                    temperature: TEMPERATURE,
                    responseFormat: {
                        type: 'json_schema',
                        jsonSchema: {
                            name: output_typename,
                            strict: true,
                            schema: my_schema,
                        },
                    },
                    tools: tools_schemas,
                    toolChoice: 'auto',
                },
            });

            if (!('choices' in response)) {
                throw new LLMError('Expected a non-streaming chat completion response');
            }

            const responseMessage = response.choices[0].message;
            add_to_history(responseMessage, targetHistory);

            const finishReason = response.choices[0].finishReason;
            log.step('LLM', `response received — finish_reason: "${finishReason}"`);
            if (finishReason === 'tool_calls') {
                for (const tool of responseMessage.toolCalls ?? []) {
                    try {
                        const toolExecutor = withTrace(`execute tool call: ${tool.function.name}`, execute_tool_call);
                        const toolResponsePromise = toolExecutor(tools, tool);
//                                .then((toolResponse: ChatMessages) => {
//                                    add_to_history(toolResponse, targetHistory);
//                                });

                        plannedToolExecutions.push(toolResponsePromise);
                        add_to_history({                          
                                role: "tool",
                                content: JSON.stringify("started the tool "  + tool.function.name + " as a background task. Please continue with the conversation with the user in meanwhile until the result of the tool call is available.."),
                                toolCallId: tool.id,
                            } as ChatToolMessage, targetHistory);
                    } catch (error) {
                        log.error('LLM', `tool call "${tool.function.name}" failed:`, error);
                        add_to_history({
                            role: 'tool',
                            content: `Error while trying to call tool: ${error instanceof Error ? error.message : String(error)}`,
                            toolCallId: tool.id,
                        }, targetHistory);
                    }
                }
            } else if (finishReason === 'stop') {
                if (typeof responseMessage.content !== 'string') {
                    throw new LLMError('Expected the LLM response content to be a JSON string');
                }
                const parsedResponse = JSON.parse(responseMessage.content);
                log.success('LLM', 'final answer:');
                log.json(parsedResponse);
                return {
                    parsed: parsedResponse,
                    plannedToolExecutions: plannedToolExecutions,
                };
            } else {
                throw new LLMError(`unhandled finishReason: ${finishReason}`);
            }
        }

        throw new LLMError('Max Turns reached');
    });
}

export async function execute_tool_call(available_tools: Array<ToolDefinition>, tool: ChatToolCall): Promise<ChatToolMessage> {
    if (tool.type == "function") {
        const tool_def = available_tools.find(t => tool.function.name == t.name);
        if (tool_def) {
            const args = JSON.parse(tool.function.arguments);
            log.step("Tool", `executing "${tool.function.name}" with args: ${JSON.stringify(args)}`);
            return tool_def.callback({ ...args })
                        .then( result => (
                            {
                                role: "tool",
                                content: JSON.stringify(result),
                                toolCallId: tool.id,
                            } as ChatToolMessage
                        ));
        } else {
            throw new ToolCallError(`Error, there is no tool with the name: ${tool.function.name}`);
        }
    } else {
        throw new LLMError(`tool type ${tool.type} not supported`);
    }
}

