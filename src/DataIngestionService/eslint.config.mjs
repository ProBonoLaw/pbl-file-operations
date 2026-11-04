import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["dist/**", "coverage/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      // Existing code uses explicit any at provider and test boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "test/**/*.mjs", "eslint.config.mjs"],
    extends: [eslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
]);
