import { formatNetworkError } from "./http.js";

function formatCliError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message || "Error";
    // Already enriched by httpFetch / BinaryUpdateError
    if (
      message.includes("Hint:") ||
      message.includes("←") ||
      message.includes("Previous CPA") ||
      message.includes("Also failed")
    ) {
      return message;
    }
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
