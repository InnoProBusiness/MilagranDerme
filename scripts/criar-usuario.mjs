#!/usr/bin/env node
/**
 * Cria (ou atualiza a senha de) um operador do painel administrativo e do
 * balcao do evento.
 *
 *   npm run usuario:criar -- --nome "Marcos" --email admin@exemplo.com --papel admin
 *
 * A SENHA NAO E ACEITA POR ARGUMENTO, de proposito. Argumento de linha de
 * comando fica no histórico do shell (~/.bash_history) e aparece na lista de
 * processos para qualquer usuario da maquina enquanto o comando roda — numa
 * VPS compartilhada com outras seis stacks isso e um vazamento real. A senha e
 * lida do terminal com o eco desligado.
 *
 * POR QUE UM SCRIPT E NAO UMA MIGRATION: senha em SQL versionado fica no
 * historico do git para sempre, inclusive depois de trocada. E por que nao uma
 * rota HTTP: um endpoint que cria administrador e exatamente a porta que um
 * painel administrativo existe para nao ter.
 *
 * DUPLICACAO CONSCIENTE: este arquivo e .mjs e roda por `node` puro (sem
 * transpilar), entao ele NAO consegue importar src/lib/senha.ts, que e
 * TypeScript. O formato do hash esta reimplementado aqui embaixo. Para que as
 * duas copias nao possam divergir em silencio, src/lib/__tests__/senha.test.ts
 * importa gerarHashDeSenha DESTE arquivo e prova que conferirSenha do modulo
 * TypeScript aceita o hash produzido aqui. Se alguem mudar o custo de um lado
 * so, aquele teste quebra.
 */
import { createInterface } from 'node:readline'
import { randomBytes, scrypt } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

// Mesmos valores de src/lib/senha.ts. Ver o comentario de duplicacao acima.
const ALGORITMO = 'scrypt'
const CUSTO_N = 16384
const BLOCO_R = 8
const PARALELISMO_P = 1
const BYTES_SALT = 16
const BYTES_HASH = 32
const MAX_MEM_BYTES = 64 * 1024 * 1024

const PAPEIS = ['admin', 'vendedor']

/**
 * Exportada para que o teste em src/lib/__tests__/senha.test.ts possa provar
 * que o hash gerado aqui e aceito por conferirSenha de src/lib/senha.ts.
 */
export function gerarHashDeSenha(senha) {
  const salt = randomBytes(BYTES_SALT)
  return new Promise((resolver, rejeitar) => {
    scrypt(
      senha.normalize('NFC'),
      salt,
      BYTES_HASH,
      { N: CUSTO_N, r: BLOCO_R, p: PARALELISMO_P, maxmem: MAX_MEM_BYTES },
      (erro, derivada) => {
        if (erro) return rejeitar(erro)
        resolver(
          [ALGORITMO, CUSTO_N, BLOCO_R, PARALELISMO_P,
            salt.toString('base64'), derivada.toString('base64')].join('$'),
        )
      },
    )
  })
}

function lerArgumentos(argv) {
  const valores = {}
  for (let i = 0; i < argv.length; i += 1) {
    const atual = argv[i]
    if (!atual.startsWith('--')) continue
    const chave = atual.slice(2)
    const proximo = argv[i + 1]
    if (proximo === undefined || proximo.startsWith('--')) {
      valores[chave] = 'true'
      continue
    }
    valores[chave] = proximo
    i += 1
  }
  return valores
}

/**
 * Le a senha com o eco desligado. Sem isto a senha fica visivel na tela e no
 * scrollback do terminal — e no dia do evento a tela do notebook do balcao
 * costuma estar virada para a fila.
 *
 * EXIGE TERMINAL DE VERDADE, e a checagem abaixo existe por causa de uma
 * falha silenciosa observada em 17/08/2026.
 *
 * Sem TTY, `leitor.question` simplesmente NUNCA chama o callback: a Promise
 * nao resolve, o event loop esvazia e o node encerra com codigo 0 — depois de
 * ter impresso o prompt. O comando parecia ter funcionado e nao criava
 * ninguem.
 *
 * Por que isso e uma armadilha do dia 25, e nao curiosidade: o DEPLOY.md manda
 * criar os operadores "de dentro do container", e `docker exec` SEM `-it` e
 * exatamente um stdin sem TTY. A pessoa rodaria o comando as 9h, leria a saida
 * como sucesso, e o vendedor descobriria que nao consegue entrar so quando a
 * fila ja estivesse formada — sem nenhuma mensagem de erro para investigar.
 *
 * Falhar aqui e ruidoso e imediato. O caminho NAO e aceitar a senha por pipe:
 * ela apareceria no historico do shell e nos logs do processo, que e
 * precisamente o que o eco desligado evita.
 */
function perguntarSenha(rotulo) {
  if (!process.stdin.isTTY) {
    falhar(
      'a senha precisa ser digitada num terminal de verdade, e a entrada atual nao e um.\n'
      + '       Se estiver usando docker exec, acrescente -it:\n'
      + '         docker exec -it <container> npm run usuario:criar -- --nome "..." --email ... --papel vendedor',
    )
  }

  return new Promise((resolver) => {
    const leitor = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const saida = process.stdout
    // O readline escreve cada tecla de volta; interceptar aqui e o unico jeito
    // sem dependencia externa. O `\n` final e emitido a mao porque o eco
    // suprimido tambem engole o Enter.
    const escreverOriginal = saida.write.bind(saida)
    let mascarando = false
    saida.write = (pedaco, ...resto) => {
      if (mascarando) return true
      return escreverOriginal(pedaco, ...resto)
    }
    escreverOriginal(rotulo)
    mascarando = true
    leitor.question('', (resposta) => {
      mascarando = false
      saida.write = escreverOriginal
      escreverOriginal('\n')
      leitor.close()
      resolver(resposta)
    })
  })
}

function falhar(mensagem) {
  console.error(`erro: ${mensagem}`)
  process.exit(1)
}

async function principal() {
  const args = lerArgumentos(process.argv.slice(2))

  const nome = (args.nome ?? '').trim()
  const email = (args.email ?? '').trim().toLowerCase()
  const papel = (args.papel ?? '').trim()

  if (nome.length < 3) falhar('informe --nome com pelo menos 3 caracteres')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) falhar('informe --email valido')
  if (!PAPEIS.includes(papel)) falhar(`--papel precisa ser um de: ${PAPEIS.join(', ')}`)

  // DIRECT_URL, nao DATABASE_URL: este script faz escrita administrativa
  // pontual, do mesmo lado em que as migrations rodam. Ver o comentario das
  // duas variaveis em .env.example.
  const conexao = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!conexao) falhar('DIRECT_URL (ou DATABASE_URL) nao configurada')

  const senha = await perguntarSenha(`Senha para ${email}: `)
  if (senha.length < 10) falhar('a senha precisa ter pelo menos 10 caracteres')
  const confirmacao = await perguntarSenha('Repita a senha: ')
  if (senha !== confirmacao) falhar('as senhas nao conferem')

  const senhaHash = await gerarHashDeSenha(senha)

  const cliente = new pg.Client({ connectionString: conexao })
  await cliente.connect()
  try {
    // ON CONFLICT no indice funcional usuario_email_unico (lower(email)):
    // rodar o comando de novo TROCA a senha em vez de estourar duplicidade, que
    // e exatamente o fluxo de "esqueci a senha do vendedor as 9h do dia 25".
    // `papel` e `nome` tambem sao atualizados; `ativo` volta a true, para que
    // reativar alguem seja o mesmo comando.
    const resultado = await cliente.query(
      `INSERT INTO usuarios (nome, email, senha_hash, papel, ativo)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (lower(email)) DO UPDATE
         SET nome = EXCLUDED.nome,
             senha_hash = EXCLUDED.senha_hash,
             papel = EXCLUDED.papel,
             ativo = true
       RETURNING id, (xmax = 0) AS criado`,
      [nome, email, senhaHash, papel],
    )
    const linha = resultado.rows[0]
    console.log(
      linha.criado
        ? `usuario criado: ${email} (${papel}), id ${linha.id}`
        : `senha atualizada: ${email} (${papel}), id ${linha.id}`,
    )

    // Trocar a senha tem que derrubar as sessoes abertas — senao um celular
    // perdido no evento continua logado depois de a senha ser rotacionada, que
    // e justamente o motivo de rotacionar.
    if (!linha.criado) {
      const revogadas = await cliente.query(
        `UPDATE sessoes SET revogada_em = now()
         WHERE usuario_id = $1 AND revogada_em IS NULL AND expira_em > now()`,
        [linha.id],
      )
      console.log(`sessoes ativas revogadas: ${revogadas.rowCount}`)
    }
  } finally {
    await cliente.end()
  }
}

// So executa quando chamado direto pela CLI. O teste que confere o formato do
// hash IMPORTA este arquivo, e sem esta guarda a importacao tentaria abrir
// conexao com o banco e ler senha do terminal — o teste travaria para sempre.
//
// pathToFileURL, e nao um template `file://${...}`: no Windows o caminho vem
// como C:\...\criar-usuario.mjs e a montagem manual produz uma URL que nunca
// bate com import.meta.url (barras invertidas, letra de unidade, escape de
// espaco no caminho). Este projeto e desenvolvido no Windows e roda em Linux.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((e) => falhar(e instanceof Error ? e.message : String(e)))
}
