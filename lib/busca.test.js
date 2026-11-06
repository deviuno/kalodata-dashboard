import test from 'node:test'
import assert from 'node:assert/strict'
import { cortarNaBusca, pedidoDaLista, tamanhoNaFonte, termoDaBusca } from './busca.js'

test('termo: limpa espaço e arroba, e ignora pedaço curto', () => {
  assert.equal(termoDaBusca('  PERFUME '), 'PERFUME')
  assert.equal(termoDaBusca('@rodrigovillarrv'), 'rodrigovillarrv')
  assert.equal(termoDaBusca('a'), '')
  assert.equal(termoDaBusca(undefined), '')
  assert.equal(termoDaBusca('x'.repeat(150)).length, 100)
})

test('pedido: sem termo segue no ranking de sempre', () => {
  assert.deepEqual(pedidoDaLista('product', ''), { path: '/product/queryList', filtro: {} })
})

test('pedido: com termo vai para a busca, e vídeo usa title', () => {
  assert.deepEqual(pedidoDaLista('product', 'perfume'), { path: '/product/searchList', filtro: { query: 'perfume' } })
  assert.deepEqual(pedidoDaLista('video', 'perfume'), { path: '/video/searchList', filtro: { title: 'perfume' } })
  assert.deepEqual(pedidoDaLista('creator', 'rodrigo'), { path: '/creator/searchList', filtro: { query: 'rodrigo' } })
  assert.deepEqual(pedidoDaLista('shop', 'mawwal'), { path: '/shop/searchList', filtro: { query: 'mawwal' } })
})

test('tamanho: só a busca sobe para o mínimo da fonte', () => {
  assert.equal(tamanhoNaFonte(3, 'perfume'), 10)
  assert.equal(tamanhoNaFonte(60, 'perfume'), 60)
  assert.equal(tamanhoNaFonte(3, ''), 3)
})

test('corte: devolve só o pedido, e só na busca', () => {
  assert.equal(cortarNaBusca({ data: [1, 2, 3, 4] }, 3, 'perfume').data.length, 3)
  assert.equal(cortarNaBusca({ data: [1, 2, 3, 4] }, 3, '').data.length, 4)
  assert.equal(cortarNaBusca({ data: null }, 3, 'perfume').data, null)
})
