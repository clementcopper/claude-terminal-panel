import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '*.vsix',
      'media/**/*.js',
      // Written by Claude Code at every load of the mod; not ours to lint
      'resources/mods/**/.claude-plugin/**'
    ]
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript files configuration
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // VS Code extension specific rules
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Allow require() for node-pty dynamic import
      '@typescript-eslint/no-require-imports': 'off',

      // Relax some strict rules for pragmatic development
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },

  // Media/webview TypeScript configuration
  {
    files: ['media/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: './media/tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },

  // resources/mods/: hooks modules Claude Code loads as TypeScript. Type-aware rules would need
  // the declarations the engine writes into the mod folder at first load, which a fresh clone
  // lacks — so syntax-level rules only here; `npm run typecheck:mod` does the typed half.
  {
    files: ['resources/mods/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  },

  // resources/: shipped scripts that Claude Code runs. scripts/: build tooling, not packaged.
  // Both are plain CommonJS on the Node globals.
  {
    files: ['resources/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    }
  },

  // Prettier compatibility (must be last)
  eslintConfigPrettier
);
