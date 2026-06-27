// Flat ESLint config for the Jarvis TypeScript harness.
// Type-aware linting via typescript-eslint's projectService so rules like
// no-floating-promises and no-misused-promises work. tsc (npm run typecheck)
// still owns type errors; eslint owns lint-class issues (unused vars, floating
// promises, explicit any, import hygiene).

import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.mjs', '*.config.js', '**/.ion-build/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with underscore
      // (matches the _ctx / _info convention used throughout the hooks).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // "Untyped external data tax." This harness parses a lot of untyped JSON
      // (LLM output, webhook bodies, Record<string, unknown> config) where the
      // value is known-by-contract to be a string/number but typed as unknown.
      // The unsafe-* / base-to-string family flags every such access and is not
      // actionable without typing every external boundary (a separate effort).
      // Turned off so lint stays signal-rich; tsc still guards real type errors.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Many async fns exist to satisfy an interface/callback signature without
      // awaiting; low signal, high count. unbound-method is frequently a false
      // positive against this codebase's handler-passing patterns.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Test files: relax strictness around mocks/fixtures. The Function-typed
    // handler-extraction helpers and dynamic require()-for-module-reset are
    // standard vitest scaffolding idioms, not production code smells.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
    },
  },
)
