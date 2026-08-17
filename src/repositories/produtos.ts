import type { Selectable } from 'kysely'
import { getDb } from '@/lib/db'
import type { Kits } from '@/lib/db-types'
import { deInteiro, type Centavos } from '@/lib/money'

export type Kit = {
  id: string
  slug: string
  nome: string
  descricao: string
  precoCentavos: Centavos
  unidades: number
  sku: string
  anvisaRegistro: string | null
  ativo: boolean
  ordem: number
  /**
   * Peso e dimensoes da caixa do kit, do CADASTRO. Sobem pelo repositorio
   * justamente para que nenhuma rota precise inventa-los: a cotacao do Clube
   * Envios (src/lib/frete.ts, tipo VolumeDaCotacao) exige os quatro valores no
   * corpo da requisicao, e um numero digitado direto na rota vira frete errado
   * sem que nada no codigo aponte de onde ele veio. Mesma regra que ja vale
   * para precoCentavos: o valor que vira dinheiro vem da tabela, sempre.
   *
   * A UNIDADE ESTA NO NOME e e contrato com a API de frete
   * (migrations/1755300600000_kit_dimensoes.sql): peso em GRAMAS, medidas em
   * CENTIMETROS. Nao sao `Centavos` porque nao sao dinheiro, mas sao da mesma
   * familia de armadilha que o tipo branded fecha — gravar 0,5 onde se espera
   * 500 e um fator de mil no frete sem erro de compilacao nenhum. O nome da
   * propriedade e a unica defesa aqui, entao ele nao encolhe para `peso`.
   *
   * OS VALORES DE HOJE SAO PALPITE DECLARADO, nao medida: os DEFAULTs da
   * migration (500 g, 12 x 16 x 20 cm) foram escritos em 16/08/2026 e
   * precisam ser conferidos com a expedicao antes de 25/08. O kit ja semeado
   * ('kit-milagran') herdou os quatro. Enquanto ninguem medir, todo frete
   * online sai cotado sobre estimativa — e pedidos.frete_centavos e congelado
   * pelo trigger de imutabilidade, entao nao ha correcao depois do INSERT.
   */
  pesoGramas: number
  alturaCm: number
  larguraCm: number
  comprimentoCm: number
}

function paraKit(l: Selectable<Kits>): Kit {
  return {
    id: l.id,
    slug: l.slug,
    nome: l.nome,
    descricao: l.descricao,
    precoCentavos: deInteiro(l.preco_centavos),
    unidades: l.unidades,
    sku: l.sku,
    anvisaRegistro: l.anvisa_registro,
    ativo: l.ativo,
    ordem: l.ordem,
    // Um a um, sem espalhar o resto da linha: `...l` traria as colunas cruas
    // (peso_gramas, criado_em, atualizado_em) para dentro de um tipo que
    // declara nomes em camelCase, e a divergencia so apareceria em quem
    // consome. As quatro sao integer/smallint no banco, que o driver do
    // Postgres ja entrega como number — nada de Numeric aqui, ao contrario
    // do que acontece com valores fracionarios.
    pesoGramas: l.peso_gramas,
    alturaCm: l.altura_cm,
    larguraCm: l.largura_cm,
    comprimentoCm: l.comprimento_cm,
  }
}

export async function listarKitsAtivos(): Promise<Kit[]> {
  const linhas = await getDb()
    .selectFrom('kits')
    .selectAll()
    .where('ativo', '=', true)
    // `ordem` nao e unica (kits_ativos_ordem e um indice btree comum, nao
    // um indice unico) e nada no schema impede dois kits ativos com o
    // mesmo valor. Sem uma segunda chave de ordenacao, um empate em `ordem`
    // fica decidido pela ordem de varredura do Postgres, que nao e
    // garantida — e a storefront (Task 8) le kits[0]. Desempatar por slug
    // torna o resultado deterministico em vez de acidentalmente estavel.
    .orderBy('ordem', 'asc')
    .orderBy('slug', 'asc')
    .execute()
  return linhas.map((l) => paraKit(l))
}

export async function buscarKitAtivoPorSlug(slug: string): Promise<Kit | null> {
  const linha = await getDb()
    .selectFrom('kits')
    .selectAll()
    .where('slug', '=', slug)
    .where('ativo', '=', true)
    .executeTakeFirst()
  return linha ? paraKit(linha) : null
}
