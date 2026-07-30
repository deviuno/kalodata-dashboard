/**
 * Cookie jar do Kalodata — mantém `cookies.txt` vivo sozinho.
 *
 * PROBLEMA QUE ISSO RESOLVE
 * O servidor mandava os cookies em toda chamada (`curl -b`) mas ignorava o
 * `Set-Cookie` da resposta. Como o Kalodata renova a sessão a cada request
 * (mesmo comportamento que a extensão Cookie Sync explora no "ping ativo"),
 * jogávamos fora a renovação e a sessão envelhecia até morrer. A única coisa
 * que a trazia de volta era o Chrome do dono rodando a extensão — se a máquina
 * estivesse desligada, a sessão caía e as listagens congelavam no cache.
 *
 * COMO FUNCIONA
 * Cada chamada passa a gravar os headers de resposta (`curl --dump-header`) num
 * arquivo temporário. `absorbHeaderDump()` lê esse arquivo, extrai os
 * `Set-Cookie` e faz merge no `cookies.txt`. Cookie apagado pelo servidor
 * (`Max-Age=0` ou `expires` no passado) sai do jar.
 *
 * Tudo síncrono de propósito: o merge é read-modify-write e o event loop do
 * Node é single-threaded, então duas chamadas concorrentes não conseguem
 * intercalar leitura e escrita.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const COOKIE_FILE = 'cookies.txt'

let seq = 0

/** Caminho único pro dump de headers desta chamada. */
export function newHeaderDumpPath () {
  seq = (seq + 1) % 1_000_000
  return join(tmpdir(), `kalo-hdr-${process.pid}-${seq}.txt`)
}

/** Args de curl que gravam os headers da resposta no arquivo. */
export function headerDumpArgs (file) {
  return ['--dump-header', file]
}

/** "NAME=VALUE; Path=/; Max-Age=0" → { name, value, deleted }. */
function parseSetCookie (line) {
  const parts = line.split(';')
  const first = parts.shift() ?? ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (!name) return null

  let deleted = false
  for (const raw of parts) {
    const [k, v = ''] = raw.split('=')
    const key = k.trim().toLowerCase()
    if (key === 'max-age' && Number(v.trim()) <= 0) deleted = true
    if (key === 'expires') {
      const t = Date.parse(v.trim())
      if (Number.isFinite(t) && t <= Date.now()) deleted = true
    }
  }
  // Servidor também apaga cookie mandando valor vazio.
  if (value === '' || value === '""' || value.toLowerCase() === 'deleted') deleted = true
  return { name, value, deleted }
}

/** Extrai os Set-Cookie de um dump de headers (aceita várias respostas). */
export function parseHeaderDump (text) {
  const out = []
  for (const rawLine of String(text).split(/\r?\n/)) {
    const m = rawLine.match(/^set-cookie:\s*(.+)$/i)
    if (!m) continue
    const parsed = parseSetCookie(m[1])
    if (parsed) out.push(parsed)
  }
  return out
}

/** "a=1; b=2" → Map preservando a ordem original. */
function parseCookieHeader (str) {
  const map = new Map()
  for (const piece of String(str).split(';')) {
    const s = piece.trim()
    if (!s) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    map.set(s.slice(0, eq).trim(), s.slice(eq + 1).trim())
  }
  return map
}

function serialize (map) {
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * Aplica os Set-Cookie no jar atual e devolve a string resultante.
 * Exportada separada da leitura de arquivo pra poder ser testada.
 */
export function mergeCookies (current, setCookies) {
  const map = parseCookieHeader(current)
  let changed = 0
  for (const c of setCookies) {
    if (c.deleted) {
      if (map.delete(c.name)) changed++
      continue
    }
    if (map.get(c.name) !== c.value) changed++
    map.set(c.name, c.value)
  }
  return { cookies: serialize(map), changed }
}

/**
 * Lê o dump, faz merge no cookies.txt e apaga o arquivo. Nunca lança: cookie
 * jar é oportunista, uma falha aqui não pode derrubar a chamada de dados.
 * Devolve quantos cookies mudaram (0 quando não havia nada a fazer).
 */
export function absorbHeaderDump (file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return 0
  } finally {
    try { unlinkSync(file) } catch { /* ignore */ }
  }

  try {
    const setCookies = parseHeaderDump(text)
    if (setCookies.length === 0) return 0

    let current = ''
    try { current = readFileSync(COOKIE_FILE, 'utf-8').trim() } catch { /* jar vazio */ }
    if (!current) return 0 // sem sessão base, não inventa uma

    const { cookies, changed } = mergeCookies(current, setCookies)
    if (changed > 0 && cookies) {
      writeFileSync(COOKIE_FILE, cookies + '\n', 'utf-8')
      console.log(`[cookie-jar] sessão renovada pelo upstream (${changed} cookie(s))`)
    }
    return changed
  } catch (e) {
    console.warn('[cookie-jar] falha ao absorver Set-Cookie:', e?.message)
    return 0
  }
}
