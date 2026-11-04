import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      // Vitest's external module loader drops Zod's named exports under Bun.
      // Transform it through Vite so schema validation matches direct service imports.
      deps: { inline: ["zod"] },
    },
  },
});
