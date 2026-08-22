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
          // 15s, e nao os 5s padrao (21/08/2026). Nao e teste lento escondido
          // debaixo do tapete: um percurso completo do checkout — render da
          // arvore, `userEvent.type` tecla por tecla num CEP de oito digitos,
          // autofill e cotacao de frete — custa 1,7s a 2,8s SOZINHO em jsdom, e
          // esses numeros sao o piso do que a ferramenta consegue. Com 5s de
          // teto sobra menos de 2s de folga, e o runner roda treze arquivos em
          // paralelo: qualquer contencao de CPU derruba os mais pesados por
          // tempo, nao por defeito.
          //
          // A margem ja era estreita antes; a suite do wizard passou de 44 para
          // 52 testes com a validacao de campo e comecou a estourar em uma
          // rodada a cada duas nesta maquina. O CI roda em runner de 2 nucleos,
          // ou seja, MAIS disputado que aqui — mantendo 5s, o vermelho ia
          // aparecer la, intermitente, num teste que nao tem nada de errado.
          //
          // O numero e teto de PACIENCIA, nao meta de desempenho: teste que
          // passa a demorar 15s de verdade e teste quebrado, e continua
          // falhando.
          testTimeout: 15000,
        },
      },
    ],
  },
})
