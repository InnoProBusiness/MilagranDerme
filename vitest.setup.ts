// Estende o `expect` do Vitest com os matchers do jest-dom (toHaveTextContent,
// toBeInTheDocument, etc.) para o projeto jsdom. So os testes de componente
// (*.test.tsx) carregam este arquivo — os testes de banco (*.test.ts, projeto
// node) nao precisam de DOM nenhum.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// @testing-library/react so registra cleanup automatico no afterEach quando
// detecta `afterEach` como global — e este projeto importa `afterEach`
// explicitamente de 'vitest' em vez de usar test.globals. Sem esta linha, o
// DOM de um teste vaza para o proximo dentro do mesmo arquivo (varios
// render() acumulam no mesmo document.body), e getByRole/getByText passam a
// encontrar elementos duplicados de renders anteriores.
afterEach(() => {
  cleanup()
})
