/** Wrap async CLI actions so users see a short message (stack only with DEBUG=1). */
export function withCliErrors<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
        if (err instanceof Error && err.stack) console.error(err.stack);
      }
      process.exitCode = 1;
    }
  };
}
