import { initOpenTelemetry, shutdownOpenTelemetry, withTrace } from './observability/otel';
import {SimpleResponse} from './model';
import { readFileSync} from 'fs';
import { createInterface } from 'readline/promises';
import { askForInput, displayAnswer } from './chatinterface/chatinterface';
import { history, initialize_history } from './chathistory/chathistory';
import { call_llm } from './openrouter';
import { ToolDefinition } from './tools/tools';
import { log } from './logger';

const systemPrompt = readFileSync('src/prompts/system_prompt.md', 'utf8');

async function main() {
    log.info("App", "starting typescript example.......");
    
  initOpenTelemetry("knowledgebasereader","0.0.1");
  initialize_history(systemPrompt);

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
        const response = await llm_execute(history, normalizedMessage, "SimpleResponse", tools);
        displayAnswer(response.answer);
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