// Testes de lib/chave-admin.js. Sem dependência extra: `node --test lib/chave-admin.test.js`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chaveConfere, chaveDoPedido } from './chave-admin.js'

test('chave certa confere, com ou sem espaço nas pontas', () => {
  assert.equal(chaveConfere('segredo-123', 'segredo-123'), true)
  assert.equal(chaveConfere(' segredo-123\n', 'segredo-123 '), true)
})

test('chave errada, prefixo ou de outro tamanho não confere', () => {
  assert.equal(chaveConfere('segredo-123', 'segredo-124'), false)
  assert.equal(chaveConfere('segredo-123', 'segredo'), false)
  assert.equal(chaveConfere('segredo-123', 'segredo-1234'), false)
})

test('chave esperada vazia nunca confere (fecha, não abre)', () => {
  assert.equal(chaveConfere('', ''), false)
  assert.equal(chaveConfere('', 'qualquer'), false)
  assert.equal(chaveConfere('   ', '   '), false)
  assert.equal(chaveConfere(undefined, 'x'), false)
  assert.equal(chaveConfere(null, null), false)
})

test('chave recebida vazia ou que não é texto não confere', () => {
  assert.equal(chaveConfere('segredo', ''), false)
  assert.equal(chaveConfere('segredo', undefined), false)
  assert.equal(chaveConfere('segredo', ['segredo']), false)
})

test('chaveDoPedido só aceita o header como texto único', () => {
  assert.equal(chaveDoPedido({ headers: { 'x-admin-key': 'abc' } }), 'abc')
  assert.equal(chaveDoPedido({ headers: { 'x-admin-key': ['abc', 'def'] } }), '')
  assert.equal(chaveDoPedido({ headers: {} }), '')
  assert.equal(chaveDoPedido(undefined), '')
})
