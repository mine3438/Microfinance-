// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Architectural layering, enforced mechanically.
 *
 * `01-ARCHITECTURE.md` §4 states one rule: dependencies point inward only.
 * The domain declares interfaces, infrastructure implements them, and the
 * application depends on the interfaces rather than the implementations.
 *
 * A convention that only lives in a document decays. These `no-restricted-imports`
 * blocks turn each inward-only edge into a build failure, using nothing but core
 * ESLint so there is no plugin-compatibility surface to maintain.
 */

/** Runtime and framework packages that must never reach a pure layer. */
const FRAMEWORK_AND_IO = [
  { group: ['@nestjs/*'], message: 'Framework import. This layer must stay free of NestJS.' },
  { group: ['express', 'fastify'], message: 'HTTP server import is not permitted in this layer.' },
  {
    group: ['pg', 'pg-*', 'postgres', 'kysely', 'drizzle-orm', 'typeorm', 'prisma', '@prisma/*'],
    message: 'Database driver or ORM import is not permitted in this layer.',
  },
  {
    group: ['react', 'react-*', 'react-dom'],
    message: 'UI import is not permitted in this layer.',
  },
  { group: ['ioredis', 'redis'], message: 'Cache client import is not permitted in this layer.' },
  {
    group: [
      'node:fs',
      'node:fs/*',
      'node:net',
      'node:http',
      'node:https',
      'node:child_process',
      'fs',
      'net',
      'http',
      'https',
      'child_process',
    ],
    message: 'Node I/O import is not permitted in this layer. Declare a port instead.',
  },
];

export default defineConfig([
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'docs/reference/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tooling config files belong to no package tsconfig.
          allowDefaultProject: ['*.config.mjs', '*.config.ts', '*.config.mts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Correctness rules that matter more than usual when the code moves money.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // String-concatenated SQL is the injection vector named in the analysis (§10.5).
      // Parameterised queries only; a template literal containing SELECT/INSERT/etc. is a smell
      // that must be justified explicitly rather than written by habit.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'TemplateLiteral[expressions.length>0] > TemplateElement[value.raw=/\\b(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\\b/i]',
          message:
            'Interpolated SQL detected. Use parameterised queries ($1, $2) — never string interpolation.',
        },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // ── Layer: domain ─────────────────────────────────────────────────────────
  // Pure TypeScript. Entities, value objects, invariants, ports. Zero framework,
  // zero I/O. This is what makes the lending and provisioning rules unit-testable
  // without a database.
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_AND_IO,
            {
              group: ['@mfi/infrastructure', '@mfi/infrastructure/*'],
              message: 'The domain must not depend on infrastructure. Declare a port instead.',
            },
          ],
        },
      ],
    },
  },

  // ── Layer: money ──────────────────────────────────────────────────────────
  // The narrowest layer in the codebase: exact-decimal arithmetic and nothing else.
  {
    files: ['packages/money/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...FRAMEWORK_AND_IO,
            {
              group: ['@mfi/*'],
              message:
                'The money package is a leaf. It must not depend on any other workspace package.',
            },
          ],
        },
      ],
    },
  },

  // ── Layer: contracts ──────────────────────────────────────────────────────
  // Wire schemas shared by API and web. Must stay importable from a browser bundle.
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FRAMEWORK_AND_IO }],
    },
  },

  // ── Tests ─────────────────────────────────────────────────────────────────
  // Integration tests legitimately reach for drivers and the filesystem; that is
  // the point of them. Boundary rules do not apply, correctness rules still do.
  //
  // The interpolated-SQL rule is also off here: test fixtures build DDL from
  // generated schema names, which is not an injection surface — no test input
  // crosses a trust boundary. The rule stays on everywhere that ships.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // ── Config files ──────────────────────────────────────────────────────────
  // Flat-config and tooling files are plain ESM outside any package tsconfig,
  // so type-aware rules have no type information to work from.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['**/*.config.{ts,mts}'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
]);
