// Lint the extension sources and the tests with no build step and no bundler assumptions.
//
// The product files are classic scripts: content scripts, the service worker (which uses
// importScripts), and the side panel, all sharing the globals declared in shared.js,
// config-file.js and drive.js. They are therefore parsed as scripts with browser + service-worker
// globals, not as ES modules, so `no-undef` keeps working across the script boundaries.
const js = require('@eslint/js');
const globals = require('globals');

/** Globals the extension itself creates in shared.js, config-file.js and drive.js. */
const YOUSUB_GLOBALS = {
  YOUSUB: 'readonly',
  YousubConfigFile: 'readonly',
  Drive: 'readonly'
};

const RULES = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' }],
  // The scripts lean on empty catch blocks to ignore storage and page-internals failures.
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'smart'],
  // YOUSUB/Drive/YousubConfigFile are declared with `var` in their own file and configured as
  // globals for the other files; the declaration matching the global is intended.
  'no-redeclare': ['error', { builtinGlobals: false }],
  'no-console': 'off',
  // Declarations are deliberately `var` in the files shared between worlds (they are re-evaluated
  // in each world), so the rule is not useful here.
  'no-var': 'off'
};

module.exports = [
  {
    ignores: ['node_modules/**', 'debian/**', 'icons/**']
  },

  js.configs.recommended,

  // The extension itself: service worker, content scripts, side panel.
  {
    files: ['background.js', 'shared.js', 'drive.js', 'config-file.js', 'diagnostics.js',
      'content/**/*.js', 'popup/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly', ...YOUSUB_GLOBALS }
    },
    rules: RULES
  },

  // Test runner scripts (CommonJS) and this config file.
  {
    files: ['tests/**/*.cjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: RULES
  }
];
