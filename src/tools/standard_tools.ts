import { ChatContentItems, ChatToolMessage } from "@openrouter/sdk/models";
import { ToolDefinition } from "./tools";


export const current_date_time: ToolDefinition = {
  name: "current_date_time",
  schema: {
    type: "function",
    function: {
      name: "current_date_time",
      description: "Get the current date and time",
      parameters: {
        type: "object",
        properties: {
        },
        required: [],
      },
    },
  },
  callback: async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 30000));
      return JSON.stringify({ date: new Date().toISOString() });
  }
}
