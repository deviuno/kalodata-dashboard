// Conferência da chave de admin (`x-admin-key`). Auditoria de segurança de
// 14/11/2026, A12, e a revisão dela.
//
// Duas coisas que o `requireAdminKey` de server.js não fazia:
//   1. Comparar em tempo constante. O `!==` para no primeiro caractere diferente,
//      e o tempo da resposta conta quantos acertaram.
//   2. Fechar quando a chave não está configurada. O `requireAdminKey` deixa
//      passar com `admin_key` vazia (modo dev), e as rotas que gastam a conta
//      Kalodata (`/api/kalo`, `/api/probe-country`) ou abrem diagnóstico
//      (`/api/debug/*`) não podem ficar abertas por esquecimento no config.json.
import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * A chave recebida é a esperada? Chave esperada vazia nunca confere. Os dois
 * lados viram SHA-256 antes do `timingSafeEqual`, que exige o mesmo tamanho: assim
 * o tamanho da chave certa também não vaza.
 */
export function chaveConfere(esperada, recebida) {
  const e = typeof esperada === 'string' ? esperada.trim() : ''
  const r = typeof recebida === 'string' ? recebida.trim() : ''
  if (!e || !r) return false
  const he = createHash('sha256').update(e).digest()
  const hr = createHash('sha256').update(r).digest()
  return timingSafeEqual(he, hr)
}

/** O header pode chegar repetido (array no Node). Só vale o valor único. */
export function chaveDoPedido(req) {
  const h = req?.headers?.['x-admin-key']
  return typeof h === 'string' ? h : ''
}
