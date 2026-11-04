import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function loadAppSettings(): Promise<void> {
  const appSettingsPath = resolve(
    process.env.APPSETTINGS_FILE ?? "/mnt/keyvault/appsettings.json",
  );

  let contents: string;
  try {
    contents = await readFile(appSettingsPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  const settings: unknown = JSON.parse(contents);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("The appsettings file must contain a JSON object");
  }

  for (const [name, value] of Object.entries(settings)) {
    if (
      process.env[name] === undefined &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    ) {
      process.env[name] = String(value);
    }
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
