/**
 * Quantos dias apos o pagamento confirmado a comissao passa de PENDENTE para
 * DISPONIVEL para saque.
 *
 * Trinta dias foi decisao do cliente, e cobre duas janelas distintas:
 *   - os 7 dias de arrependimento do art. 49 do CDC, contados do recebimento;
 *   - a janela em que o Mercado Pago ainda pode reter ou estornar a venda.
 *
 * A spec (secao 17) pede que a regra seja "configuravel da empresa". Com dez
 * representantes e uma politica unica, configuravel significa esta constante
 * mais um deploy — nao uma tabela de configuracao com tela propria, que
 * ninguem usaria e que precisaria de auditoria propria. Quando existirem
 * politicas diferentes por representante ou por campanha, o valor vira coluna
 * em `representantes` e esta constante vira o default.
 *
 * MUDAR ESTE NUMERO NAO REESCREVE O PASSADO: disponivel_em e gravado por
 * lancamento, no momento do credito. Um extrato que o representante ja viu
 * continua valendo o que valia — de proposito.
 */
export const DIAS_PARA_LIBERAR_COMISSAO = 30

const MS_POR_DIA = 24 * 60 * 60 * 1000

/**
 * Instante em que a comissao de um pedido pago em `pagoEm` fica disponivel.
 *
 * Trinta dias corridos de 24h, nao trinta dias civis em America/Sao_Paulo.
 * A diferenca so apareceria sob horario de verao (o Brasil nao observa desde
 * 2019) e, para uma janela de espera, o instante exato nao carrega significado
 * de calendario — diferente do agrupamento por mes do dashboard, que usa
 * src/lib/tempo.ts justamente porque ali o mes civil importa.
 */
export function liberacaoDaComissao(pagoEm: Date): Date {
  return new Date(pagoEm.getTime() + DIAS_PARA_LIBERAR_COMISSAO * MS_POR_DIA)
}
