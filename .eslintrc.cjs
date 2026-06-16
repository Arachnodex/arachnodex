// .eslintrc.cjs
module.exports = {
    root: true,
    env: { node: true, es2021: true },
    parser: '@typescript-eslint/parser',
    parserOptions: {
        project: [
            './packages/bot-protection-heuristics/tsconfig.json',
            './packages/core/tsconfig.json',
            './packages/create/tsconfig.json',
            './packages/job-link-issues/tsconfig.json',
            './packages/job-nfa-report/tsconfig.json',
            './packages/job-sitemap/tsconfig.json'
        ],
        tsconfigRootDir: __dirname, // <<< absolute path
        sourceType: 'module'
    },
    plugins: ['@typescript-eslint'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:@typescript-eslint/recommended-type-checked'
    ],
    rules: {
        '@typescript-eslint/strict-boolean-expressions': [
            'error',
            { allowString: false, allowNumber: false }
        ],
        '@typescript-eslint/no-unused-vars': [
            'error',
            { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
        ],
        '@typescript-eslint/consistent-type-imports': [
            'warn',
            { prefer: 'type-imports', disallowTypeAnnotations: false }
        ]
    },
    ignorePatterns: [
        '**/*.d.ts',
        'node_modules/',
        '**/node_modules/',
        'dist/',
        'bin/',
        '**/bin/',
        'src/**/*.test.ts',
        'src/frontend/generated/*'
    ]
};
