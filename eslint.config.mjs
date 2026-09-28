// @ts-check
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // Module boundaries inside packages/core: other modules may only import a module's public-api.ts.
    files: ['packages/core/src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { project: 'packages/core/tsconfig.json' }, node: true },
      'boundaries/include': ['packages/core/src/**/*'],
      'boundaries/elements': [{ type: 'module', pattern: 'packages/core/src/modules/*', capture: ['name'] }],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          // The last matching policy wins.
          policies: [
            {
              // Importing a module's internals (anything but its public-api.ts) is forbidden ...
              from: { element: { type: 'module' } },
              disallow: { to: { element: { type: 'module', fileInternalPath: '!public-api.ts' } } },
            },
            {
              // ... except from inside the same module.
              from: { element: { type: 'module' } },
              allow: { dependency: { relationship: { to: 'internal' } } },
            },
          ],
        },
      ],
    },
  },
  {
    // CLIs print to stdout by design.
    files: ['**/src/cli.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Only the inventory module's infrastructure may write stock tables (docs/04-inventory.md §2).
    files: ['**/*.ts'],
    ignores: ['packages/core/src/modules/inventory/infrastructure/**', 'tests/**', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TemplateElement[value.raw=/\\b(update|insert\\s+into|delete\\s+from)\\s+inventory_(balances|transactions)\\b/i]',
          message: 'Stock may only change through InventoryEngine (modules/inventory).',
        },
      ],
    },
  },
);
