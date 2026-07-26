import { formatNetworkError, NetworkError } from "./http.js";
import { BinaryUpdateError } from "./update/binary.js";

export function formatCliError(err: unknown): string {
  // Messages of these types are already user-ready (enriched / suffixed).
  if (err instanceof BinaryUpdateError) return err.message;
  if (err instanceof NetworkError) return err.message;
  if (err instanceof Error) {
    const message = err.message || "Error";
    if (err.cause != null || /fetch failed|network|ECONN|ETIMEDOUT|UND_ERR/i.test(message)) {
      return formatNetworkError(err);
    }
    return message;
  }
  return String(err);
}

/** Wrap async CLI actions so users see a short message (stack only with DEBUG=1). */
export function withCliErrors<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(formatCliError(err));
      if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
        if (err instanceof Error && err.stack) console.error(err.stack);
      }
      process.exitCode = 1;
    }
  };
}
