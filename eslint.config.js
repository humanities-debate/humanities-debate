import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'desktop-dist', 'release', 'release-chrome', 'release-siwc', 'release-siwc-speech', 'release-candidate', '.codex-smoke', '.codex-debate']),
  {
    files: ['desktop/chrome/*.js', 'desktop/chrome-siwc/*.js', 'desktop/chrome-recovery/*.js', 'experiments/siwc-8e/renderer.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['server/**/*.mjs', 'desktop/**/*.{mjs,cjs}', 'experiments/siwc-8e/*.{mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
