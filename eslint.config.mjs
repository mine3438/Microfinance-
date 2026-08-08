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

/** Never reachable from the API layer, however the request arrived. */
const API_FORBIDDEN = [
  {
    group: ['decimal.js'],
    message:
      'Money arithmetic belongs in @mfi/money and the rules that use it in @mfi/domain. ' +
      'An amount computed in a controller is a second implementation of a calculation that ' +
      'must have exactly one (analysis R2).',
  },
  {
    group: ['@node-rs/argon2', 'argon2', 'bcrypt', 'bcryptjs'],
    message:
      'Password hashing belongs in @mfi/identity, which fixes the argon2id parameters in one ' +
      'place. Hashing here would let a second, weaker cost setting exist.',
  },
];

/** Constructing these belongs to the composition root alone. */
const INFRASTRUCTURE_CONSTRUCTION = [
  {
    group: ['ioredis'],
    allowTypeImports: true,
    message:
      'Construct the Redis client in composition.ts and pass it in. A module that builds its ' +
      'own connection cannot be given a different one by a test.',
  },
  {
    group: ['pg'],
    allowTypeImports: true,
    message:
      'Use the Database from @mfi/db, which enforces the tenant transaction boundary. A pool ' +
      'built here would bypass it.',
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

  // ── Layer: api ────────────────────────────────────────────────────────────
  // The interface layer. It may reach for a framework and a driver — that is
  // what it is for — but the direction of dependency still only points inward,
  // and the one thing it must not become is a second place business rules live.
  //
  // The typescript-eslint variant throughout, for `allowTypeImports`: these
  // rules are about *constructing* things, and a type-only import constructs
  // nothing. A module that names `Redis` to type a parameter it is handed is
  // obeying the rule, not breaking it.
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: API_FORBIDDEN }],
    },
  },

  // ── Composition root ──────────────────────────────────────────────────────
  // The one file permitted to construct concrete infrastructure. Everything
  // else receives what it needs as an argument, which is what makes a wiring
  // mistake a type error at the line that would have supplied it rather than a
  // runtime failure when a module loads (01-ARCHITECTURE.md §17.1).
  //
  // The pattern list is composed rather than replaced. ESLint overrides a rule's
  // options wholesale, so a block that listed only the extra patterns would
  // silently switch the ones above back off for every file it matched.
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/composition.ts', 'apps/api/src/main.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [...API_FORBIDDEN, ...INFRASTRUCTURE_CONSTRUCTION] },
      ],
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

  // ── Build and data-generation scripts ─────────────────────────────────────
  // Plain Node ESM, outside any package tsconfig, so the Node globals they use
  // have to be declared rather than inferred from types.
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
]);
