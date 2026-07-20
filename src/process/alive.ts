/** True if a process with this PID exists (including when signal is not permitted). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Process exists but we cannot signal it (different user / protected).
    if (code === "EPERM") return true;
    return false;
  }
}
