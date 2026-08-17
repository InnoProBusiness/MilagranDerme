/**
 * A UNICA fonte do que qualquer tela diz sobre a escassez do estoque
 * presencial do lancamento (§5 e §11 do documento do cliente de 16/08/2026).
 *
 * POR QUE UM MODULO, e nao a frase escrita em cada tela: e literalmente a
 * licao de src/components/linha-frete.tsx. La eram quatro superficies falando
 * do frete do MESMO pedido, tres com o texto na mao e uma consultando a flag;
 * bastou a flag mudar para a loja discordar de si mesma sobre a mesma compra.
 * Aqui sao quatro superficies de novo, todas sobre o MESMO saldo: a vitrine
 * (src/components/vitrine.tsx), o contador que faz polling de 15s
 * (src/components/contador-estoque.tsx), a resposta de GET /api/estoque e a
 * tela de balcao (src/components/venda-presencial.tsx). Com a copy escrita em
 * cada uma, o balcao poderia gritar "esgotado" enquanto a home ainda promete
 * "restam apenas 8" do mesmo lote, no mesmo segundo, com o comprador olhando
 * as duas. Com uma funcao so, essa divergencia nao tem onde nascer.
 *
 * PURO DE PROPOSITO — sem banco e sem React. contador-estoque.tsx e um
 * client component: se este arquivo importasse qualquer coisa que puxe
 * src/lib/db.ts, o driver `pg` entraria no bundle do navegador e o build
 * quebraria. Quem sabe ler saldo e src/repositories/estoque.ts; quem sabe
 * dizer o que isso significa para o comprador e este arquivo.
 *
 * MUDAR OS LIMIARES OU AS MENSAGENS muda as quatro telas de uma vez, por
 * construcao. As frases sao copy aprovada pelo cliente: alterar palavra aqui
 * e alterar o que a Milagran promete na vitrine, nao refatorar.
 */

/**
 * Acima deste saldo a loja NAO fala em escassez — so anuncia o tamanho do
 * lote. Ordem importa: LIMIAR_ULTIMOS_KITS e conferido antes deste na cadeia
 * de avisoDeEscassez. Inverter os dois testes joga um saldo de 3 kits na
 * faixa 'poucos' e a contagem regressiva de fim de estoque nunca aparece.
 */
export const LIMIAR_POUCOS_KITS = 10

/** Daqui para baixo (e ainda acima de zero) o aviso vira contagem regressiva. */
export const LIMIAR_ULTIMOS_KITS = 5

export type NivelEscassez = 'normal' | 'poucos' | 'ultimos' | 'esgotado'

/**
 * `nivel` e para a tela decidir aparencia e comportamento (a vitrine troca a
 * CTA por "COMPRAR ONLINE" quando 'esgotado'); `mensagem` e o texto pronto,
 * ja acentuado, para exibir sem reescrever nada.
 */
export type AvisoEscassez = { nivel: NivelEscassez; mensagem: string }

/**
 * Normaliza um numero vindo de SUM() do banco antes de ele virar texto na
 * tela. Nao e paranoia gratuita: `disponivel` e SUM(quantidade) sobre
 * estoque_movimentos e `total` e SUM(entrada) — em Postgres, SUM() sobre zero
 * linhas devolve NULL, e o caminho NULL -> undefined -> Number() -> NaN
 * existe de verdade entre o repositorio e aqui. Um NaN que escapasse
 * imprimiria "Restam apenas NaN kits" na home no dia do lancamento.
 * Truncar tambem protege contra fracionario: 5.9 kits nao existe, e sem o
 * trunc ele cairia em 'poucos' anunciando "5.9 kits".
 */
function inteiroSeguro(valor: number): number {
  if (!Number.isFinite(valor)) return 0
  return Math.trunc(valor)
}

/**
 * `disponivel` e o saldo vivo (SUM de todos os movimentos); `total` e o
 * tamanho do lote que entrou (SUM das entradas, 50 no lancamento).
 *
 * POR QUE 'esgotado' e 'normal' falam de `total` e as duas faixas do meio
 * falam de `disponivel`: e a copy do cliente, nao descuido. As pontas
 * anunciam o LOTE ("os 50 kits foram esgotados", "apenas 50 kits para levar
 * na hora") e o meio faz contagem regressiva do que sobrou. O numero vivo
 * cru continua sendo mostrado a parte, na linha "Kits disponíveis: N" da
 * vitrine — este texto e a leitura editorial do saldo, nao o contador.
 *
 * `disponivel` MAIOR que `total` e um estado legitimo, nao um bug a barrar:
 * um movimento de 'ajuste' positivo (correcao de contagem no evento) sobe o
 * saldo sem ser 'entrada', entao ele nao entra em `total`. Nesse caso a faixa
 * continua saindo do saldo vivo e a frase de lote continua citando o lote —
 * conservador, e nunca lanca. Saldo negativo (ajuste para baixo, ou o canal
 * online, que e ilimitado e pode ficar abaixo de zero) cai em 'esgotado' pela
 * mesma porta do zero: com estoque nao provado, a loja nao promete kit.
 */
export function avisoDeEscassez(disponivel: number, total: number): AvisoEscassez {
  const saldo = inteiroSeguro(disponivel)
  // O clamp em zero cobre so o caso degenerado de nao haver entrada nenhuma:
  // a constraint movimento_entrada_positiva
  // (migrations/1755300000000_canal_e_estoque.sql) ja garante que toda
  // entrada e positiva, entao `total` negativo nao deveria existir — e se
  // existir, o lugar de descobrir isso e o painel, nao a home anunciando um
  // lote de -50 kits.
  const lote = Math.max(0, inteiroSeguro(total))

  if (saldo <= 0) {
    return {
      nivel: 'esgotado',
      mensagem: `Os ${lote} kits disponíveis para compra presencial foram esgotados.`,
    }
  }

  if (saldo <= LIMIAR_ULTIMOS_KITS) {
    return {
      nivel: 'ultimos',
      mensagem: `Últimos ${saldo} kits disponíveis para compra presencial.`,
    }
  }

  if (saldo <= LIMIAR_POUCOS_KITS) {
    return {
      nivel: 'poucos',
      mensagem: `Restam apenas ${saldo} kits disponíveis para levar hoje.`,
    }
  }

  return {
    nivel: 'normal',
    mensagem: `Apenas ${lote} kits disponíveis para levar na hora.`,
  }
}
