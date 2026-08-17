/**
 * Tipos da superficie EXPORTADA de scripts/criar-usuario.mjs.
 *
 * O script e JavaScript puro de proposito: ele roda por `node scripts/...`
 * direto, sem passo de build, para que criar um administrador as 9h do dia do
 * evento nao dependa de transpilar nada. Como o projeto tem `allowJs: false`,
 * o import dele em src/lib/__tests__/senha.test.ts precisa desta declaracao.
 *
 * SO `gerarHashDeSenha` e declarada. O resto do script (leitura de senha do
 * terminal, conexao com o banco, INSERT) e privado por escolha: o unico motivo
 * de o teste importar este arquivo e provar que o hash gerado aqui e aceito por
 * `conferirSenha` de src/lib/senha.ts. Declarar mais superficie convidaria
 * alguem a chamar o resto de dentro da aplicacao, que e exatamente o que o
 * cabecalho do script explica que nao pode acontecer.
 */
export declare function gerarHashDeSenha(senha: string): Promise<string>
