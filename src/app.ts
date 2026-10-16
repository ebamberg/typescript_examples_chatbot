import { initOpenTelemetry, shutdownOpenTelemetry, withTrace } from './observability/otel';
import {SimpleResponse} from './model';
import { readFileSync} from 'fs';
import { createInterface, Interface } from 'readline/promises';
import { askForInput, displayAnswerAsSpeech } from './chatinterface/chatinterface';
import { history, initialize_history, add_to_history, with_history_lock } from './chathistory/chathistory';
import { call_llm, LLMResponse } from './openrouter';
import { ToolDefinition } from './tools/tools';
import { current_date_time } from './tools/standard_tools';
import { log } from './logger';
import { ChatMessages } from '@openrouter/sdk/models';

const systemPrompt = readFileSync('src/prompts/system_prompt.md', 'utf8');
const llm_execute = withTrace("chatbot llm", call_llm<SimpleResponse>);
const tools: ToolDefinition[] = [current_date_time];
let interrupted =false;
let outstandingToolExecutionResult=false;

const handleUserInput = (message: string) : LLMResponse<SimpleResponse> => {
        log.info("Chatbot", "No outstanding tool execution results. Processing user input.");
        const normalizedMessage = message.trim();
        if (["quit", "exit"].includes(normalizedMessage.toLowerCase())) {
          interrupted=true;
          return { parsed: { answer: "bye bye" }, plannedToolExecutions: []}; 
        } else {
          return llm_execute(history, normalizedMessage, "SimpleResponse", tools);
        }  
      };

const collectAsyncToolExecutions = async ( response: LLMResponse<SimpleResponse> ): Promise<void> => {

  const isRejected = (input: PromiseSettledResult<unknown>): input is PromiseRejectedResult => 
    input.status === 'rejected'

  const isFulfilled = <T>(input: PromiseSettledResult<T>): input is PromiseFulfilledResult<T> => 
    input.status === 'fulfilled'

  try {
    const executions= response.plannedToolExecutions as Array<Promise<void>>;
    if (executions.length === 0) {
      log.info("Chatbot", "No planned tool executions to wait for.");
      return;
    } else {
      log.info("Chatbot", `Continuing the conversation while ${executions.length} tool execution(s) run in the background...`);
    
      const results = await Promise.allSettled(executions);
      const rejectedResults = results.filter(isRejected);
      const fulfilledResults = results.filter(isFulfilled);
      rejectedResults.forEach((result) => {
        log.error("Chatbot", "A background tool execution failed.", result.reason);
      });

      await with_history_lock(history, async () => {
        fulfilledResults.forEach((result, index) => {
          log.info("Chatbot", `Tool execution ${index + 1} completed successfully.`);
          const toolResponse = result.value as unknown as ChatMessages;
          add_to_history(toolResponse, history);
        });
      });

      if (fulfilledResults.length > 0) {
        outstandingToolExecutionResult = true;
        log.info("Chatbot", "Completed tool results are available in the chat history.");
      }
    }
  } catch (error) {
    log.error("Chatbot", "Error occurred while waiting for tool executions.", error);
  }
};

const outputAnswer = async (response: LLMResponse<SimpleResponse>) : Promise<LLMResponse<SimpleResponse>> => {
  displayAnswerAsSpeech(response.parsed);
  return response;
}
const receiveNextMessage = async(terminal: Interface): Promise<string> =>{
  if (outstandingToolExecutionResult) {
    log.info("Chatbot", "Outstanding tool execution results are available. Processing them first.");
    outstandingToolExecutionResult = false;
    return 'TOOL_RESULTS_AVAILABLE';
  } else {
    return askForInput(terminal);
  }
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


      await receiveNextMessage(terminal)
        .then( handleUserInput )
        .then( outputAnswer )
        .then((response) => {
          void collectAsyncToolExecutions(response);
        })
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

