import { Interface } from 'readline/promises';
import { log } from '../logger';
import { SimpleResponse } from '../model';

export async function askForInput(terminal: Interface): Promise<string> {
  return terminal.question('\nYou> ');
}

export function displayAnswer(response: SimpleResponse): void {
  log.success('Chatbot', response.answer);
}