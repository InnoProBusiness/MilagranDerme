'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatarBRL } from '@/lib/money'
import type { Centavos } from '@/lib/money'

const URL_SDK = 'https://sdk.mercadopago.com/js/v2'

/**
 * Superficie minima do SDK do Mercado Pago que este componente usa. Declarada
 * a mao em vez de instalar @types: o SDK e carregado por <script> em runtime,
 * nao importado, entao um pacote de tipos nao acrescentaria checagem real —
 * so a ilusao dela.
 */
type ControladorBrick = { unmount: () => void }
type DadosDoCartao = {
  token: string
  installments: number
  payment_method_id: string
  issuer_id?: string
}
type ConstrutorMP = new (chave: string, opcoes: { locale: string }) => {
  bricks: () => {
    create: (
      tipo: 'cardPayment',
      container: string,
      config: Record<string, unknown>,
    ) => Promise<ControladorBrick>
  }
}
declare global {
  interface Window { MercadoPago?: ConstrutorMP }
}

function carregarSdk(): Promise<void> {
  if (window.MercadoPago) return Promise.resolve()

  const existente = document.querySelector<HTMLScriptElement>(`script[src="${URL_SDK}"]`)
  if (existente) {
    return new Promise((resolve, reject) => {
      existente.addEventListener('load', () => resolve())
      existente.addEventListener('error', () => reject(new Error('sdk_falhou')))
    })
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = URL_SDK
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('sdk_falhou'))
    document.body.appendChild(script)
  })
}

type Props = {
  pedidoToken: string
  totalCentavos: Centavos
  chavePublica: string
  /**
   * Prefixa o campo de e-mail do Brick para o comprador nao redigitar o que
   * acabou de informar no checkout.
   *
   * TROCA CONSCIENTE: esta pagina e publica, protegida so por um token
   * inadivinhavel. Quem tiver o link ve o e-mail. O dado ja e do proprio
   * comprador, que chegou aqui segundos depois de digita-lo, e o CPF — que e
   * mais sensivel — continua sem sair do servidor: ele vai direto do banco
   * para o Mercado Pago, dentro de /api/pagamentos.
   */
  emailComprador: string
}

type Resultado =
  | { tipo: 'pix'; copiaECola: string; qrBase64: string }
  | { tipo: 'erro'; mensagem: string }

export function Pagamento({ pedidoToken, totalCentavos, chavePublica, emailComprador }: Props) {
  const router = useRouter()
  const [metodo, setMetodo] = useState<'pix' | 'cartao' | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [copiado, setCopiado] = useState(false)

  const enviar = useCallback(async (corpo: Record<string, unknown>) => {
    const r = await fetch('/api/pagamentos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pedidoToken, ...corpo }),
    })
    const dados: unknown = await r.json().catch(() => null)
    return { ok: r.ok, status: r.status, dados: (dados ?? {}) as Record<string, unknown> }
  }, [pedidoToken])

  async function pagarComPix() {
    setOcupado(true)
    setResultado(null)
    try {
      const { ok, dados } = await enviar({ metodo: 'pix' })
      if (!ok || typeof dados.pixCopiaECola !== 'string' || typeof dados.pixQrBase64 !== 'string') {
        setResultado({
          tipo: 'erro',
          mensagem: typeof dados.mensagem === 'string'
            ? dados.mensagem
            : 'Não foi possível gerar o Pix. Tente de novo em instantes.',
        })
        return
      }
      setResultado({ tipo: 'pix', copiaECola: dados.pixCopiaECola, qrBase64: dados.pixQrBase64 })
    } catch {
      setResultado({ tipo: 'erro', mensagem: 'Falha de conexão. Tente de novo.' })
    } finally {
      setOcupado(false)
    }
  }

  async function copiarCodigo(codigo: string) {
    try {
      await navigator.clipboard.writeText(codigo)
      setCopiado(true)
      window.setTimeout(() => setCopiado(false), 2500)
    } catch {
      // Sem permissao de clipboard: o codigo continua visivel e selecionavel
      // na tela, entao nao ha nada a comunicar aqui.
    }
  }

  return (
    <div className="pagamento">
      <h2>Pagamento</h2>
      <p className="pagamento__total">Total a pagar: <strong>{formatarBRL(totalCentavos)}</strong></p>

      {metodo === null && (
        <div className="pagamento__opcoes">
          <button
            type="button" className="btn btn--solid"
            onClick={() => { setMetodo('pix'); void pagarComPix() }}
          >
            Pagar com Pix
          </button>
          <button
            type="button" className="btn btn--ghost"
            onClick={() => setMetodo('cartao')}
          >
            Pagar com cartão
          </button>
        </div>
      )}

      {metodo === 'pix' && (
        <div className="pagamento__pix">
          {ocupado && <p role="status">Gerando o código Pix…</p>}

          {resultado?.tipo === 'pix' && (
            <>
              <img
                className="pagamento__qr"
                src={`data:image/png;base64,${resultado.qrBase64}`}
                alt="QR code do Pix para pagar este pedido"
                width={240}
                height={240}
              />
              <label htmlFor="pix-codigo">Ou use o Pix copia e cola</label>
              <textarea
                id="pix-codigo" className="pagamento__codigo" readOnly rows={3}
                value={resultado.copiaECola}
              />
              <button
                type="button" className="btn btn--solid"
                onClick={() => void copiarCodigo(resultado.copiaECola)}
              >
                {copiado ? 'Código copiado' : 'Copiar código'}
              </button>
              {/*
                O Pix e assincrono: quem confirma o pagamento e o webhook, nao
                esta tela. O botao reconsulta o servidor em vez de fingir que
                sabe — inventar "pagamento confirmado" no cliente e como uma
                loja dar o produto antes de o dinheiro cair.
              */}
              <p className="pagamento__aviso">
                Assim que o pagamento cair, esta página passa a mostrar o pedido
                como pago. Pode levar alguns segundos.
              </p>
              <button type="button" className="btn btn--ghost" onClick={() => router.refresh()}>
                Já paguei — atualizar
              </button>
            </>
          )}

          {resultado?.tipo === 'erro' && (
            <p className="form__status form__status--error" role="status">{resultado.mensagem}</p>
          )}
        </div>
      )}

      {metodo === 'cartao' && (
        <BrickDeCartao
          chavePublica={chavePublica}
          totalCentavos={totalCentavos}
          emailComprador={emailComprador}
          aoPagar={async (cartao) => {
            setOcupado(true)
            const { ok, dados } = await enviar({
              metodo: 'cartao',
              token: cartao.token,
              parcelas: cartao.installments,
              metodoPagamentoId: cartao.payment_method_id,
              ...(cartao.issuer_id ? { emissorId: cartao.issuer_id } : {}),
            })
            setOcupado(false)

            if (ok && dados.pedidoPago === true) {
              router.refresh()
              return
            }
            setResultado({
              tipo: 'erro',
              mensagem: typeof dados.mensagem === 'string'
                ? dados.mensagem
                : 'Não foi possível concluir o pagamento. Tente outro cartão ou pague com Pix.',
            })
          }}
        />
      )}

      {metodo === 'cartao' && resultado?.tipo === 'erro' && (
        <p className="form__status form__status--error" role="status">{resultado.mensagem}</p>
      )}

      {metodo !== null && (
        <button
          type="button" className="btn btn--ghost"
          disabled={ocupado}
          onClick={() => { setMetodo(null); setResultado(null) }}
        >
          Escolher outra forma de pagamento
        </button>
      )}
    </div>
  )
}

function BrickDeCartao({
  chavePublica, totalCentavos, emailComprador, aoPagar,
}: {
  chavePublica: string
  totalCentavos: Centavos
  emailComprador: string
  aoPagar: (cartao: DadosDoCartao) => Promise<void>
}) {
  const [erroSdk, setErroSdk] = useState(false)
  const controlador = useRef<ControladorBrick | null>(null)
  // O callback muda a cada render (fecha sobre estado do pai), mas o Brick e
  // montado uma vez so. Guardar em ref deixa o efeito rodar com dependencias
  // estaveis sem congelar uma versao velha do callback.
  const aoPagarRef = useRef(aoPagar)
  aoPagarRef.current = aoPagar

  useEffect(() => {
    let vivo = true

    void (async () => {
      try {
        await carregarSdk()
        if (!vivo || !window.MercadoPago) return

        const mp = new window.MercadoPago(chavePublica, { locale: 'pt-BR' })
        const controle = await mp.bricks().create('cardPayment', 'brick-cartao', {
          initialization: {
            amount: Number((totalCentavos / 100).toFixed(2)),
            payer: { email: emailComprador },
          },
          customization: {
            visual: { style: { theme: 'default' } },
            paymentMethods: { maxInstallments: 12 },
          },
          callbacks: {
            onReady: () => {},
            onSubmit: (dados: DadosDoCartao) => aoPagarRef.current(dados),
            onError: () => setErroSdk(true),
          },
        })

        // O componente pode ter desmontado durante o await (StrictMode monta,
        // desmonta e remonta em desenvolvimento). Sem esta checagem o Brick
        // fica orfao no DOM e o segundo mount encontra o container ocupado.
        if (!vivo) {
          controle.unmount()
          return
        }
        controlador.current = controle
      } catch {
        if (vivo) setErroSdk(true)
      }
    })()

    return () => {
      vivo = false
      controlador.current?.unmount()
      controlador.current = null
    }
  }, [chavePublica, totalCentavos, emailComprador])

  return (
    <div className="pagamento__cartao">
      {erroSdk && (
        <p className="form__status form__status--error" role="status">
          Não foi possível carregar o formulário de cartão. Recarregue a página
          ou pague com Pix.
        </p>
      )}
      <div id="brick-cartao" />
    </div>
  )
}
