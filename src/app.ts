import {call_llm} from './openrouter'
import { initOpenTelemetry, shutdownOpenTelemetry, withTrace } from './observability/otel';
import {SimpleResponse} from './model';
import { readFileSync} from 'fs';
import { createInterface } from 'readline/promises';
import { ToolDefinition } from './tools/tools';
import { log } from './logger';

const systemPrompt = readFileSync('src/prompts/system_prompt.md', 'utf8');

async function askForInput(terminal: ReturnType<typeof createInterface>): Promise<string> {
  return terminal.question('\nYou> ');
}

async function main() {
  initOpenTelemetry("knowledgebasereader","0.0.1");
    log.info("App", "starting typescript example.......");

  const tools: ToolDefinition[] = [];
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const llm_execute = withTrace("call llm", call_llm<SimpleResponse>);

  try {
    log.info("Chatbot", "Ask me anything. Type 'quit' or 'exit' to stop.");
    while (true) {
      let message: string;
      try {
        message = await askForInput(terminal);
      } catch {
        break;
      }

      const normalizedMessage = message.trim();
      if (["quit", "exit"].includes(normalizedMessage.toLowerCase())) {
        break;
      }
      if (!normalizedMessage) {
        continue;
      }

      try {
        const response = await llm_execute(systemPrompt, normalizedMessage, "SimpleResponse", tools);
        log.success("Chatbot", response.answer);
      } catch (error) {
        log.error("Chatbot", "I couldn't get an answer. Please try again.", error);
      }
    }
  } finally {
    terminal.close();
    log.info("Chatbot", "Goodbye.");
    await shutdownOpenTelemetry();
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  log.error("App", "Chatbot stopped unexpectedly.", error);
  process.exit(1);
});