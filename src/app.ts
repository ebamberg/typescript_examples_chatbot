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
const llm_execute = withTrace("chatbot llm", call_llm<SimpleResponse>);
const tools: ToolDefinition[] = [];
let interrupted =false;

const handleUserInput = (message: string) => {
          const normalizedMessage = message.trim();
          if (["quit", "exit"].includes(normalizedMessage.toLowerCase())) {
            interrupted=true;
            return "bye bye";
          } else {
            return llm_execute(history, normalizedMessage, "SimpleResponse", tools);
          }
          
      };

async function main() {
    log.info("App", "starting typescript example.......");

  initOpenTelemetry("knowledgebasereader","0.0.1");
  initialize_history(systemPrompt);


  const terminal = createInterface({ input: process.stdin, output: process.stdout });


  try {
    log.info("Chatbot", "Ask me anything. Type 'quit' or 'exit' to stop.");

 
    while (!interrupted) {
      let message: string;

      await askForInput(terminal)
        .then( handleUserInput )
        .then( displayAnswer)
        .catch( error=> log.error("Chatbot", "I couldn't get an answer. Please try again.", error) ) ;
    }
  } finally {
    terminal.close();
    log.info("Chatbot", "Goodbye.");
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  log.error("App", "Chatbot stopped unexpectedly.", error);
  process.exit(1);
});