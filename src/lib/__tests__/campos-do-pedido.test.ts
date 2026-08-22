import { describe, it, expect } from 'vitest'
import {
  ROTULO_DO_CAMPO,
  PASSO_DO_CAMPO,
  rotuloDoCampo,
  listarCampos,
  camposDoErroZod,
  mensagemDeCamposInvalidos,
} from '@/lib/campos-do-pedido'

/**
 * O TRADUTOR ENTRE A RECUSA DO SERVIDOR E O CAMPO NA TELA.
 *
 * O que este arquivo protege, em uma frase: um 422 de POST /api/pedidos nunca
 * mais pode chegar ao comprador como "confira os dados" de onze campos.
 *
 * O caso concreto que o originou (21/08/2026) veio de aparelhos iOS. A tela e o
 * servidor validam e-mail por regras diferentes — regex simples de um lado,
 * `z.string().email()` do outro — e existe uma faixa de enderecos que a primeira
 * aceita e o segundo recusa. `ana@gmail.com.`, com o ponto que o teclado
 * acrescenta, e o exemplo comum. O botao liberava, o POST saia, voltava 422 sem
 * uma palavra sobre onde estava o problema, e a pessoa relia quatro campos que,
 * pelas regras da tela, estavam certos. Nao havia saida.
 */
describe('campos do pedido', () => {
  describe('camposDoErroZod', () => {
    it('devolve o nome do campo de cada issue, sem repetir e na ordem', () => {
      const issues = [
        { path: ['whatsapp'] },
        { path: ['email'] },
        { path: ['email'] },
      ]
      expect(camposDoErroZod(issues)).toEqual(['whatsapp', 'email'])
    })

    /**
     * `.strict()` recusa campo desconhecido com `path` VAZIO — o defeito e do
     * corpo inteiro, nao de um campo. Sem este descarte, `String(undefined)`
     * produziria o campo "undefined" na frase que a compradora le.
     */
    it('ignora issue sem caminho, que e o do corpo inteiro', () => {
      expect(camposDoErroZod([{ path: [] }])).toEqual([])
      expect(camposDoErroZod([{ path: [] }, { path: ['cpf'] }])).toEqual(['cpf'])
    })

    it('ignora caminho que nao comeca por nome de campo', () => {
      expect(camposDoErroZod([{ path: [0] }, { path: [''] }])).toEqual([])
    })

    it('sem issue nenhum, lista vazia', () => {
      expect(camposDoErroZod([])).toEqual([])
    })
  })

  describe('mensagemDeCamposInvalidos', () => {
    it('nomeia o campo unico, com o rotulo da tela', () => {
      expect(mensagemDeCamposInvalidos(['email'])).toContain('E-mail')
      expect(mensagemDeCamposInvalidos(['email'])).toMatch(/^Confira o campo /)
    })

    it('nomeia varios campos com o "e" do portugues no fim', () => {
      const frase = mensagemDeCamposInvalidos(['nome', 'email', 'whatsapp'])
      expect(frase).toContain('Nome completo, E-mail e WhatsApp')
      expect(frase).toMatch(/^Confira os campos /)
    })

    /**
     * `idServico` e `tipoEntrega` sao preenchidos pela propria tela. Nomea-los
     * mandaria a compradora procurar um campo que nao existe no formulario — o
     * unico desfecho honesto ali e recarregar a pagina.
     */
    it('campo que a compradora nao preenche nao vira instrucao de conferir', () => {
      const frase = mensagemDeCamposInvalidos(['idServico', 'tipoEntrega'])
      expect(frase).not.toContain('idServico')
      expect(frase).not.toContain('tipoEntrega')
      expect(frase).toMatch(/atualize a página/i)
    })

    it('sem campo nenhum, manda recomecar em vez de mandar conferir o nada', () => {
      expect(mensagemDeCamposInvalidos([])).toMatch(/atualize a página/i)
    })

    /**
     * A frase e lida por quem esta comprando: se ela citar um nome de campo do
     * codigo, a pessoa procura na tela e nao acha.
     */
    it('toda frase usa apenas rotulos que existem na tela', () => {
      const frase = mensagemDeCamposInvalidos(Object.keys(ROTULO_DO_CAMPO))
      for (const campo of Object.keys(ROTULO_DO_CAMPO)) {
        expect(frase).toContain(ROTULO_DO_CAMPO[campo])
      }
    })
  })

  describe('listarCampos', () => {
    it('une a lista do jeito que se le em voz alta', () => {
      expect(listarCampos([])).toBe('')
      expect(listarCampos(['A'])).toBe('A')
      expect(listarCampos(['A', 'B'])).toBe('A e B')
      expect(listarCampos(['A', 'B', 'C'])).toBe('A, B e C')
    })
  })

  describe('o mapa de passos', () => {
    /**
     * O CONTRATO QUE FAZ A TELA FUNCIONAR: todo campo que tem passo precisa ter
     * rotulo. Um campo com passo e sem rotulo levaria a compradora ao passo
     * certo e destacaria um campo sem nome; um com rotulo e sem passo aparece
     * na frase e nao leva a lugar nenhum — este segundo caso e legitimo
     * (`cupom` e `quantidade` moram no proprio passo 4), o primeiro nao.
     */
    it('todo campo com passo tem rotulo', () => {
      for (const campo of Object.keys(PASSO_DO_CAMPO)) {
        expect(ROTULO_DO_CAMPO[campo], `campo sem rotulo: ${campo}`).toBeDefined()
      }
    })

    it('os campos pessoais moram no passo 2 e os de endereco no 3', () => {
      for (const campo of ['nome', 'email', 'cpf', 'whatsapp']) {
        expect(PASSO_DO_CAMPO[campo]).toBe(2)
      }
      for (const campo of ['cep', 'rua', 'numero', 'complemento', 'bairro', 'cidade', 'estado']) {
        expect(PASSO_DO_CAMPO[campo]).toBe(3)
      }
    })

    /**
     * `cupom` e `quantidade` ficam FORA de proposito: os dois pertencem ao
     * passo 4, onde a mensagem ja aparece. Inclui-los faria a tela navegar para
     * o passo em que a pessoa ja esta.
     */
    it('cupom e quantidade nao tem passo proprio', () => {
      expect(PASSO_DO_CAMPO.cupom).toBeUndefined()
      expect(PASSO_DO_CAMPO.quantidade).toBeUndefined()
    })
  })

  describe('rotuloDoCampo', () => {
    it('devolve o proprio nome quando o campo e desconhecido', () => {
      expect(rotuloDoCampo('idServico')).toBe('idServico')
    })
  })
})
