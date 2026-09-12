/** Bounds the whole operation, including response bodies and non-abortable bindings. */
export async function withinDeadline<T>(
  operation: () => Promise<T>,
  milliseconds: number,
  timeoutError: () => Error,
  abort?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort?.(); reject(timeoutError()); }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
