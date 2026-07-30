// Testes do cookie jar. Sem dependência extra: `node --test lib/cookie-jar.test.js`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeCookies, parseHeaderDump } from './cookie-jar.js'

test('parseHeaderDump extrai Set-Cookie ignorando o resto', () => {
  const dump = [
    'HTTP/2 200',
    'content-type: application/json',
    'set-cookie: SESSION=abc123; Path=/; HttpOnly; Secure',
    'Set-Cookie: cf_clearance=zzz; Path=/; Max-Age=3600',
    'x-outro: nada',
  ].join('\r\n')
  const out = parseHeaderDump(dump)
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { name: 'SESSION', value: 'abc123', deleted: false })
  assert.equal(out[1].name, 'cf_clearance')
})

test('mergeCookies atualiza o valor de um cookie existente', () => {
  const { cookies, changed } = mergeCookies('SESSION=velho; outro=1', [
    { name: 'SESSION', value: 'novo', deleted: false },
  ])
  assert.equal(cookies, 'SESSION=novo; outro=1')
  assert.equal(changed, 1)
})

test('mergeCookies acrescenta cookie novo no fim', () => {
  const { cookies } = mergeCookies('a=1', [{ name: 'b', value: '2', deleted: false }])
  assert.equal(cookies, 'a=1; b=2')
})

test('mergeCookies não marca mudança quando o valor é o mesmo', () => {
  const { changed } = mergeCookies('a=1', [{ name: 'a', value: '1', deleted: false }])
  assert.equal(changed, 0)
})

test('mergeCookies remove cookie apagado pelo servidor', () => {
  const { cookies, changed } = mergeCookies('a=1; b=2', [{ name: 'b', value: '', deleted: true }])
  assert.equal(cookies, 'a=1')
  assert.equal(changed, 1)
})

test('Max-Age=0 e expires no passado contam como remoção', () => {
  const dump = [
    'set-cookie: morto=x; Max-Age=0',
    'set-cookie: velho=y; expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'set-cookie: vivo=z; Max-Age=600',
  ].join('\n')
  const parsed = parseHeaderDump(dump)
  assert.equal(parsed.find((c) => c.name === 'morto').deleted, true)
  assert.equal(parsed.find((c) => c.name === 'velho').deleted, true)
  assert.equal(parsed.find((c) => c.name === 'vivo').deleted, false)

  const { cookies } = mergeCookies('morto=x; velho=y; outro=1', parsed)
  assert.equal(cookies, 'outro=1; vivo=z')
})

test('valor com "=" dentro é preservado inteiro', () => {
  const [c] = parseHeaderDump('set-cookie: tok=aaa=bbb==; Path=/')
  assert.equal(c.value, 'aaa=bbb==')
  const { cookies } = mergeCookies('tok=antigo', [c])
  assert.equal(cookies, 'tok=aaa=bbb==')
})

test('dump sem Set-Cookie não mexe no jar', () => {
  const { cookies, changed } = mergeCookies('a=1', parseHeaderDump('HTTP/2 200\r\nvary: origin'))
  assert.equal(cookies, 'a=1')
  assert.equal(changed, 0)
})
