// Testes de lib/curl-seguro.js. Sem dependência extra: `node --test lib/curl-seguro.test.js`.
// O último bloco sobe um servidor HTTP local e roda o `curl` do sistema contra
// ele, para provar que `-K arquivo` manda o mesmo Cookie que `-b <valor>` e que o
// segredo some da mensagem de erro. Sem `curl` no PATH, esse bloco é pulado.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CORPO_DE_FALHA,
  SEM_GLOBBING,
  configComSegredo,
  responderFalha,
  resumoDoErro,
  textoDeConfig,
  valorDeConfig,
} from './curl-seguro.js'

test('valorDeConfig escapa barra e aspas e tira quebra de linha', () => {
  assert.equal(valorDeConfig('a=1; b=2'), '"a=1; b=2"')
  assert.equal(valorDeConfig('a="x"'), '"a=\\"x\\""')
  assert.equal(valorDeConfig('a=\\b'), '"a=\\\\b"')
  assert.equal(valorDeConfig('a=1\r\nproxy = "http://mau"'), '"a=1 proxy = \\"http://mau\\""')
})

test('textoDeConfig deixa de fora o que veio vazio', () => {
  assert.equal(textoDeConfig({}), '')
  assert.equal(textoDeConfig({ cookie: '  ', proxy: null, headers: ['', null] }), '')
  assert.equal(
    textoDeConfig({ cookie: 's=1', proxy: 'http://u:p@h:1', headers: ['authorization: Bearer t'] }),
    'cookie = "s=1"\nproxy = "http://u:p@h:1"\nheader = "authorization: Bearer t"\n',
  )
})

test('configComSegredo grava 0600, devolve -K e apaga no limpar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curl-seguro-'))
  try {
    const cfg = configComSegredo({ cookie: 'sessao=abc' }, dir)
    assert.equal(cfg.args[0], '-K')
    const caminho = cfg.args[1]
    assert.ok(caminho.startsWith(dir))
    assert.equal(readFileSync(caminho, 'utf-8'), 'cookie = "sessao=abc"\n')
    assert.equal(statSync(caminho).mode & 0o777, 0o600)
    cfg.limpar()
    assert.equal(existsSync(caminho), false)
    cfg.limpar() // segunda vez não lança
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('configComSegredo sem segredo não cria arquivo', () => {
  const cfg = configComSegredo({ cookie: '' })
  assert.deepEqual(cfg.args, [])
  cfg.limpar()
})

test('resumoDoErro fica na primeira linha e corta', () => {
  assert.equal(resumoDoErro(new Error('linha 1\nlinha 2')), 'linha 1')
  assert.equal(resumoDoErro('x'.repeat(500)).length, 300)
  assert.equal(resumoDoErro(null), '')
})

test('responderFalha manda o corpo fixo, sem a mensagem original', () => {
  let status = 0
  let corpo = null
  const res = {
    req: { path: '/api/product/1/detail' },
    status (s) { status = s; return this },
    json (c) { corpo = c; return this },
  }
  const original = console.error
  console.error = () => {}
  try {
    responderFalha(res, new Error('Command failed: curl -b segredo=1'))
  } finally {
    console.error = original
  }
  assert.equal(status, 500)
  assert.deepEqual(corpo, CORPO_DE_FALHA)
  assert.ok(!JSON.stringify(corpo).includes('segredo'))
})

function temCurl () {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('curl de verdade: -K manda o mesmo Cookie que -b, e -g aceita colchete', { skip: !temCurl() }, async () => {
  const recebidos = []
  const servidor = createServer((req, res) => {
    recebidos.push({ url: req.url, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null })
    res.end('ok')
  })
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  const porta = servidor.address().port
  const base = `http://127.0.0.1:${porta}`
  const cookie = 'sessao=abc123; cf_clearance=x.y-z_1; outro="aspas"'
  const curl = (args) =>
    new Promise((resolve, reject) => {
      // Assíncrono: o servidor roda no mesmo processo e precisa do event loop livre.
      import('node:child_process').then(({ execFile }) =>
        execFile('curl', args, { encoding: 'utf-8' }, (err, out) => (err ? reject(err) : resolve(out))),
      )
    })
  try {
    await curl(['-s', '-q', '-b', cookie, `${base}/a`])
    const cfg = configComSegredo({ cookie, headers: ['authorization: Bearer tok'] })
    try {
      await curl(['-s', '-q', SEM_GLOBBING, ...cfg.args, `${base}/b/[`])
    } finally {
      cfg.limpar()
    }
    assert.equal(recebidos.length, 2)
    assert.equal(recebidos[1].cookie, recebidos[0].cookie)
    assert.equal(recebidos[1].auth, 'Bearer tok')
    assert.equal(recebidos[1].url, '/b/[')

    // Sem -g o mesmo path falha no globbing, e a mensagem de erro traz os args:
    // com o segredo no arquivo, o cookie não aparece nela.
    const cfg2 = configComSegredo({ cookie })
    let mensagem = ''
    try {
      await curl(['-s', '-q', ...cfg2.args, `${base}/c/[`])
    } catch (e) {
      mensagem = String(e.message)
    } finally {
      cfg2.limpar()
    }
    assert.ok(mensagem.includes('Command failed'), 'o curl deveria falhar sem -g')
    assert.ok(!mensagem.includes('abc123'), 'o cookie não pode aparecer no erro')
  } finally {
    servidor.close()
  }
})
