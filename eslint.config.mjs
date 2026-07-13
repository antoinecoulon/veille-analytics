import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  // scripts/ = scripts de maintenance ponctuels (Node), hors code Worker déployé
  { ignores: ['.wrangler', 'node_modules', 'dist', 'scripts'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Code du Worker (src) : runtime Cloudflare Workers
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        ...globals.worker
      }
    },
    rules: {
      // Toléré au démarrage de la CI (JSON entrant, erreurs catch, résultats D1) ;
      // à durcir plus tard (Étape 10).
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
)
