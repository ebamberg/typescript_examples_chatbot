import { Interface } from 'readline/promises';
import { log } from '../logger';

export async function askForInput(terminal: Interface): Promise<string> {
  return terminal.question('\nYou> ');
}

export function displayAnswer(answer: string): void {
  log.success('Chatbot', answer);
}