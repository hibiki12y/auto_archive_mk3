// ESLint flat config (ESLint 9+/10 + typescript-eslint v8)
//
// 정책 요약:
// - src/ 와 tests/ 는 type-checked recommended 룰 적용
// - scripts/*.mjs 는 일반 JS recommended 만 적용 (type-checking 비활성)
// - dist/, node_modules/, resource/ (submodules), documents/references/ 는 제외
// - 회귀 게이트 룰(any 사용, ts-ignore, floating promise 등)은 src 에서 error
// - 스타일/페던틱 룰(non-null !, require-await, unbound-method 등)은 warn 으로
//   완화. 코드베이스가 의도적으로 사용하는 경우가 많고, 일괄 변경은 회귀 위험.
// - 테스트 파일은 mock/스텁 패턴이 많아 더 관대한 룰 적용.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 1. 전역 무시 패턴
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'resource/**',
      'documents/references/**',
      'backups/**',
      'runtime-state/**',
      'results/**',
      'temp/**',          // 일회성 평가 산출물 (live-eval 결과)
      'traits/**',        // 외부 trait module 산출물
      '.venv/**',
      '.pytest_cache/**',
      '.claude/**',
      '.codex/**',
      '.github/**',
      'coverage/**',
      'scripts/dev/**',
    ],
  },

  // 2. JS recommended (모든 파일)
  eslint.configs.recommended,

  // 3. TS source — type-checked rules
  ...tseslint.configs.recommendedTypeChecked.map((conf) => ({
    ...conf,
    files: ['src/**/*.ts', 'tests/**/*.ts'],
  })),
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        // Node 20+ globals — Node.js 빌트인을 별도 import 없이 사용
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      // === 회귀 게이트 (error) ===
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-expect-error': 'allow-with-description',
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-check': false,
        minimumDescriptionLength: 5,
      }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { arguments: false, attributes: false },
      }],
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
        // 인라인 import() 타입 표기는 허용. 일부 모듈이 cycle 회피를 위해
        // 의도적으로 inline import() 타입을 사용한다.
        disallowTypeAnnotations: false,
      }],
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: true,
        allowAny: false,
        // 도메인 코드의 방어적 fall-through (never narrowing) 와 옵셔널
        // 인터폴레이션 패턴은 의도적이므로 허용
        allowNullish: true,
        allowNever: true,
      }],

      // === 미사용 변수 (error, 언더스코어 prefix 는 의도적 무시로 허용) ===
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],

      // === 코드베이스의 기존 패턴 — warn 으로 가시화하되 게이트는 아님 ===
      // 코드베이스가 의도적으로 ! 를 사용하는 곳이 많음. 일괄 강제는 회귀 위험.
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // 일부 테스트 더블/도메인 코드에서 의도적 redundant 단언이 readability 목적
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      // unbound method 는 의존성 주입 패턴에서 자연스럽게 발생
      '@typescript-eslint/unbound-method': 'warn',
      // require-await 는 인터페이스 매칭을 위해 의도적으로 async 시그니처를 두는 경우
      '@typescript-eslint/require-await': 'warn',

      // === unsafe 룰들 — boundary 지점에서 자연스럽게 발생, warn 으로 ===
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // === 실용적 완화 ===
      '@typescript-eslint/no-unused-expressions': ['error', {
        allowShortCircuit: true,
        allowTernary: true,
        allowTaggedTemplates: true,
      }],
    },
  },

  // 4. Test files — mock/스텁 패턴 허용
  {
    files: ['tests/**/*.ts', 'src/**/__test__/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      // 테스트 mock async 메서드는 await 없이 사용되는 것이 정상
      '@typescript-eslint/require-await': 'off',
      // 테스트는 메서드 참조를 그대로 넘기는 경우가 많음
      '@typescript-eslint/unbound-method': 'off',
      // 테스트 더블에서는 unsafe 패턴이 자연스러움
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // 테스트는 type assertion 으로 정확한 narrow 가 필요한 경우가 많음
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // 테스트 import 형식은 강제하지 않음 (vitest 글로벌과 혼합)
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },

  // 5. Tests fixtures — 임의 데이터/스켈레톤 허용
  {
    files: ['tests/fixtures/**/*'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // 6. scripts/*.mjs — Node ESM 스크립트, type-checking 미적용
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        fetch: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `while (true) { ... break; }` 는 Node 헬퍼 스크립트에서 합법적으로 사용
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
);
