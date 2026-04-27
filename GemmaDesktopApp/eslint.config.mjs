import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

const typedRules = {
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/ban-ts-comment": [
    "error",
    {
      "ts-check": false,
      "ts-expect-error": "allow-with-description",
      "ts-ignore": true,
      "ts-nocheck": true,
      minimumDescriptionLength: 6,
    },
  ],
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      fixStyle: "separate-type-imports",
      prefer: "type-imports",
    },
  ],
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/no-redundant-type-constituents": "off",
  "@typescript-eslint/no-unnecessary-type-assertion": "off",
  "@typescript-eslint/require-await": "off",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      destructuredArrayIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "no-debugger": "error",
  "no-control-regex": "off",
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "dist/**",
      "coverage/**",
      "package-lock.json",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/main/**/*.ts", "src/preload/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.node.json",
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      ...typedRules,
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["src/shared/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.node.json",
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      ...typedRules,
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      ...typedRules,
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["electron.vite.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.vite.json",
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      ...typedRules,
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        project: "./tsconfig.web.json",
        tsconfigRootDir: rootDir,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...typedRules,
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
    },
  },
);
