import { ChatMessages } from '@openrouter/sdk/models';

export const history: ChatMessages[] = [];

const historyLocks = new WeakMap<ChatMessages[], Promise<void>>();

export function initialize_history(systemPrompt: string): void {
  history.splice(0, history.length, { role: 'system', content: systemPrompt });
}

export function add_to_history(message: ChatMessages, targetHistory: ChatMessages[] = history): void {
  targetHistory.push(message);
}

export async function with_history_lock<Type>(targetHistory: ChatMessages[], operation: () => Promise<Type>): Promise<Type> {
  const previousLock = historyLocks.get(targetHistory) ?? Promise.resolve();
  let releaseLock!: () => void;
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  historyLocks.set(targetHistory, currentLock);
  await previousLock;

  try {
    return await operation();
  } finally {
    releaseLock();
    if (historyLocks.get(targetHistory) === currentLock) {
      historyLocks.delete(targetHistory);
    }
  }
}