import { ChatContentItems, ChatToolMessage } from "@openrouter/sdk/models";

export interface ToolCallbackFunction {
    (...args: any[]): string | ChatContentItems[];
}

export interface ToolDefinition {
    name: string,
    schema: any,
    callback : ToolCallbackFunction,
}