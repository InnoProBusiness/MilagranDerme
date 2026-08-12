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

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) }

export default defineConfig({
  resolve: { alias },
  test: {
    // Dois projetos, um runner. Os testes de banco (repositorios, lib/*)
    // continuam em 'node' — mais rapido e mais proximo do runtime real de
    // producao. Os testes de componente (Task 8 em diante) precisam de DOM
    // para render() e userEvent, entao rodam em 'jsdom'. A extensao do
    // arquivo decide o projeto: .test.ts vai para node, .test.tsx vai para
    // jsdom. Nao existe overlap possivel entre os dois globs.
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/__tests__/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/**/__tests__/**/*.test.tsx'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
})
