import { Interface } from 'readline/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { log } from '../logger';
import { SimpleResponse } from '../model';
import { client } from '../openrouter';

export async function askForInput(terminal: Interface): Promise<string> {
  return terminal.question('\nYou> ');
}

export function displayAnswer(response: SimpleResponse): void {
  log.success('Chatbot', response.answer);
}

let speechQueue: Promise<void> = Promise.resolve();

export function displayAnswerAsSpeech(response: SimpleResponse): Promise<void> {
  const playback = speechQueue.then(() => playAnswerAsSpeech(response));
  speechQueue = playback.catch(() => {});
  return playback;
}

async function playAnswerAsSpeech(response: SimpleResponse): Promise<void> {
  const audio = await client.tts.createSpeech({
    speechRequest: {
      model: 'google/gemini-3.8-flash-lite-tts',
      input: response.answer,
      voice: 'Despina',
      responseFormat: 'pcm',
    },
  });

  const player = spawn('ffplay', [
    '-nodisp', '-autoexit', '-loglevel', 'error',
    '-f', 's16le', '-ar', '24000', '-ch_layout', 'mono', '-i', 'pipe:0',
  ], {
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  const playback = once(player, 'close').then(([code]) => {
    if (code !== 0) {
      throw new Error(`Audio playback failed (ffplay exited with code ${code ?? 'unknown'})`);
    }
  });

  try {
    await Promise.all([
      pipeline(Readable.fromWeb(audio as unknown as Parameters<typeof Readable.fromWeb>[0]), player.stdin),
      playback,
    ]);
 //   log.success('Chatbot', 'Audio answer played.');
  } catch (error) {
    player.kill();
    throw error;
  }
}

