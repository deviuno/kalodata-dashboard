// Testes da cota de detalhes. Sem dependência extra: `node --test lib/cota.test.js`.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAUSA_SEM_COTA,
  RESERVA_CRM,
  RESERVA_LINHA,
  TETO_CRM_POR_CICLO,
  corpoDeRecusa,
  criarCota,
  falhaDaFonte,
  inicioDoCiclo,
  origemDoPedido,
  rotaComCota,
} from './cota.js'

const OK = { success: true, data: {} }
const SEM_COTA = {
  success: false,
  message: JSON.stringify({ message: "Today's detail times has been used up", cause: CAUSA_SEM_COTA }),
}
const emUtc = (texto) => Date.parse(`${texto}Z`)

function cotaComUso (usado, inicio = '2026-11-06T17:00:00') {
  let agora = emUtc(inicio)
  const cota = criarCota(() => agora)
  cota.registrarLeitura({ total: 500, used: usado })
  return { cota, avancar: (ms) => { agora += ms }, irPara: (texto) => { agora = emUtc(texto) } }
}

test('o ciclo vira às 16:00 UTC', () => {
  assert.equal(inicioDoCiclo(emUtc('2026-11-06T15:59:59')), emUtc('2026-11-05T16:00:00'))
  assert.equal(inicioDoCiclo(emUtc('2026-11-06T16:00:00')), emUtc('2026-11-06T16:00:00'))
  assert.equal(inicioDoCiclo(emUtc('2026-11-07T03:00:00')), emUtc('2026-11-06T16:00:00'))
})

test('rotaComCota reconhece só as rotas de detalhe', () => {
  assert.deepEqual(rotaComCota('/api/creator/123/detail'), { rota: 'creator/detail', item: 'creator:123' })
  assert.deepEqual(rotaComCota('/api/product/9/videos'), { rota: 'product/videos', item: 'product:9' })
  assert.equal(rotaComCota('/api/video/9/url'), null)
  assert.equal(rotaComCota('/api/product/9/images'), null)
  assert.equal(rotaComCota('/api/product/9/analysis'), null)
  assert.equal(rotaComCota('/api/creators'), null)
  assert.equal(rotaComCota('/api/creator/search/total'), null)
})

test('origemDoPedido cai em pagina quando o cabeçalho falta ou é estranho', () => {
  assert.equal(origemDoPedido(undefined), 'pagina')
  assert.equal(origemDoPedido('CRM'), 'crm')
  assert.equal(origemDoPedido('x y'), 'pagina')
})

test('a recusa tem o formato da fonte, para o CRM parar sem mudança', () => {
  const corpo = corpoDeRecusa('crm')
  assert.equal(corpo.success, false)
  assert.match(corpo.message, /DETAIL\.ACCESS_TIMES/)
})

test('o CRM para quando resta a reserva dele', () => {
  const { cota } = cotaComUso(500 - RESERVA_CRM - 1)
  assert.equal(cota.decidir('crm', 'creator:1').permitido, true)
  cota.registrarResposta('crm', 'creator:1', OK)
  assert.deepEqual(cota.decidir('crm', 'creator:2'), { permitido: false, reserva: 'crm' })
  assert.equal(cota.resumo().recusas.crm, 1)
})

test('o CRM para no teto do ciclo mesmo com cota sobrando', () => {
  const { cota } = cotaComUso(0)
  for (let i = 0; i < TETO_CRM_POR_CICLO; i++) cota.registrarResposta('crm', `creator:${i}`, OK)
  assert.deepEqual(cota.decidir('crm', 'creator:novo'), { permitido: false, reserva: 'crm' })
  assert.equal(cota.decidir('pagina', 'creator:novo').permitido, true)
})

test('chamada por linha e refresh de fundo param na reserva, página e chat seguem', () => {
  const { cota } = cotaComUso(500 - RESERVA_LINHA)
  assert.deepEqual(cota.decidir('linha', 'product:1'), { permitido: false, reserva: 'linha' })
  assert.deepEqual(cota.decidir('fundo', 'product:1'), { permitido: false, reserva: 'linha' })
  assert.equal(cota.decidir('pagina', 'product:1').permitido, true)
  assert.equal(cota.decidir('kit', 'product:1').permitido, true)
})

test('item já aberto no ciclo passa, porque não gasta de novo', () => {
  const { cota } = cotaComUso(10)
  cota.registrarResposta('pagina', 'product:1', OK)
  cota.registrarLeitura({ total: 500, used: 500 })
  assert.equal(cota.decidir('linha', 'product:1').permitido, true)
  assert.equal(cota.decidir('crm', 'product:1').permitido, true)
  assert.equal(cota.decidir('linha', 'product:2').permitido, false)
})

test('itens novos somam entre leituras, e repetir não soma', () => {
  const { cota } = cotaComUso(10)
  cota.registrarResposta('linha', 'product:1', OK)
  cota.registrarResposta('pagina', 'product:1', OK)
  cota.registrarResposta('pagina', 'video:1', OK)
  const r = cota.resumo()
  assert.equal(r.usado, 12)
  assert.equal(r.restante, 488)
  assert.deepEqual(r.porOrigem, { linha: 1, pagina: 1 })
})

test('a leitura seguinte corrige a soma', () => {
  const { cota } = cotaComUso(10)
  cota.registrarResposta('linha', 'product:1', OK)
  cota.registrarLeitura({ total: 500, used: 40 })
  assert.equal(cota.resumo().usado, 40)
})

test('resposta de cota zerada marca esgotada até a próxima leitura', () => {
  const { cota } = cotaComUso(300)
  assert.equal(cota.registrarResposta('pagina', 'product:1', SEM_COTA).novo, false)
  assert.equal(cota.restante(), 0)
  assert.equal(cota.decidir('crm', 'creator:1').permitido, false)
  cota.registrarLeitura({ total: 500, used: 300 })
  assert.equal(cota.restante(), 200)
})

test('falha comum não conta como item aberto', () => {
  const { cota } = cotaComUso(10)
  assert.equal(cota.registrarResposta('pagina', 'product:1', { success: false, message: 'erro' }).novo, false)
  assert.equal(cota.resumo().usado, 10)
})

test('a virada zera o ciclo e pede leitura', () => {
  const { cota, irPara } = cotaComUso(500)
  cota.registrarResposta('crm', 'creator:1', OK)
  irPara('2026-11-07T16:00:01')
  const r = cota.resumo()
  assert.equal(r.usado, null)
  assert.equal(r.restante, null)
  assert.deepEqual(r.porOrigem, {})
  assert.equal(cota.decidir('crm', 'creator:1').permitido, true)
  assert.equal(cota.precisaLer(), true)
})

test('sem nenhuma leitura o portão deixa passar', () => {
  const cota = criarCota(() => emUtc('2026-11-06T17:00:00'))
  assert.equal(cota.decidir('crm', 'creator:1').permitido, true)
  assert.equal(cota.decidir('linha', 'product:1').permitido, true)
})

test('leitura ruim é ignorada', () => {
  const { cota } = cotaComUso(10)
  assert.equal(cota.registrarLeitura(null), false)
  assert.equal(cota.registrarLeitura({ total: null, used: 3 }), false)
  assert.equal(cota.resumo().usado, 10)
})

test('só volta à fonte perto do fim e no máximo 1 vez por minuto', () => {
  const longe = cotaComUso(100)
  longe.avancar(10 * 60 * 1000)
  assert.equal(longe.cota.precisaLer(), false)

  const perto = cotaComUso(350)
  assert.equal(perto.cota.precisaLer(), false)
  perto.avancar(61 * 1000)
  assert.equal(perto.cota.precisaLer(), true)
  perto.cota.marcarTentativaDeLeitura()
  perto.avancar(30 * 1000)
  assert.equal(perto.cota.precisaLer(), false)
})

test('falhaDaFonte: sem cota responde 200 com a causa, para o proxy reconhecer', () => {
  const message = JSON.stringify({ cause: CAUSA_SEM_COTA })
  assert.deepEqual(falhaDaFonte({ success: false, message }, 'padrao'), {
    status: 200,
    corpo: { success: false, data: null, message },
  })
})

test('falhaDaFonte: outra falha segue 502', () => {
  assert.equal(falhaDaFonte({ success: false, message: 'empty body' }, 'padrao').status, 502)
  assert.equal(falhaDaFonte({ success: false, message: 'empty body' }, 'padrao').corpo.message, 'empty body')
  assert.equal(falhaDaFonte(null, 'padrao').corpo.message, 'padrao')
})
