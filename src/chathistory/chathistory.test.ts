import { beforeEach, describe, expect, it } from 'vitest';
import { ChatMessages } from '@openrouter/sdk/models';
import { add_to_history, history, initialize_history, with_history_lock } from './chathistory';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise();
  });
  return { promise, resolve };
}

describe('chat history', () => {
  beforeEach(() => {
    initialize_history('test system prompt');
  });

  it('initializes and replaces the global history while preserving its array identity', () => {
    const sharedHistory = history;
    add_to_history({ role: 'user', content: 'old message' });

    initialize_history('updated system prompt');

    expect(history).toBe(sharedHistory);
    expect(history).toEqual([{ role: 'system', content: 'updated system prompt' }]);
  });

  it('appends messages to the global history or a specified history', () => {
    const taskHistory: ChatMessages[] = [{ role: 'system', content: 'task prompt' }];
    const globalMessage: ChatMessages = { role: 'user', content: 'global message' };
    const taskMessage: ChatMessages = { role: 'user', content: 'task message' };

    add_to_history(globalMessage);
    add_to_history(taskMessage, taskHistory);

    expect(history).toEqual([
      { role: 'system', content: 'test system prompt' },
      globalMessage,
    ]);
    expect(taskHistory).toEqual([
      { role: 'system', content: 'task prompt' },
      taskMessage,
    ]);
  });

  it('serializes operations that share the same history', async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];

    const firstTask = with_history_lock(history, async () => {
      events.push('first:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push('first:end');
    });
    await firstStarted.promise;

    const secondTask = with_history_lock(history, async () => {
      events.push('second:start');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst.resolve();
    await Promise.all([firstTask, secondTask]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('allows operations on separate histories to run concurrently', async () => {
    const firstHistory: ChatMessages[] = [{ role: 'system', content: 'first task' }];
    const secondHistory: ChatMessages[] = [{ role: 'system', content: 'second task' }];
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondStarted = createDeferred();

    const firstTask = with_history_lock(firstHistory, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    const secondTask = with_history_lock(secondHistory, async () => {
      secondStarted.resolve();
    });

    await secondStarted.promise;
    releaseFirst.resolve();
    await Promise.all([firstTask, secondTask]);
  });

  it('releases the history lock when an operation fails', async () => {
    await expect(with_history_lock(history, async () => {
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');

    await expect(with_history_lock(history, async () => 'completed')).resolves.toBe('completed');
  });
});