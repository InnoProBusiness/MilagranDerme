'use client'

/**
 * A PORTA DE ENTRADA DE QUEM TRABALHA NO EVENTO: vendedor e administrador
 * (§10 e §17 do documento do cliente de 16/08/2026).
 *
 * 'use client' porque a tela inteira e um formulario com estado (e-mail, senha,
 * "enviando", mensagem de recusa) e uma chamada assincrona disparada por um
 * clique. Nao ha nada aqui que um Server Component pudesse renderizar: o unico
 * dado que esta pagina produz e o cookie que POST /api/sessao devolve.
 *
 * SEM `export const dynamic`, ao contrario de /venda e /admin: esta tela nao le
 * dado vivo nenhum. Ela e um formulario estatico — o que decide quem entra e a
 * rota, no servidor, a cada submissao. A convencao do projeto (`force-dynamic`
 * em pagina que le o banco) existe para nao servir dado velho, e aqui nao ha
 * dado a envelhecer.
 */

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * UMA UNICA MENSAGEM DE RECUSA, E ELA E UMA CONSTANTE.
 *
 * As tres razoes possiveis — e-mail que nunca existiu, senha errada e usuario
 * desativado — ja foram achatadas em UM null por `autenticar`
 * (src/repositories/usuarios.ts) e em UM 401 `credenciais_invalidas` por
 * src/app/api/sessao/route.ts, que de proposito nao manda campo `mensagem`
 * nenhum. As duas camadas de baixo pagaram um preco por isso: `autenticar`
 * confere a senha contra um hash descartavel quando o e-mail nao existe, so
 * para o TEMPO de resposta tambem nao denunciar a diferenca.
 *
 * ESTA TELA NAO PODE REINTRODUZIR A DISTINCAO QUE ELAS REMOVERAM. Um
 * "Usuário não encontrado" aqui devolveria de graca o oraculo inteiro: quem
 * descobre, pela forma da resposta, que "fulano@milagran" TEM conta passa a
 * saber em quem gastar tentativa de senha e para quem mandar phishing de "sua
 * conta Milagran expirou"; no caso da conta desativada, descobre ainda que a
 * pessoa foi desligada da empresa. Por isso a frase e uma CONSTANTE e nao um
 * texto vindo do servidor: texto de servidor e o tipo de coisa que uma
 * "melhoria de UX" futura diferencia por caso sem ninguem perceber que
 * transformou a tela num oraculo.
 *
 * O 422 do schema cai na MESMA frase, e isso e deliberado: e-mail malformado e
 * outra coisa que a pessoa digitou errado, e separar as duas so daria ao
 * sondador um mapa do que a rota aceita como formato.
 */
const CREDENCIAIS_INVALIDAS = 'E-mail ou senha inválidos.'

/**
 * As duas mensagens abaixo NAO falam da credencial, falam do SISTEMA — e por
 * isso podem ser especificas sem abrir oraculo nenhum: elas valem igual para
 * quem digitou certo e para quem digitou errado, porque a rota nem chegou a
 * conferir. Achata-las em CREDENCIAIS_INVALIDAS seria mentir para o vendedor
 * na fila, que ficaria redigitando uma senha correta enquanto o Postgres esta
 * fora do ar.
 */
const MUITAS_TENTATIVAS =
  'Muitas tentativas deste aparelho. Espere alguns minutos antes de tentar de novo.'
const FALHA_DO_SISTEMA =
  'Não foi possível entrar agora. O problema é do sistema, não do que você digitou — tente de novo em instantes.'
const FALHA_DE_CONEXAO = 'Falha de conexão. Confira a rede e tente de novo.'

/**
 * PARA ONDE A PESSOA VAI DEPOIS DE ENTRAR.
 *
 * O login responde 204 SEM CORPO de proposito (src/app/api/sessao/route.ts): a
 * resposta nao devolve `papel`, nome nem id, justamente para nenhuma tela
 * decidir o que mostrar com base num valor guardado no navegador. Consequencia
 * direta e assumida: ESTA TELA NAO SABE se quem acabou de entrar e vendedor ou
 * admin, e portanto nao pode escolher entre /venda e /admin por papel.
 *
 * Quem escolhe e o DESTINO da URL — `/entrar?destino=/admin` —, colocado ali
 * pela propria pagina protegida quando ela devolve o visitante para o login
 * (ver src/app/venda/page.tsx). Sem destino, o padrao e o balcao: no dia 25/08
 * a esmagadora maioria dos logins e de vendedor, e o admin que cair aqui sem
 * destino acha o painel pelo link que /venda mostra para quem tem papel
 * 'admin'.
 *
 * A LISTA E FECHADA, e nao uma validacao de "comeca com /". Redirecionar para
 * um endereco vindo da query string e a receita classica de open redirect: um
 * `/entrar?destino=https://milagran-oficial.com/entrar` mandado por WhatsApp
 * levaria o vendedor a digitar a senha de novo num clone, logo depois de o
 * login VERDADEIRO ter funcionado — o momento em que ele menos desconfia. Com
 * duas strings exatas nao ha o que escapar.
 *
 * `destinoSeguro` NAO e exportada, ao contrario dos ajudantes puros de
 * src/components/vitrine.tsx que ganham teste direto: um arquivo `page.tsx` so
 * pode exportar `default` e os campos de configuracao de segmento, e qualquer
 * outro export vira erro de build do Next ("is not a valid Page export
 * field"). No dia em que ela precisar de teste proprio, o lugar dela e
 * src/lib.
 */
const DESTINO_PADRAO = '/venda'
const DESTINOS_PERMITIDOS: readonly string[] = ['/venda', '/admin']

function destinoSeguro(buscaDaUrl: string): string {
  const pedido = new URLSearchParams(buscaDaUrl).get('destino') ?? ''
  return DESTINOS_PERMITIDOS.includes(pedido) ? pedido : DESTINO_PADRAO
}

export default function PaginaEntrar() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  // Segunda linha de defesa contra duas submissoes, alem do `disabled` do
  // botao: um `ref` e lido e escrito na hora, sem esperar re-renderizacao.
  // Mesma razao (e mesmo comentario) de src/components/venda-presencial.tsx —
  // no celular do balcao, dois toques cabem dentro do mesmo quadro.
  const enviandoRef = useRef(false)

  const preenchido = email.trim() !== '' && senha !== ''

  async function entrar(evento: React.FormEvent) {
    evento.preventDefault()
    if (enviandoRef.current || !preenchido) return

    enviandoRef.current = true
    setEnviando(true)
    setErro(null)

    try {
      const resposta = await fetch('/api/sessao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Exatamente os dois campos que o schema `.strict()` da rota aceita. Um
        // `papel` ou um `usuarioId` a mais aqui seria 422 — e o `.strict()` de
        // la existe justamente porque o campo perigoso desta rota nao e
        // dinheiro, e PRIVILEGIO.
        body: JSON.stringify({ email: email.trim(), senha }),
      })

      if (resposta.status === 204) {
        // O cookie ja chegou no Set-Cookie da resposta. `push` dispara uma
        // navegacao nova, que carrega o cookie e faz o Server Component do
        // destino ler a sessao pelo servidor (usuarioDaSessaoNoServidor,
        // src/lib/guarda.ts) — nao ha estado de "logado" guardado neste
        // componente, e e isso que impede a tela de decidir acesso sozinha.
        router.push(destinoSeguro(window.location.search))
        // NAO desliga `enviando`: a navegacao esta a caminho e reabilitar o
        // botao aqui daria ao vendedor a chance de submeter de novo enquanto a
        // proxima tela carrega.
        return
      }

      if (resposta.status === 429) setErro(MUITAS_TENTATIVAS)
      else if (resposta.status === 401 || resposta.status === 422) setErro(CREDENCIAIS_INVALIDAS)
      else setErro(FALHA_DO_SISTEMA)
    } catch {
      setErro(FALHA_DE_CONEXAO)
    }

    enviandoRef.current = false
    setEnviando(false)
  }

  return (
    <section className="section entrar">
      <p className="kicker">Milagran</p>
      <h1>Entrar</h1>
      <p className="entrar__lede">
        Acesso da equipe: vendedores do evento e administração.
      </p>

      <form onSubmit={entrar} noValidate>
        <div className="form__field">
          <label htmlFor="email">E-mail</label>
          <input
            id="email"
            type="email"
            // `username` e nao `email`: e o valor que faz o gerenciador de
            // senhas do celular oferecer o par certo (usuario + senha) em vez
            // de so completar o endereco.
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            disabled={enviando}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="form__field">
          <label htmlFor="senha">Senha</label>
          <input
            id="senha"
            type="password"
            autoComplete="current-password"
            value={senha}
            disabled={enviando}
            onChange={(e) => setSenha(e.target.value)}
          />
        </div>

        {/*
          role="alert" e nao role="status": esta mensagem BLOQUEIA o que a
          pessoa veio fazer, e no meio da fila do evento ela precisa ser
          anunciada agora, nao quando o leitor de tela terminar o que estava
          lendo. E a mesma distincao documentada no bloco .aviso de
          src/app/globals.css e ja aplicada ao erro de frete do checkout.

          O texto NAO diz qual campo esta errado — ver CREDENCIAIS_INVALIDAS.
        */}
        {erro && (
          <p className="aviso aviso--erro" role="alert">
            {erro}
          </p>
        )}

        <button
          type="submit"
          className="btn btn--solid entrar__submit"
          disabled={enviando || !preenchido}
        >
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </section>
  )
}
