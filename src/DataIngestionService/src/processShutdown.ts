/** The deployment sends SIGTERM; this deadline includes draining and SDK cleanup. */
export function createProcessShutdown(service: string) {
  const setting = `${service.toUpperCase().replace(/-/g, "_")}_SHUTDOWN_TIMEOUT_MS`;
  const timeoutMs = Number(process.env[setting] ?? process.env.PROCESS_SHUTDOWN_TIMEOUT_MS ?? 300_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000)
    throw new Error(`${setting} / PROCESS_SHUTDOWN_TIMEOUT_MS must be an integer from 1000 to 3600000`);
  let started = false;
  let exited = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    process.exit(code);
  };
  return {
    begin(signal: string): boolean {
      if (started) return false;
      started = true;
      console.info(`${service} received ${signal}; shutdown deadline ${timeoutMs} ms`);
      // Keep this timer referenced: even an unresolved drain with no handles
      // must remain owned until we exit explicitly or reach the deadline.
      deadline = setTimeout(() => {
        console.error(`${service} shutdown deadline exceeded; forcing process exit`);
        exit(1);
      }, timeoutMs);
      return true;
    },
    finish(code = Number(process.exitCode ?? 0)): void { exit(code); },
  };
}
