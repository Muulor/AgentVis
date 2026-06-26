module.exports = {
    root: true,
    env: { browser: true, es2020: true },
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/strict-type-checked',
        'plugin:@typescript-eslint/stylistic-type-checked',
        'plugin:react-hooks/recommended',
    ],
    ignorePatterns: ['dist', 'coverage', 'website', '.eslintrc.cjs', 'src-tauri'],
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: __dirname,
    },
    plugins: ['react-refresh', '@typescript-eslint'],
    rules: {
        // React Refresh
        'react-refresh/only-export-components': [
            'warn',
            { allowConstantExport: true },
        ],
        // TypeScript 严格规则
        '@typescript-eslint/no-unused-vars': [
            'error',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/no-confusing-void-expression': 'off',
        // 禁止 any
        '@typescript-eslint/no-explicit-any': 'error',
        // 要求使用 interface 而非 type（除非必要）
        '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
        // Keep template strings strict for unsafe/nullish values, but allow common primitives.
        '@typescript-eslint/restrict-template-expressions': [
            'error',
            {
                allowNumber: true,
                allowBoolean: true,
                allowRegExp: true,
                allowAny: false,
                allowNullish: false,
            },
        ],
        '@typescript-eslint/no-misused-promises': [
            'error',
            {
                checksVoidReturn: {
                    attributes: false,
                },
            },
        ],
        // Style-only rules are handled later in scoped cleanup passes.
        '@typescript-eslint/array-type': 'off',
        '@typescript-eslint/prefer-regexp-exec': 'off',
        '@typescript-eslint/dot-notation': 'off',
        '@typescript-eslint/no-inferrable-types': 'off',
        '@typescript-eslint/consistent-generic-constructors': 'off',
    },
    overrides: [
        {
            files: [
                '**/__tests__/**/*.{ts,tsx}',
                '**/*.{test,spec}.{ts,tsx}',
            ],
            rules: {
                // Tests use mocks, fixtures, and call assertions that are noisier than production code.
                '@typescript-eslint/no-non-null-assertion': 'off',
                '@typescript-eslint/no-explicit-any': 'off',
                '@typescript-eslint/no-unsafe-assignment': 'off',
                '@typescript-eslint/no-unsafe-member-access': 'off',
                '@typescript-eslint/no-unsafe-call': 'off',
                '@typescript-eslint/no-unsafe-return': 'off',
                '@typescript-eslint/unbound-method': 'off',
                '@typescript-eslint/require-await': 'off',
                '@typescript-eslint/no-deprecated': 'off',
                '@typescript-eslint/no-empty-function': 'off',
                'no-useless-escape': 'off',
            },
        },
    ],
};
