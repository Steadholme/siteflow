export interface PollUntilOptions<T> {
  read: () => Promise<T>;
  isDone: (value: T) => boolean;
  maxAttempts?: number;
  intervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface PollUntilResult<T> {
  value: T;
  attempts: number;
  done: boolean;
}

function waitFor(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

export async function pollUntil<T>({
  read,
  isDone,
  maxAttempts = 5,
  intervalMs = 1_000,
  wait = waitFor
}: PollUntilOptions<T>): Promise<PollUntilResult<T>> {
  let lastValue: T | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastValue = await read();

    if (isDone(lastValue)) {
      return { value: lastValue, attempts: attempt, done: true };
    }

    if (attempt < maxAttempts) {
      await wait(intervalMs);
    }
  }

  return { value: lastValue as T, attempts: maxAttempts, done: false };
}
