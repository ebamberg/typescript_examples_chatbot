import { initOpenTelemetry, shutdownOpenTelemetry, withTrace } from './observability/otel';
import {SimpleResponse} from './model';
import { readFileSync} from 'fs';
import { createInterface } from 'readline/promises';
import { askForInput, displayAnswerAsSpeech } from './chatinterface/chatinterface';
import { history, initialize_history } from './chathistory/chathistory';
import { call_llm, LLMResponse } from './openrouter';
import { ToolDefinition } from './tools/tools';
import { current_date_time } from './tools/standard_tools';
import { log } from './logger';

const systemPrompt = readFileSync('src/prompts/system_prompt.md', 'utf8');
const llm_execute = withTrace("chatbot llm", call_llm<SimpleResponse>);
const tools: ToolDefinition[] = [current_date_time];
let interrupted =false;

const handleUserInput = (message: string) : LLMResponse<SimpleResponse>=> {
          const normalizedMessage = message.trim();
          if (["quit", "exit"].includes(normalizedMessage.toLowerCase())) {
            interrupted=true;
            return { parsed: { answer: "bye bye" }, plannedToolExecutions: []}; 
          } else {
            return llm_execute(history, normalizedMessage, "SimpleResponse", tools);
          }
          
      };

const waitForASyncToolExecutions = async ( response: LLMResponse<SimpleResponse> ) : Promise<LLMResponse<SimpleResponse>> => {
  const executions= response.plannedToolExecutions as Array<Promise<void>>;
  Promise.allSettled(executions)
    .then(() => log.info("Chatbot", "All planned tool executions completed."))
    .catch((error) => log.error("Chatbot", "Error during tool execution.", error));
  return response;
};

const outputAnswer = async (response: LLMResponse<SimpleResponse>) : Promise<LLMResponse<SimpleResponse>> => {
  displayAnswerAsSpeech(response.parsed);
  return response;
}



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
        .then( outputAnswer )
        .then( waitForASyncToolExecutions )
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

