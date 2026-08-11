import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

try {
  // Node nativo (>=20.6), sem dependencia nova: expoe .env em process.env
  // para os testes (ex.: DATABASE_URL). Opcional — em CI as variaveis
  // costumam vir injetadas diretamente, sem arquivo .env no disco.
  process.loadEnvFile()
} catch {
  // .env ausente: segue sem ele.
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
