export class BinaryUpdateError extends Error {
  readonly previousRestarted: boolean;
  readonly previousRestored: boolean;
  readonly causeMessage: string;

  constructor(
    causeMessage: string,
    previousRestarted: boolean,
    recovery?: { previousRestored?: boolean; previousAvailable?: boolean },
  ) {
    const previousRestored = recovery?.previousRestored === true;
    let suffix: string;
    if (previousRestarted) {
      suffix = previousRestored
        ? "\nThe previous CLIProxyAPI version was restored and restarted."
        : "\nThe existing CLIProxyAPI version was restarted.";
    } else if (recovery?.previousAvailable === false) {
      suffix = "\nNo previous CLIProxyAPI executable could be restored. Run: cpa update";
    } else {
      suffix = previousRestored
        ? "\nThe previous CLIProxyAPI version was restored but could not be restarted. Run: cpa start"
        : "\nThe existing CLIProxyAPI version could not be restarted. Run: cpa start";
    }
    super(`${causeMessage}${suffix}`);
    this.name = "BinaryUpdateError";
    this.causeMessage = causeMessage;
    this.previousRestarted = previousRestarted;
    this.previousRestored = previousRestored;
  }
}
