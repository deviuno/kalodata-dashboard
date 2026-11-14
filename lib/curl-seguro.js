// Segredos fora da linha de comando do curl, e erro de rota sem detalhe.
//
// POR QUE ISTO EXISTE (auditoria de segurança de 14/11/2026, A12)
// O curl recebia o cookie da conta Kalodata em `-b <cookies>`, o proxy com
// usuário e senha em `-x user:pass@host` e o token da Kalowave num `-H`. Quando o
// curl falha, o `execFileSync` lança `Command failed: <arquivo e TODOS os args>`,
// e as rotas devolviam esse `e.message` ao cliente. Bastava um `[` no path (o curl
// faz globbing de URL por padrão e um `[` sem par dá erro na hora) ou uma queda de
// rede para a resposta trazer a sessão da conta da empresa.
//
// O conserto tem três partes, todas aqui:
//   1. `-g` (globoff) em toda chamada que monta URL com pedaço vindo de fora.
//   2. Cookie, proxy e cabeçalho com segredo vão num arquivo de config do curl
//      (`-K arquivo`, modo 0600, apagado no fim). O efeito é o mesmo de passar a
//      opção na linha de comando, mas o segredo não aparece em `ps` nem no
//      `e.message`.
//   3. Rota que falha responde só `upstream_error`. O detalhe fica no log da VPS.
//
// Sem dependência: `node --test lib/curl-seguro.test.js`.
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

/** Desliga o globbing de URL do curl (`[`, `]`, `{`, `}` passam como texto). */
export const SEM_GLOBBING = '-g'

/** Corpo fixo de falha das rotas. Nada do erro original vai ao cliente. */
export const MENSAGEM_DE_FALHA = 'upstream_error'
export const CORPO_DE_FALHA = Object.freeze({ success: false, message: MENSAGEM_DE_FALHA })

/**
 * Valor entre aspas no formato do arquivo de config do curl. Dentro das aspas o
 * curl interpreta `\\` e `\"`, então os dois são escapados. Quebra de linha
 * encerraria a opção e abriria outra: vira espaço.
 */
export function valorDeConfig (valor) {
  const s = String(valor ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
  return `"${s}"`
}

/**
 * Texto do arquivo de config para as opções com segredo. Opção vazia fica de
 * fora, como quando a chamada não passava a flag.
 *   cookie  → equivale a `-b <valor>`
 *   proxy   → equivale a `-x <valor>`
 *   headers → cada um equivale a `-H <valor>`
 */
export function textoDeConfig ({ cookie, proxy, headers } = {}) {
  const linhas = []
  if (cookie && String(cookie).trim()) linhas.push(`cookie = ${valorDeConfig(String(cookie).trim())}`)
  if (proxy && String(proxy).trim()) linhas.push(`proxy = ${valorDeConfig(String(proxy).trim())}`)
  for (const h of headers || []) {
    if (h && String(h).trim()) linhas.push(`header = ${valorDeConfig(String(h).trim())}`)
  }
  return linhas.length ? linhas.join('\n') + '\n' : ''
}

let seq = 0

/**
 * Grava as opções com segredo num arquivo temporário (0600) e devolve os args
 * (`['-K', caminho]`, ou `[]` se não há nada a esconder) e a função que apaga o
 * arquivo. Chame `limpar()` no `finally`, depois que o curl terminou.
 */
export function configComSegredo (opcoes = {}, dir = tmpdir()) {
  const texto = textoDeConfig(opcoes)
  if (!texto) return { args: [], limpar () {} }
  seq = (seq + 1) % 1_000_000
  // Nome imprevisível: outro processo da máquina não adivinha o arquivo.
  const caminho = join(dir, `kalo-cfg-${process.pid}-${seq}-${randomBytes(6).toString('hex')}.conf`)
  writeFileSync(caminho, texto, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  return {
    args: ['-K', caminho],
    limpar () {
      try { unlinkSync(caminho) } catch { /* já saiu */ }
    },
  }
}

/** Resumo do erro para o log da VPS: só a primeira linha, cortada. */
export function resumoDoErro (e) {
  const msg = e && typeof e === 'object' && 'message' in e ? e.message : e
  return String(msg ?? '').split('\n')[0].slice(0, 300)
}

/**
 * Responde a falha de uma rota sem expor o erro. O log diz qual rota falhou e o
 * começo da mensagem (sem segredo, porque eles saíram da linha de comando).
 */
export function responderFalha (res, e, status = 500) {
  const rota = res?.req?.path || '?'
  console.error(`[falha] ${rota}: ${resumoDoErro(e)}`)
  return res.status(status).json(CORPO_DE_FALHA)
}
