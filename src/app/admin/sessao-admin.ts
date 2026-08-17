import { redirect } from 'next/navigation'
import { usuarioDaSessaoNoServidor } from '@/lib/guarda'
import type { Usuario } from '@/repositories/usuarios'

/**
 * A GUARDA DAS SEIS TELAS DE §17, e a razao de ela existir como funcao esta
 * escrita no proprio src/lib/guarda.ts:
 *
 *   "DEVOLVE null, NAO REDIRECIONA. Quem decide o que fazer com 'nao ha
 *    sessao' e a pagina."
 *
 * Este arquivo e essa decisao, tomada uma vez para o segmento /admin inteiro.
 * `usuarioDaSessaoNoServidor` continua sendo quem LE a sessao (e o unico lugar
 * do projeto que sabe ler cookie fora de uma Request); aqui so se responde o
 * que a tela faz quando a leitura vem vazia.
 *
 * POR QUE UMA FUNCAO E NAO QUATRO LINHAS COPIADAS EM CADA page.tsx: a
 * checagem nao e "ha sessao?", e "ha sessao E o papel e admin?". Duas
 * condicoes copiadas seis vezes sao seis chances de alguem escrever so a
 * primeira — e a tela que esquecer a segunda nao fica vermelha em teste
 * nenhum, porque continua respondendo 200 para o vendedor que abriu o painel.
 * E o mesmo argumento que concentrou `exigirPapel` num arquivo so.
 *
 * O LAYOUT NAO DISPENSA ESTA CHAMADA EM NENHUMA PAGINA. layout.tsx do Next e
 * composicao de UI, nao barreira: ele nao intercepta a requisicao da pagina,
 * nao roda antes dela por contrato e nao impede que um `page.tsx` seja
 * renderizado — as duas coisas rodam no mesmo request e a pagina buscaria os
 * dados de qualquer forma. Por isso as seis telas chamam esta funcao ANTES da
 * primeira consulta ao banco, e o layout tambem chama a sua.
 *
 * ISTO NAO PROTEGE OS DADOS SOZINHO. Todo endereco HTTP que sirva os mesmos
 * numeros precisa da propria checagem (`exigirPapel`, em /api/admin/*) —
 * esconder uma tela nao fecha a rota que a alimenta.
 */

/**
 * Devolve o administrador da sessao ou INTERROMPE a renderizacao com um
 * redirect para /entrar. O tipo de retorno e `Usuario` (nunca `Usuario | null`)
 * porque `redirect()` do Next lanca: quem chama pode usar o resultado direto,
 * sem checagem redundante, e o compilador cobra isso.
 *
 * O PAPEL E COMPARADO DIRETO A 'admin' em vez de passar pela tabela COBERTURA
 * de src/lib/guarda.ts, e a diferenca e deliberada: COBERTURA responde "este
 * papel alcanca aquele?" para rotas que aceitam mais de um papel (vendedor E
 * admin em /api/vendas-presenciais). O painel nao e uma dessas: §17 e a visao
 * do dono da empresa — faturamento, lista de contatos, base de compradores — e
 * o unico papel que a alcanca e 'admin'. `exigirPapel` tambem nao serviria
 * aqui por um motivo mecanico: ele exige uma `Request`, que Server Component
 * nenhum recebe.
 *
 * VENDEDOR AUTENTICADO TAMBEM VAI PARA /entrar, e nao para uma tela de "acesso
 * negado". Ele tem sessao valida, so nao tem esta porta; a tela dele e /venda
 * (§10). Mandar para /entrar e o que o plano pede e e o comportamento seguro —
 * mas ATENCAO PARA QUEM MEXER EM /entrar: se aquela pagina um dia redirecionar
 * quem ja tem sessao de volta para /admin, um vendedor entra em laco de
 * redirect entre as duas. Quando /entrar ganhar esse atalho, ele precisa
 * mandar o vendedor para /venda, nunca para /admin.
 *
 * SEM `?destino=`: nenhuma sessao aberta significa que nao ha para onde voltar
 * com seguranca, e um parametro de destino lido de URL e a materia-prima de
 * redirect aberto. Depois de entrar, o administrador clica na secao que quer.
 */
export async function exigirSessaoDeAdmin(): Promise<Usuario> {
  const usuario = await usuarioDaSessaoNoServidor()

  // Sem sessao, sessao expirada, sessao revogada, usuario desativado e sessao
  // de vendedor caem todos aqui — a mesma porta, pelo mesmo raciocinio de
  // `autenticar` (src/repositories/usuarios.ts): distinguir os motivos numa
  // tela publica so conta a quem nao entrou o que existe do outro lado.
  if (usuario === null || usuario.papel !== 'admin') {
    redirect('/entrar')
  }

  return usuario
}
