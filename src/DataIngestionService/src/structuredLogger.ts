import { format } from "node:util";
import { currentRequestContext } from "./requestContext.js";

export function installStructuredConsole(): void {
  const output = console as unknown as Record<
    string,
    (...values: unknown[]) => void
  >;
  const methods = ["debug", "info", "log", "warn", "error"] as const;

  for (const method of methods) {
    output[method] = (...values: unknown[]) => {
      const line = `${formatStructuredLog(method, values)}\n`;
      (method === "warn" || method === "error"
        ? process.stderr
        : process.stdout
      ).write(line);
    };
  }
}

export function formatStructuredLog(
  method: "debug" | "info" | "log" | "warn" | "error",
  values: unknown[],
  timestamp = new Date().toISOString(),
): string {
  const context = currentRequestContext();
  const record: Record<string, unknown> = {
    timestamp,
    level: method === "log" ? "info" : method,
  };
  if (context) {
    Object.assign(record, context);
    record.accountId = context.accountId ?? "unknown";
    record.sourceId = context.sourceId ?? "unknown";
  }
  record.message = format(...values);
  return JSON.stringify(record);
}
