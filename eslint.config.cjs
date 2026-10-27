const js = require('@eslint/js');
const typescript = require('@typescript-eslint/eslint-plugin');

module.exports = [
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...typescript.configs['flat/recommended'],
  {
    files: ['src/**/*.ts'],
    languageOptions: { ecmaVersion: 2018, sourceType: 'module' },
    rules: {
      quotes: ['warn', 'single'],
      indent: 'off',
      semi: 'off',
      'comma-dangle': ['warn', 'always-multiline'],
      'dot-notation': 'off',
      eqeqeq: 'warn',
      curly: ['warn', 'all'],
      'brace-style': 'warn',
      'prefer-arrow-callback': 'warn',
      'max-len': ['warn', 140],
      'no-console': 'warn',
      'no-non-null-assertion': 'off',
      'comma-spacing': 'error',
      'no-multi-spaces': 'off',
      'no-trailing-spaces': 'warn',
      // Preserve intentional error sanitization for hub credentials and tokens.
      'preserve-caught-error': 'off',
      'lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
