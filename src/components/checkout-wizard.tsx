'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Kit } from '@/repositories/produtos'
import { montarCarrinho, QUANTIDADE_MAXIMA } from '@/lib/carrinho'
import { formatarBRL } from '@/lib/money'
import { LinhaFrete } from '@/components/linha-frete'

type Props = {
  kit: Kit
  quantidadeInicial: number
}

type DadosPessoais = { nome: string; email: string; cpf: string; whatsapp: string }
type Endereco = {
  cep: string; rua: string; numero: string; complemento: string
  bairro: string; cidade: string; estado: string
}

const DADOS_VAZIOS: DadosPessoais = { nome: '', email: '', cpf: '', whatsapp: '' }
const ENDERECO_VAZIO: Endereco = {
  cep: '', rua: '', numero: '', complemento: '', bairro: '', cidade: '', estado: '',
}

// Mesmas regras do Zod em src/app/api/pedidos/route.ts, verificadas aqui so
// para habilitar/desabilitar o "Continuar" mais cedo. A validacao que
// realmente decide se o pedido e criado e sempre a do servidor — isto e so
// UX, nunca a fonte de verdade.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function somenteDigitos(v: string): string {
  return v.replace(/\D/g, '')
}

function dadosPessoaisValidos(d: DadosPessoais): boolean {
  return d.nome.trim().length >= 3
    && EMAIL_REGEX.test(d.email)
    && /^\d{11}$/.test(d.cpf)
    && /^\d{10,13}$/.test(d.whatsapp)
}

function enderecoValido(e: Endereco): boolean {
  return /^\d{8}$/.test(e.cep)
    && e.rua.trim().length > 0
    && e.numero.trim().length > 0
    && e.bairro.trim().length > 0
    && e.cidade.trim().length > 0
    && /^[A-Z]{2}$/.test(e.estado)
}

export function CheckoutWizard({ kit, quantidadeInicial }: Props) {
  const router = useRouter()
  const [passo, setPasso] = useState(1)
  const [quantidade, setQuantidade] = useState(quantidadeInicial)
  const [dados, setDados] = useState<DadosPessoais>(DADOS_VAZIOS)
  const [endereco, setEndereco] = useState<Endereco>(ENDERECO_VAZIO)
  const [cupom, setCupom] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  // So para exibir Produto/Quantidade/Subtotal aqui — o preco que decide o
  // pedido de verdade e lido do catalogo de novo, no servidor, dentro da
  // transacao (buscarKitAtivoPorSlug em src/app/api/pedidos/route.ts). Nada
  // calculado neste componente e enviado como valor monetario: o corpo do
  // POST manda so kitSlug e quantidade.
  const resumo = montarCarrinho([{
    kitId: kit.id, nome: kit.nome, precoUnitario: kit.precoCentavos, quantidade,
  }])

  async function confirmar() {
    setEnviando(true)
    setErro(null)
    try {
      const resposta = await fetch('/api/pedidos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kitSlug: kit.slug,
          quantidade,
          ...(cupom.trim() ? { cupom: cupom.trim() } : {}),
          ...dados,
          ...endereco,
        }),
      })
      const corpo: unknown = await resposta.json().catch(() => null)

      if (!resposta.ok) {
        const mensagem = corpo && typeof corpo === 'object' && 'mensagem' in corpo
          && typeof (corpo as { mensagem: unknown }).mensagem === 'string'
          ? (corpo as { mensagem: string }).mensagem
          : 'Nao foi possivel concluir o pedido. Confira os dados e tente novamente.'
        setErro(mensagem)
        setEnviando(false)
        return
      }

      // Navega pelo TOKEN, nunca pelo numero: numero e um bigint
      // sequencial e a pagina de confirmacao e publica sem autenticacao —
      // uma URL previsivel deixaria qualquer visitante andar /pedido/1,
      // /pedido/2... (ver migrations/1755100000000_pedido_token.sql e
      // src/app/pedido/[token]/page.tsx).
      const token = corpo && typeof corpo === 'object' && 'token' in corpo
        ? (corpo as { token: unknown }).token
        : null
      if (typeof token !== 'string') {
        setErro('Pedido criado, mas a confirmacao veio incompleta. Entre em contato com o suporte.')
        setEnviando(false)
        return
      }
      router.push(`/pedido/${token}`)
    } catch {
      setErro('Falha de conexao. Tente novamente.')
      setEnviando(false)
    }
  }

  return (
    <section className="section checkout">
      <p className="kicker">Checkout — passo {passo} de 4</p>

      {passo === 1 && (
        <div className="checkout__passo">
          <h1>{kit.nome}</h1>
          <p className="vitrine__preco">{formatarBRL(kit.precoCentavos)}</p>

          <div className="vitrine__stepper" role="group" aria-label="Quantidade">
            <button
              type="button"
              className="vitrine__stepper-btn"
              aria-label="Diminuir quantidade"
              disabled={quantidade <= 1}
              onClick={() => setQuantidade((q) => Math.max(1, q - 1))}
            >
              −
            </button>
            <span className="vitrine__stepper-valor" data-testid="quantidade">{quantidade}</span>
            <button
              type="button"
              className="vitrine__stepper-btn"
              aria-label="Aumentar quantidade"
              disabled={quantidade >= QUANTIDADE_MAXIMA}
              onClick={() => setQuantidade((q) => Math.min(QUANTIDADE_MAXIMA, q + 1))}
            >
              +
            </button>
          </div>

          <div className="vitrine__resumo">
            <p className="vitrine__linha">Subtotal: {formatarBRL(resumo.subtotal)}</p>
            <LinhaFrete />
          </div>

          <div className="checkout__nav">
            <button type="button" className="btn btn--solid" onClick={() => setPasso(2)}>
              Continuar
            </button>
          </div>
        </div>
      )}

      {passo === 2 && (
        <div className="checkout__passo form">
          <h2>Seus dados</h2>
          <div className="form__grid">
            <div className="form__field form__field--wide">
              <label htmlFor="nome">Nome completo</label>
              <input
                id="nome" autoComplete="name" value={dados.nome}
                onChange={(e) => setDados({ ...dados, nome: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="email">E-mail</label>
              <input
                id="email" type="email" autoComplete="email" value={dados.email}
                onChange={(e) => setDados({ ...dados, email: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="cpf">CPF (somente numeros)</label>
              <input
                id="cpf" inputMode="numeric" maxLength={11} value={dados.cpf}
                onChange={(e) => setDados({ ...dados, cpf: somenteDigitos(e.target.value) })}
              />
            </div>
            <div className="form__field form__field--wide">
              <label htmlFor="whatsapp">WhatsApp (DDD + numero)</label>
              <input
                id="whatsapp" inputMode="numeric" maxLength={13} value={dados.whatsapp}
                onChange={(e) => setDados({ ...dados, whatsapp: somenteDigitos(e.target.value) })}
              />
            </div>
          </div>
          <div className="checkout__nav">
            <button type="button" className="btn btn--ghost" onClick={() => setPasso(1)}>Voltar</button>
            <button
              type="button" className="btn btn--solid"
              disabled={!dadosPessoaisValidos(dados)}
              onClick={() => setPasso(3)}
            >
              Continuar
            </button>
          </div>
        </div>
      )}

      {passo === 3 && (
        <div className="checkout__passo form">
          <h2>Endereço de entrega</h2>
          <div className="form__grid">
            <div className="form__field">
              <label htmlFor="cep">CEP (somente numeros)</label>
              <input
                id="cep" inputMode="numeric" maxLength={8} value={endereco.cep}
                onChange={(e) => setEndereco({ ...endereco, cep: somenteDigitos(e.target.value) })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="estado">Estado (UF)</label>
              <input
                id="estado" maxLength={2} value={endereco.estado}
                onChange={(e) => setEndereco({
                  ...endereco, estado: e.target.value.toUpperCase().replace(/[^A-Z]/g, ''),
                })}
              />
            </div>
            <div className="form__field form__field--wide">
              <label htmlFor="rua">Rua</label>
              <input
                id="rua" value={endereco.rua}
                onChange={(e) => setEndereco({ ...endereco, rua: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="numero">Numero</label>
              <input
                id="numero" value={endereco.numero}
                onChange={(e) => setEndereco({ ...endereco, numero: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="complemento">Complemento</label>
              <input
                id="complemento" value={endereco.complemento}
                onChange={(e) => setEndereco({ ...endereco, complemento: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="bairro">Bairro</label>
              <input
                id="bairro" value={endereco.bairro}
                onChange={(e) => setEndereco({ ...endereco, bairro: e.target.value })}
              />
            </div>
            <div className="form__field">
              <label htmlFor="cidade">Cidade</label>
              <input
                id="cidade" value={endereco.cidade}
                onChange={(e) => setEndereco({ ...endereco, cidade: e.target.value })}
              />
            </div>
          </div>
          <div className="checkout__nav">
            <button type="button" className="btn btn--ghost" onClick={() => setPasso(2)}>Voltar</button>
            <button
              type="button" className="btn btn--solid"
              disabled={!enderecoValido(endereco)}
              onClick={() => setPasso(4)}
            >
              Continuar
            </button>
          </div>
        </div>
      )}

      {passo === 4 && (
        <div className="checkout__passo form">
          <h2>Revisão</h2>
          <div className="vitrine__resumo">
            <p className="vitrine__linha">Produto: {kit.nome}</p>
            <p className="vitrine__linha">Quantidade: {quantidade}</p>
            <p className="vitrine__linha">Subtotal: {formatarBRL(resumo.subtotal)}</p>
            {/*
              Nenhum desconto e mostrado aqui: o cupom so e validado no
              servidor, sob trava de linha, no momento da confirmacao (ver
              src/repositories/cupons.ts). Mostrar um valor calculado no
              cliente para um cupom ainda nao verificado seria inventar um
              desconto que pode nao existir.
            */}
            <LinhaFrete />
            <p className="vitrine__linha vitrine__linha--total">
              Total: {formatarBRL(resumo.total)}
              {cupom.trim() && ' (antes do cupom, verificado na confirmação)'}
            </p>
          </div>

          <div className="form__field">
            <label htmlFor="cupom">Cupom de desconto (opcional)</label>
            <input
              id="cupom" value={cupom}
              onChange={(e) => setCupom(e.target.value.toUpperCase())}
            />
          </div>

          {erro && <p className="form__status form__status--error" role="status">{erro}</p>}

          <div className="checkout__nav">
            <button type="button" className="btn btn--ghost" onClick={() => setPasso(3)} disabled={enviando}>
              Voltar
            </button>
            {/*
              O pedido e criado AQUI, mas a cobranca acontece na proxima tela
              (/pedido/<token>). A ordem nao e arbitraria: o total so e
              definitivo depois de o servidor validar o cupom sob trava de
              linha, e cobrar exige esse valor. Alem disso, uma pagina propria
              com URL estavel e o que faz o QR do Pix sobreviver a recarregar,
              fechar e voltar depois — coisa que um passo de wizard em memoria
              nao faria.
            */}
            <button type="button" className="btn btn--solid" onClick={confirmar} disabled={enviando}>
              {enviando ? 'Enviando...' : 'Ir para o pagamento'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
