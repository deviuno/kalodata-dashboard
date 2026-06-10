import express from 'express'
import cors from 'cors'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { Resend } from 'resend'
import cron from 'node-cron'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { headersForCountry, parseCountry, countryLowercase, DEFAULT_COUNTRY, COUNTRY_CONFIG } from './lib/countries.js'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = parseInt(process.env.PORT) || 4001
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// Proxy pool (Tarefa 1)
// ---------------------------------------------------------------------------
// Lê PROXY_LIST (vírgulas) ou PROXY_URL (único/rotativo) do ambiente.
// Formato esperado: http://user:pass@host:port
// Se vazio, funciona sem proxy (comportamento original).
// ---------------------------------------------------------------------------
const PROXY_URLS = (() => {
  if (process.env.PROXY_LIST) {
    return process.env.PROXY_LIST.split(',').map(p => p.trim()).filter(Boolean)
  }
  if (process.env.PROXY_URL) {
    return [process.env.PROXY_URL.trim()]
  }
  return []
})()

let _proxyIdx = 0

/** Retorna o próximo proxy da pool (round-robin), ou null se não configurado. */
function getNextProxy () {
  if (PROXY_URLS.length === 0) return null
  const proxy = PROXY_URLS[_proxyIdx % PROXY_URLS.length]
  _proxyIdx++
  return proxy
}

/** Monta os args de proxy para curl: ['-x', 'url'] ou []. */
function proxyCurlArgs (proxy) {
  return proxy ? ['-x', proxy] : []
}

/** Jitter aleatório em ms para backoff gentil. */
function jitter (base = 1000, spread = 1000) {
  return base + Math.floor(Math.random() * spread)
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Paginação acumuladora para endpoints de ranking (Tarefa 2 — revisado)
// ---------------------------------------------------------------------------
// kaloPostPaginated: busca páginas upstream (page=1,2,3,...) até atingir
// targetCount itens ou receber página vazia/incompleta.
// Cada página usa um proxy rotativo com backoff+jitter entre chamadas.
// Para endpoints que já retornam tudo numa página (products/videos/shops),
// basta targetCount > upstreamPageSize — para na 1ª página cheia.
// ---------------------------------------------------------------------------

/**
 * Extrai a lista de itens de uma resposta kaloPost.
 * A API devolve { data: [...], success, ... } ou { list: [...] } ou similar.
 */
function extractItems (data) {
  if (!data) return []
  if (Array.isArray(data.data)) return data.data
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.items)) return data.items
  return []
}

/**
 * Deduplica por campo 'id' (mantém primeiro ocorrência) e reordena desc por 'revenue'.
 */
function dedupeAndSort (items) {
  const seen = new Set()
  const unique = items.filter(item => {
    const key = item?.id ?? item?.creator_id ?? item?.product_id ?? JSON.stringify(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // Reordena por revenue desc (campo pode ser number ou string monetário)
  unique.sort((a, b) => {
    const ra = parseFloat(String(a?.revenue ?? 0).replace(/[^0-9.]/g, '')) || 0
    const rb = parseFloat(String(b?.revenue ?? 0).replace(/[^0-9.]/g, '')) || 0
    return rb - ra
  })
  return unique
}

/**
 * Faz paginação acumuladora no kalodata upstream.
 *
 * @param {string} path             - caminho da API upstream (ex: '/creator/queryList')
 * @param {function} bodyFn         - (pageNo) => objeto de body para kaloPost
 * @param {string} country          - código de país
 * @param {object} opts
 *   @param {number} targetCount    - mínimo de itens para parar (padrão: 55)
 *   @param {number} upstreamPageSize - itens por página upstream (padrão: 60)
 *   @param {number} maxPages       - máximo de páginas a buscar (padrão: 8)
 *   @param {number} baseDelay      - delay base em ms entre páginas (padrão: 1200)
 *   @param {boolean} needsSort     - se deve reordenar por revenue desc (padrão: false)
 */
async function kaloPostPaginated (path, bodyFn, country, opts = {}) {
  const {
    targetCount    = 55,
    upstreamPageSize = 60,
    maxPages       = 8,
    baseDelay      = 1200,
    needsSort      = false,
  } = opts

  let accumulated = []
  let templateResponse = null

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const proxy = getNextProxy()
    try {
      const body = bodyFn(pageNo)
      const data = kaloPost(path, body, country, proxy)
      const items = extractItems(data)
      const count = items.length

      console.log(`[paginate] ${path} page=${pageNo} proxy=${proxy ? proxy.replace(/:[^:@]*@/, ':***@') : 'none'} items=${count}`)

      if (pageNo === 1) templateResponse = data  // guarda shape da 1ª resposta

      if (count === 0) {
        console.log(`[paginate] ${path} page=${pageNo} returned empty — stopping`)
        break
      }

      accumulated.push(...items)

      // Para se a página veio incompleta (upstream não tem mais) OU atingiu o alvo
      if (count < upstreamPageSize || accumulated.length >= targetCount) break

    } catch (err) {
      console.warn(`[paginate] ${path} page=${pageNo} error: ${err.message} — stopping`)
      break
    }

    if (pageNo < maxPages) {
      await sleep(jitter(baseDelay, Math.floor(baseDelay / 2)))
    }
  }

  if (!templateResponse) return null

  // Dedup + sort opcional + corte ao targetCount
  if (needsSort) accumulated = dedupeAndSort(accumulated)
  else {
    // Só dedup, sem reorder (preserva ordem original do upstream)
    const seen = new Set()
    accumulated = accumulated.filter(item => {
      const key = item?.id ?? item?.creator_id ?? item?.product_id ?? JSON.stringify(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // Monta resposta com o mesmo shape da original mas com os itens acumulados
  const merged = { ...templateResponse }
  if (Array.isArray(templateResponse.data))  merged.data  = accumulated
  else if (Array.isArray(templateResponse.list))  merged.list  = accumulated
  else if (Array.isArray(templateResponse.items)) merged.items = accumulated

  return merged
}

// Alias de compatibilidade — endpoints de página única usam esse wrapper simplificado
async function kaloPostWithRetry (path, bodyFn, country, opts = {}) {
  return kaloPostPaginated(path, bodyFn, country, {
    targetCount: opts.targetCount ?? 55,
    upstreamPageSize: 60,  // products/videos/shops já vêm com 60 numa página
    maxPages: 1,           // não pagina — para na 1ª página
    baseDelay: opts.baseDelay ?? 1200,
    needsSort: false,
  })
}



// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------
function loadConfig() {
  const defaults = {
    resend_api_key: '',
    email_from: 'Kalodata Dashboard <onboarding@resend.dev>',
    email_to: '',
    cookie_check_cron: '0 */6 * * *', // every 6 hours
    kalowave_token: '',
    kalowave_cookies: '',
    // Quando definido, endpoints administrativos exigem header `x-admin-key` igual.
    // Vazio = gate desabilitado (modo dev). Em produÃÂ§ÃÂ£o, setar via config.json.
    admin_key: process.env.ADMIN_KEY || ''
  }
  try {
    const raw = readFileSync('config.json', 'utf-8')
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return defaults
  }
}

// ---------------------------------------------------------------------------
// Admin gate (x-admin-key)
// ---------------------------------------------------------------------------
// Middleware que protege endpoints administrativos. Quando `admin_key` estÃÂ¡
// vazio no config, deixa passar com warning (modo dev). Quando estÃÂ¡ setado,
// exige header `x-admin-key` exato. Sem isso, qualquer um que descobrir o IP
// do intermediÃÂ¡rio consegue ler/escrever cookies, config, e disparar alerts.
let warnedAdminKeyMissing = false
function requireAdminKey(req, res, next) {
  const cfg = loadConfig()
  const expected = (cfg.admin_key || '').trim()
  if (!expected) {
    if (!warnedAdminKeyMissing) {
      console.warn('[ADMIN] admin_key vazio no config Ã¢ÂÂ endpoints administrativos sem gate. Setar em produÃÂ§ÃÂ£o.')
      warnedAdminKeyMissing = true
    }
    return next()
  }
  const got = (req.headers['x-admin-key'] || '').trim()
  if (got !== expected) {
    return res.status(401).json({ success: false, message: 'NÃÂ£o autorizado (x-admin-key ausente ou incorreto)' })
  }
  return next()
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
function getCookies() {
  try {
    return readFileSync('cookies.txt', 'utf-8').trim()
  } catch {
    return ''
  }
}

function setCookies(cookies) {
  writeFileSync('cookies.txt', cookies.trim() + '\n', 'utf-8')
}

// ---------------------------------------------------------------------------
// Kalodata proxy helper
// ---------------------------------------------------------------------------
function kaloPost(path, body, country = DEFAULT_COUNTRY, proxyUrl = null) {
  const cookies = getCookies()
  if (!cookies) throw new Error('cookies.txt not found or empty')

  const ctx = headersForCountry(country)

  const args = [
    '-s', '--max-time', '30',
    '-A', UA,
    '-b', cookies,
    '-H', 'content-type: application/json',
    '-H', `country: ${ctx.country}`,
    '-H', `currency: ${ctx.currency}`,
    '-H', `language: ${ctx.language}`,
    '-H', 'origin: https://www.kalodata.com',
    '-H', 'referer: https://www.kalodata.com/explore',
    '-H', 'sec-ch-ua: "Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    '-H', 'sec-ch-ua-mobile: ?0',
    '-H', 'sec-ch-ua-platform: "Linux"',
    '-H', 'sec-fetch-dest: empty',
    '-H', 'sec-fetch-mode: cors',
    '-H', 'sec-fetch-site: same-origin',
    '-H', 'dnt: 1',
    '-X', 'POST',
    `https://www.kalodata.com${path}`,
    '--data-raw', JSON.stringify(body),
    ...proxyCurlArgs(proxyUrl),
  ]

  const result = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 35000 })
  if (proxyUrl) console.log('[proxy] kaloPost', path, 'via', proxyUrl.replace(/:[^:@]*@/, ':***@'))
  if (result.trimStart().startsWith('<')) {
    throw new Error('Cloudflare challenge Ã¢ÂÂ atualize os cookies (precisa do cf_clearance)')
  }
  if (!result.trim()) return { success: false, data: null, message: 'upstream returned empty body' }
  return JSON.parse(result)
}

function kaloGet(path, country = DEFAULT_COUNTRY) {
  const cookies = getCookies()
  if (!cookies) throw new Error('cookies.txt not found or empty')

  const ctx = headersForCountry(country)

  const args = [
    '-s', '--max-time', '30',
    '-A', UA,
    '-b', cookies,
    '-H', 'accept: application/json, text/plain, */*',
    '-H', `country: ${ctx.country}`,
    '-H', `currency: ${ctx.currency}`,
    '-H', `language: ${ctx.language}`,
    '-H', 'origin: https://www.kalodata.com',
    '-H', 'referer: https://www.kalodata.com/creator/detail',
    '-H', 'sec-ch-ua: "Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    '-H', 'sec-ch-ua-mobile: ?0',
    '-H', 'sec-ch-ua-platform: "Linux"',
    '-H', 'sec-fetch-dest: empty',
    '-H', 'sec-fetch-mode: cors',
    '-H', 'sec-fetch-site: same-origin',
    '-H', 'dnt: 1',
    `https://www.kalodata.com${path}`,
  ]

  const result = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 35000 })
  if (result.trimStart().startsWith('<')) {
    throw new Error('Cloudflare challenge Ã¢ÂÂ atualize os cookies (precisa do cf_clearance)')
  }
  if (!result.trim()) return { success: false, data: null, message: 'upstream returned empty body' }
  return JSON.parse(result)
}

// ---------------------------------------------------------------------------
// Kalowave (clip.kalowave.com) proxy helper
// ---------------------------------------------------------------------------
let kalowaveCache = { token: '', expiresAt: 0 }

function invalidateKalowaveCache() {
  kalowaveCache = { token: '', expiresAt: 0 }
}

function getKalowaveToken() {
  // Use cache if valid (10 min margin)
  if (kalowaveCache.token && Date.now() < kalowaveCache.expiresAt - 600000) {
    return kalowaveCache.token
  }

  const cfg = loadConfig()

  // Auto: Kalodata cookies Ã¢ÂÂ SSO token Ã¢ÂÂ Kalowave access token
  const cookies = getCookies()
  if (cookies) {
    try {
      // Step 1: Get SSO token from Kalodata
      const ssoArgs = [
        '-s', '--max-time', '15', '-A', UA,
        '-b', cookies,
        '-H', 'accept: application/json',
        '-H', 'country: BR', '-H', 'language: pt-BR',
        'https://www.kalodata.com/api/sso/clip-token',
      ]
      const ssoResult = JSON.parse(execFileSync('/usr/local/bin/curl_chrome116', ssoArgs, { encoding: 'utf-8', timeout: 20000 }))

      if (ssoResult.success && ssoResult.data?.token) {
        // Step 2: Exchange SSO token for Kalowave access token
        const oauthArgs = [
          '-s', '--max-time', '15', '-A', UA,
          '-X', 'POST',
          '-H', 'content-type: application/json',
          '-H', 'accept: application/json',
        ]
        if (cfg.kalowave_cookies) oauthArgs.push('-b', cfg.kalowave_cookies)
        oauthArgs.push('-d', JSON.stringify({ token: ssoResult.data.token }))
        oauthArgs.push('https://clip.kalowave.com/api/oauth2/kalo')

        const oauthResult = JSON.parse(execFileSync('/usr/local/bin/curl_chrome116', oauthArgs, { encoding: 'utf-8', timeout: 20000 }))

        if (oauthResult.success && oauthResult.data?.accessToken) {
          kalowaveCache = {
            token: oauthResult.data.accessToken,
            expiresAt: Date.now() + (oauthResult.data.expiresIn || 864000) * 1000,
          }
          console.log('[KALOWAVE] Token refreshed automatically via SSO')
          return oauthResult.data.accessToken
        }
      }
    } catch (e) {
      console.warn('[KALOWAVE] Auto-refresh failed:', e.message)
    }
  }

  // Fallback: static token from config
  if (cfg.kalowave_token) return cfg.kalowave_token

  throw new Error('Cannot get Kalowave token. Check Kalodata cookies.')
}

function kalowaveGet(path) {
  const token = getKalowaveToken()
  const cfg = loadConfig()

  const args = [
    '-s', '--max-time', '30',
    '-A', UA,
    '-H', 'accept: application/json',
    '-H', `authorization: Bearer ${token}`,
    '-H', 'country: US',
    '-H', 'currency: USD',
    '-H', 'language: pt-BR',
    '-H', 'dnt: 1',
  ]

  if (cfg.kalowave_cookies) {
    args.push('-b', cfg.kalowave_cookies)
  }

  args.push(`https://clip.kalowave.com${path}`)

  const result = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 35000 })
  if (!result.trim()) return { success: false, data: null, message: 'upstream returned empty body' }
  return JSON.parse(result)
}

function kalowavePost(path, body) {
  const token = getKalowaveToken()
  const cfg = loadConfig()

  const args = [
    '-s', '--max-time', '30',
    '-A', UA,
    '-X', 'POST',
    '-H', 'accept: application/json',
    '-H', 'content-type: application/json',
    '-H', `authorization: Bearer ${token}`,
    '-H', 'country: US',
    '-H', 'currency: USD',
    '-H', 'language: pt-BR',
  ]

  if (cfg.kalowave_cookies) {
    args.push('-b', cfg.kalowave_cookies)
  }

  args.push('-d', JSON.stringify(body))
  args.push(`https://clip.kalowave.com${path}`)

  const result = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 35000 })
  if (!result.trim()) return { success: false, data: null, message: 'upstream returned empty body' }
  return JSON.parse(result)
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function getDateRange(days) {
  // Use local date components (not toISOString Ã¢ÂÂ UTC) so the window matches
  // the user's calendar day in America/Sao_Paulo, not UTC.
  //
  // Janela: [hoje-2 - (days-1), hoje-2].
  // O Kalodata fecha o agregado de cada dia sÃÂ³ no dia seguinte (em UTC), entÃÂ£o
  // "ontem" (BRT) ainda pode estar com dados parciais. A prÃÂ³pria UI da
  // Kalodata pula pra D-2 Ã¢ÂÂ confirmado comparando: pra days=30 num "hoje"=14/05
  // a fonte mostra 13/04 ~ 12/05, e antes daqui mandÃÂ¡vamos 14/04 ~ 13/05 (off-by-one).
  // Esse offset gerava ~R$4-6k de diferenÃÂ§a em vÃÂ­deos sensÃÂ­veis ao ÃÂºltimo dia.
  const fmt = (d) => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${dd}`
  }
  const end = new Date()
  end.setDate(end.getDate() - 2)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  return { days, startDate: fmt(start), endDate: fmt(end) }
}

// ---------------------------------------------------------------------------
// Session check
// ---------------------------------------------------------------------------
function checkSession() {
  try {
    const data = kaloPost('/user/features', { country: 'BR', list: ['PRODUCT.LIST'] })
    return data.success === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Email alerts
// ---------------------------------------------------------------------------
let lastAlertSent = null

async function sendCookieExpiredAlert() {
  const config = loadConfig()
  const { resend_api_key, email_from, email_to } = config

  if (!resend_api_key || !email_to) {
    console.warn('[ALERT] Resend not configured Ã¢ÂÂ skipping alert. Set resend_api_key and email_to in config.json.')
    return false
  }

  // Avoid spamming: max 1 alert every 6 hours
  if (lastAlertSent && (Date.now() - lastAlertSent) < 6 * 60 * 60 * 1000) {
    console.log('[ALERT] Alert already sent recently, skipping.')
    return false
  }

  const resend = new Resend(resend_api_key)

  const { error } = await resend.emails.send({
    from: email_from,
    to: Array.isArray(email_to) ? email_to : [email_to],
    subject: 'Kalodata: Cookies Expirados!',
    html: `
      <h2>Cookies Expirados - Kalodata Dashboard</h2>
      <p>Os cookies de sessao do Kalodata expiraram e o dashboard nao consegue mais acessar os dados.</p>
      <h3>Como resolver:</h3>
      <ol>
        <li>Acesse <a href="https://www.kalodata.com">kalodata.com</a> e faca login</li>
        <li>Abra o DevTools (F12) &gt; Network</li>
        <li>Copie o header <code>Cookie</code> de qualquer request</li>
        <li>Atualize via API: <code>PUT /api/cookies</code> com <code>{ "cookies": "..." }</code></li>
        <li>Ou edite o arquivo <code>cookies.txt</code> diretamente no servidor</li>
      </ol>
      <p><small>Alerta enviado em ${new Date().toLocaleString('pt-BR')}</small></p>
    `,
  })

  if (error) throw new Error(error.message)

  lastAlertSent = Date.now()
  console.log(`[ALERT] Cookie expired email sent to ${email_to}`)
  return true
}

// ---------------------------------------------------------------------------
// Cron: periodic cookie health check
// ---------------------------------------------------------------------------
const config = loadConfig()
cron.schedule(config.cookie_check_cron, async () => {
  console.log('[CRON] Checking cookie health...')
  const valid = checkSession()
  if (!valid) {
    console.warn('[CRON] Session invalid Ã¢ÂÂ sending alert')
    await sendCookieExpiredAlert().catch((e) => console.error('[CRON] Email error:', e.message))
  } else {
    console.log('[CRON] Session OK')
  }
})

// ---------------------------------------------------------------------------
// Swagger
// ---------------------------------------------------------------------------
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Kalodata Dashboard API',
      version: '1.0.0',
      description: 'API completa para o dashboard Kalodata TikTok Shop BR. Proxy autenticado para a API do Kalodata com monitoramento de sessao e alertas por email.',
      contact: { name: 'Kalodata Dashboard' },
    },
    servers: [
      { url: `http://localhost:${PORT}`, description: 'Localhost' },
      { url: `http://0.0.0.0:${PORT}`, description: 'Rede local' },
    ],
    tags: [
      { name: 'Products', description: 'Produtos do TikTok Shop' },
      { name: 'Videos', description: 'Videos de vendas e trending' },
      { name: 'Creators', description: 'Criadores de conteudo' },
      { name: 'Session', description: 'Status da sessao e cookies' },
      { name: 'Config', description: 'Configuracao do sistema' },
    ],
  },
  apis: ['./server.js'],
})

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Kalodata API Docs',
}))

app.get('/api/docs.json', (_req, res) => res.json(swaggerSpec))

// ===========================================================================
// API ROUTES
// ===========================================================================

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Listar produtos top do TikTok Shop
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *           enum: [7, 30]
 *         description: Periodo em dias (7 ou 30)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Numero da pagina
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Itens por pagina
 *       - in: query
 *         name: sortField
 *         schema:
 *           type: string
 *           default: revenue
 *           enum: [revenue, volume, views]
 *         description: Campo de ordenacao
 *     responses:
 *       200:
 *         description: Lista de produtos
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       401:
 *         description: Sessao expirada (cookies invalidos)
 *       500:
 *         description: Erro interno
 */
app.get('/api/products', async (req, res) => {
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = await kaloPostWithRetry('/product/queryList', () => ({
      country,
      ...range,
      pageNo: page,
      pageSize,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, { targetCount: Math.min(pageSize - 5, 55) })
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// KaloCDN image proxy (products, videos, creators)
// ---------------------------------------------------------------------------
const imgCache = new Map()

function proxyKaloCDN(cdnPath, cacheKey, res) {
  const cached = imgCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(cached.buffer)
  }

  try {
    const result = execFileSync('/usr/local/bin/curl_chrome116', [
      '-s', '--max-time', '15', '-L',
      `https://img.kalocdn.com/${cdnPath}`,
    ], { timeout: 20000 })

    if (result.length < 100) return res.status(404).send('Image not found')

    imgCache.set(cacheKey, { buffer: result, contentType: 'image/png', expiresAt: Date.now() + 86400000 })
    if (imgCache.size > 1000) {
      const oldest = imgCache.keys().next().value
      imgCache.delete(oldest)
    }

    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(result)
  } catch {
    res.status(502).send('Failed to fetch image')
  }
}

/**
 * @swagger
 * /api/product/{id}/image:
 *   get:
 *     summary: Proxy para imagem do produto (KaloCDN)
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Imagem PNG do produto
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Imagem nao encontrada
 */
app.get('/api/product/:id/image', (req, res) => {
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).send('Invalid id')
  proxyKaloCDN(`tiktok.product/${id}/cover.png`, `prod_${id}`, res)
})

/**
 * @swagger
 * /api/video/{id}/cover:
 *   get:
 *     summary: Proxy para thumbnail do video (KaloCDN)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Imagem PNG de capa do video
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Thumbnail nao encontrada
 */
app.get('/api/video/:id/cover', (req, res) => {
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).send('Invalid id')
  proxyKaloCDN(`tiktok.video/${id}/cover.png`, `vid_${id}`, res)
})

/**
 * @swagger
 * /api/video/{id}/url:
 *   get:
 *     summary: Obter URL do MP4 do video via KaloData
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: URL assinada do video MP4
 *       500:
 *         description: Erro interno
 */
app.get('/api/video/:id/url', (req, res) => {
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' })
  try {
    const country = parseCountry(req)
    const data = kaloGet(`/video/detail/getVideoUrl?videoId=${id}`, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/video/{id}/total:
 *   get:
 *     summary: MÃÂ©tricas totais de um vÃÂ­deo (views, receita, vendas)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ID do vÃÂ­deo
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30, enum: [7, 30] }
 *       - in: query
 *         name: country
 *         schema: { type: string, default: BR }
 *     responses:
 *       200:
 *         description: MÃÂ©tricas do vÃÂ­deo (views, revenue, sale, new_followers, day_*)
 *       500:
 *         description: Erro interno
 */
app.get('/api/video/:id/total', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 30
    const range = getDateRange(days)
    const data = kaloPost('/video/detail/total', { id, country, ...range, days }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/videos:
 *   get:
 *     summary: Listar videos de vendas do TikTok Shop
 *     tags: [Videos]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *           enum: [7, 30]
 *         description: Periodo em dias
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: sortField
 *         schema:
 *           type: string
 *           default: revenue
 *           enum: [revenue, volume, views]
 *     responses:
 *       200:
 *         description: Lista de videos
 *       500:
 *         description: Erro interno
 */
app.get('/api/videos', async (req, res) => {
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = await kaloPostWithRetry('/video/queryList', () => ({
      country,
      ...range,
      pageNo: page,
      pageSize,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, { targetCount: Math.min(pageSize - 5, 55) })
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/videos/hot:
 *   get:
 *     summary: Listar videos em alta (trending)
 *     tags: [Videos]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Lista de videos em alta
 *       500:
 *         description: Erro interno
 */
app.get('/api/videos/hot', (req, res) => {
  try {
    const country = parseCountry(req)
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20

    const data = kaloPost('/homepage/hot/video/queryList', {
      country,
      pageIndex: page,
      pageSize,
    }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/lives:
 *   get:
 *     summary: Listar lives (livestreams) do TikTok Shop por receita
 *     tags: [Lives]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: sortField
 *         schema: { type: string, default: revenue, enum: [revenue, sale, views, gpm] }
 *     responses:
 *       200: { description: Lista de lives }
 *       500: { description: Erro interno }
 */
app.get('/api/lives', async (req, res) => {
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = await kaloPostPaginated('/livestream/queryList', (pageNo) => ({
      country,
      ...range,
      pageNo,
      pageSize,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, {
      targetCount: pageSize,          // acumula até o alvo (ex: 20)
      upstreamPageSize: pageSize,     // se upstream entrega tudo, para na 1ª página
      maxPages: 3,                    // máximo 3 páginas de lives (gentil)
      baseDelay: 1200,
      needsSort: false,
    })
    if (data && Array.isArray(data.data)) data.data = data.data.slice(0, pageSize)
    else if (data && Array.isArray(data.list)) data.list = data.list.slice(0, pageSize)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/creator/{id}/lives:
 *   get:
 *     summary: Lives de um criador (todas as transmissÃÂµes no perÃÂ­odo)
 *     tags: [Lives]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: sortField
 *         schema: { type: string, default: revenue }
 *     responses:
 *       200: { description: Lives do criador }
 *       500: { description: Erro interno }
 */
app.get('/api/creator/:id/lives', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/creator/detail/live/queryList', {
      id,
      country,
      ...range,
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
    }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shops:
 *   get:
 *     summary: Listar lojas (shops/sellers) do TikTok Shop por receita
 *     tags: [Shops]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: sortField
 *         schema: { type: string, default: revenue, enum: [revenue, sale, gmv] }
 *       - in: query
 *         name: cateId
 *         schema: { type: string }
 *         description: Opcional - filtra por uma categoria L1
 *     responses:
 *       200: { description: Lista de lojas }
 *       500: { description: Erro interno }
 */
app.get('/api/shops', async (req, res) => {
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const cateIds = req.query.cateId ? [String(req.query.cateId)] : []
    const range = getDateRange(days)

    const data = await kaloPostWithRetry('/shop/queryList', () => ({
      country,
      ...range,
      pageNo: page,
      pageSize,
      cateIds,
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, { targetCount: Math.min(pageSize - 5, 55) })
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Shop detail (criadores afiliados, produtos, vÃÂ­deos, lives da loja)
// ---------------------------------------------------------------------------
// Paths confirmados em 2026-05-15 via DevTools do Kalodata logado (loja
// Barbour's Beauty). Os paths que parecem "iguais" em padrÃÂ£o (creator/queryList,
// searchProducts, etc) na verdade NÃÂO existem pra shop Ã¢ÂÂ usamos as variantes
// especÃÂ­ficas: searchCooperativeCreators, product/queryList, searchVideos,
// searchLives.
//
// Payload base de TODOS os endpoints de listagem:
//   { id, startDate, endDate, cateIds: [], authority: true, pageNo, pageSize,
//     sort: [{ field, type }], currency, region }
// Campos extras por aba: creatorType (creators+lives), productType (products),
// videoType+creatorNickName (videos).

/**
 * Helper: payload pros endpoints de overview (/total, /detail, /history).
 * INCLUI currency + region (esses 3 endpoints exigem; sem eles dÃÂ¡ Invalid Parameter).
 */
function shopOverviewBody(id, country, range, extra = {}) {
  const cfg = COUNTRY_CONFIG[country] || COUNTRY_CONFIG.BR
  return {
    id,
    ...range,
    cateIds: [],
    currency: cfg.currency,
    region: cfg.country,
    ...extra,
  }
}

/**
 * Helper: payload pros endpoints de listagem paginada (creators, products,
 * videos, lives, new-products). NÃÂO inclui currency/region Ã¢ÂÂ Kalodata
 * rejeita com `code: 501 "Invalid Parameter"` se enviar esses campos
 * nesses endpoints (confirmado empiricamente em 2026-05-15).
 *
 * Kalodata tambÃÂ©m rejeita pageSize < 10 nesses endpoints. Clampa pro
 * mÃÂ­nimo 10 (defensivo Ã¢ÂÂ frontend jÃÂ¡ usa 10/20).
 */
function shopListBody(id, range, extra = {}) {
  const clamped = { ...extra }
  if (clamped.pageSize != null && clamped.pageSize < 10) clamped.pageSize = 10
  return {
    id,
    ...range,
    cateIds: [],
    authority: true,
    pageNo: 1,
    pageSize: 10,
    sort: [{ field: 'revenue', type: 'DESC' }],
    ...clamped,
  }
}

/**
 * @swagger
 * /api/shop/{id}/total:
 *   get:
 *     summary: KPIs agregados de uma loja (receita, vendas, breakdown por canal)
 *     tags: [Shops]
 */
app.get('/api/shop/:id/total', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)
    const data = kaloPost('/shop/detail/total', shopOverviewBody(id, country, range), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shop/{id}/info:
 *   get:
 *     summary: Dados gerais da loja (nome, tipo, regiÃÂ£o, categoria)
 *     tags: [Shops]
 */
app.get('/api/shop/:id/info', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)
    const data = kaloPost('/shop/detail', shopOverviewBody(id, country, range), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shop/{id}/creators:
 *   get:
 *     summary: Top criadores afiliados a uma loja (cooperativos)
 *     tags: [Shops, Creators]
 */
app.get('/api/shop/:id/creators', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/shop/detail/searchCooperativeCreators', shopListBody(id, range, {
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
      creatorType: '',
    }), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shop/{id}/products:
 *   get:
 *     summary: Produtos vendidos por uma loja
 *     tags: [Shops, Products]
 */
app.get('/api/shop/:id/products', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/shop/detail/product/queryList', shopListBody(id, range, {
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
      productType: '',
    }), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shop/{id}/videos:
 *   get:
 *     summary: VÃÂ­deos e anÃÂºncios que venderam produtos da loja (campo `ad: 1` = anÃÂºncio)
 *     tags: [Shops, Videos]
 */
app.get('/api/shop/:id/videos', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/shop/detail/searchVideos', shopListBody(id, range, {
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
      videoType: '',
      creatorNickName: '',
    }), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shop/{id}/lives:
 *   get:
 *     summary: Lives que venderam produtos da loja
 *     tags: [Shops, Lives]
 */
app.get('/api/shop/:id/lives', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/shop/detail/searchLives', shopListBody(id, range, {
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
      creatorType: '',
    }), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shop/{id}/new-products:
 *   get:
 *     summary: Novos produtos lanÃÂ§ados pela loja no perÃÂ­odo
 *     tags: [Shops, Products]
 */
app.get('/api/shop/:id/new-products', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const range = getDateRange(days)

    const data = kaloPost('/shop/detail/searchNewProducts', shopListBody(id, range, {
      pageNo: page,
      pageSize,
      sort: [{ field: 'revenue', type: 'DESC' }],
    }), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/shop/{id}/history:
 *   get:
 *     summary: SÃÂ©rie temporal de mÃÂ©tricas da loja
 *     tags: [Shops]
 */
app.get('/api/shop/:id/history', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)
    const data = kaloPost('/shop/detail/history', shopOverviewBody(id, country, range), country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Product detail
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/product/{id}/detail:
 *   get:
 *     summary: Detalhes de um produto (metadata, SKUs, categorias)
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *     responses:
 *       200: { description: Dados do produto }
 *       500: { description: Erro interno }
 */
app.get('/api/product/:id/detail', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)
    const data = kaloPost('/product/detail', { country, id, ...range }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/product/{id}/images:
 *   get:
 *     summary: Carrossel de imagens do produto
 *     description: Retorna array de URLs (kalocdn) das fotos cadastradas no TikTok Shop.
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Array de URLs }
 *       500: { description: Erro interno }
 */
app.get('/api/product/:id/images', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    // Upstream usa GET com query string (nÃÂ£o POST).
    const data = kaloGet(`/product/detail/getImages?productId=${encodeURIComponent(id)}`, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/product/{id}/history:
 *   get:
 *     summary: SÃÂ©rie temporal diÃÂ¡ria do produto (para grÃÂ¡fico)
 *     description: Retorna lista com revenue/sale/video_revenue/live_revenue/unit_price/creatorConversionRatio por partition_day.
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *     responses:
 *       200: { description: SÃÂ©rie temporal }
 *       500: { description: Erro interno }
 */
app.get('/api/product/:id/history', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)
    const data = kaloPost('/product/detail/history', { country, id, ...range }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/product/{id}/analysis:
 *   get:
 *     summary: Atributos + caracterÃÂ­sticas-chave do produto (AI features)
 *     description: Retorna highlights (key_word + region_text) e attributes (key/value) Ã¢ÂÂ fonte de "CaracterÃÂ­sticas-chave" e "Atributos".
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: highlights[] + attributes[] }
 *       500: { description: Erro interno }
 */
app.get('/api/product/:id/analysis', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const data = kaloPost('/product/analysis', { country, id }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/product/{id}/total:
 *   get:
 *     summary: KPIs agregados de um produto (receita, vendas, video/live/shopping mall revenue)
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *     responses:
 *       200: { description: Totais do produto }
 *       500: { description: Erro interno }
 */
app.get('/api/product/:id/total', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)
    const data = kaloPost('/product/detail/total', { country, id, ...range }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/product/{id}/videos:
 *   get:
 *     summary: Videos e anuncios que venderam um produto
 *     tags: [Products, Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: sortField
 *         schema: { type: string, default: revenue, enum: [revenue, views, sale, gpm] }
 *     responses:
 *       200: { description: Lista de videos }
 *       500: { description: Erro interno }
 */
app.get('/api/product/:id/videos', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/product/detail/video/queryList', {
      id,
      ...range,
      authority: true,
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
    }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/product/{id}/lives:
 *   get:
 *     summary: Lives que venderam um produto
 *     tags: [Products, Lives]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: sortField
 *         schema: { type: string, default: revenue, enum: [revenue, views, sale, gpm] }
 */
app.get('/api/product/:id/lives', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    // Kalodata rejeita pageSize<10 com Invalid Parameter (mesmo padrÃÂ£o dos
    // endpoints de shop detail). Clampa defensivamente.
    const pageSize = Math.max(10, parseInt(req.query.pageSize) || 10)
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/product/detail/live/queryList', {
      id,
      ...range,
      authority: true,
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
    }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/creators:
 *   get:
 *     summary: Listar criadores de conteudo top
 *     tags: [Creators]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *           enum: [7, 30]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximo 10 no plano basico
 *       - in: query
 *         name: sortField
 *         schema:
 *           type: string
 *           default: revenue
 *           enum: [revenue, volume, views]
 *     responses:
 *       200:
 *         description: Lista de criadores
 *       500:
 *         description: Erro interno
 */
app.get('/api/creators', async (req, res) => {
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 60
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const UPSTREAM_CREATOR_PAGE = 10  // kalodata retorna 10 criadores por página
    const data = await kaloPostPaginated('/creator/queryList', (pageNo) => ({
      country,
      ...range,
      pageNo,
      pageSize: UPSTREAM_CREATOR_PAGE,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, {
      targetCount: pageSize,          // acumula até o que o cliente pediu (ex: 60)
      upstreamPageSize: UPSTREAM_CREATOR_PAGE,
      maxPages: Math.ceil(pageSize / UPSTREAM_CREATOR_PAGE) + 2,  // páginas necessárias + margem
      baseDelay: 1200,
      needsSort: false,               // upstream já retorna em ordem de revenue
    })
    // Corta ao pageSize pedido pelo cliente
    if (data && Array.isArray(data.data)) data.data = data.data.slice(0, pageSize)
    else if (data && Array.isArray(data.list)) data.list = data.list.slice(0, pageSize)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Creator avatar proxy (KaloCDN)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/creator-avatar/{id}:
 *   get:
 *     summary: Proxy para avatar do criador (KaloCDN)
 *     tags: [Creators]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Imagem PNG do avatar
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Avatar nao encontrado
 */
app.get('/api/creator-avatar/:id', (req, res) => {
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).send('Invalid id')
  proxyKaloCDN(`tiktok.creator/${id}/avatar_medium.png`, `avatar_${id}`, res)
})
/**
 * @swagger
 * /api/shop-avatar/{id}:
 *   get:
 *     summary: Proxy para logo da loja (KaloCDN tiktok.seller)
 *     tags: [Shops]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID numérico da loja (mesmo id do /api/shops)
 *     responses:
 *       200:
 *         description: Imagem PNG da logo da loja
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Logo não encontrada
 */
app.get('/api/shop-avatar/:id', (req, res) => {
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).send('Invalid id')
  proxyKaloCDN(`tiktok.seller/${id}/logo.png`, `shop_${id}`, res)
})

// Temporary debug: probe CDN paths from server side (admin-only)
app.get('/api/debug/cdn-probe/:id', (req, res) => {
  const { id } = req.params
  const paths = [
    `tiktok.shop/${id}/logo.png`,
    `tiktok.shop/${id}/avatar_medium.png`,
    `tiktok.shop/${id}/cover.png`,
    `tiktok.creator/${id}/avatar_medium.png`,
    `tiktok.seller/${id}/logo.png`,
    `tiktok.brand/${id}/logo.png`,
  ]
  const results = {}
  for (const path of paths) {
    try {
      const buf = execFileSync('/usr/local/bin/curl_chrome116', [
        '-s', '--max-time', '8', '-L',
        `https://img.kalocdn.com/${path}`,
      ], { timeout: 12000 })
      results[path] = buf.length
    } catch (e) {
      results[path] = 'error: ' + e.message.substring(0, 50)
    }
  }
  res.json(results)
})



// ---------------------------------------------------------------------------
// Creator search (fullText), products & totals
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/search/creators:
 *   get:
 *     summary: Buscar criadores por nome ou handle
 *     tags: [Creators]
 *     parameters:
 *       - in: query
 *         name: keyword
 *         required: true
 *         schema:
 *           type: string
 *         description: Termo de busca (nome ou handle)
 *     responses:
 *       200:
 *         description: Lista de criadores encontrados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       creator_uid:
 *                         type: string
 *                       creator_handle:
 *                         type: string
 *                       creator_nickname:
 *                         type: string
 *                       gmv_in_30:
 *                         type: number
 *                         description: Receita dos ultimos 30 dias
 *       500:
 *         description: Erro interno
 */
app.get('/api/search/creators', (req, res) => {
  try {
    const country = parseCountry(req)
    const keyword = (req.query.keyword || '').trim()
    if (!keyword) return res.json({ success: true, data: [] })

    const data = kaloPost('/overview/fullText/search', {
      country_code: countryLowercase(country),
      keyword,
      scope: [{ index: 'creator', pageNo: 1, pageSize: 20 }],
    }, country)
    const creators = data?.data?.creator || []
    res.json({ success: true, data: creators })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/search/products:
 *   get:
 *     summary: Buscar produtos por nome (fulltext)
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: keyword
 *         required: true
 *         schema:
 *           type: string
 *         description: Termo de busca (nome do produto)
 *       - in: query
 *         name: country
 *         schema: { type: string, default: BR }
 *       - in: query
 *         name: pageNo
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Lista de produtos encontrados
 */
app.get('/api/search/products', (req, res) => {
  try {
    const country  = parseCountry(req)
    const keyword  = (req.query.keyword || '').trim()
    const pageNo   = parseInt(req.query.pageNo)  || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    if (!keyword) return res.json({ success: true, data: [] })

    const data = kaloPost('/overview/fullText/search', {
      country_code: countryLowercase(country),
      keyword,
      scope: [{ index: 'product', pageNo, pageSize }],
    }, country)
    const products = data?.data?.product || []
    res.json({ success: true, data: products })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/search/videos:
 *   get:
 *     summary: Buscar vÃÂ­deos por tÃÂ­tulo (fulltext)
 *     tags: [Videos]
 *     parameters:
 *       - in: query
 *         name: keyword
 *         required: true
 *         schema:
 *           type: string
 *         description: Termo de busca (tÃÂ­tulo do vÃÂ­deo)
 *       - in: query
 *         name: country
 *         schema: { type: string, default: BR }
 *       - in: query
 *         name: pageNo
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Lista de vÃÂ­deos encontrados
 */
app.get('/api/search/videos', (req, res) => {
  try {
    const country  = parseCountry(req)
    const keyword  = (req.query.keyword || '').trim()
    const pageNo   = parseInt(req.query.pageNo)  || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    if (!keyword) return res.json({ success: true, data: [] })

    const data = kaloPost('/overview/fullText/search', {
      country_code: countryLowercase(country),
      keyword,
      scope: [{ index: 'video', pageNo, pageSize }],
    }, country)
    const videos = data?.data?.video || []
    res.json({ success: true, data: videos })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/creator/{id}/products:
 *   get:
 *     summary: Listar produtos vendidos por um criador
 *     tags: [Creators]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do criador
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *           enum: [7, 30]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Lista de produtos do criador
 *       500:
 *         description: Erro interno
 */
app.get('/api/creator/:id/products', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const range = getDateRange(days)

    const data = kaloPost('/creator/detail/searchProducts', {
      id,
      ...range,
      cateIds: [],
      sellerId: '',
      authority: true,
      pageNo: page,
      pageSize,
      sort: [{ field: 'revenue', type: 'DESC' }],
    }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/creator/{id}/total:
 *   get:
 *     summary: Obter estatisticas totais de vendas do criador
 *     tags: [Creators]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do criador
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *           enum: [7, 30]
 *     responses:
 *       200:
 *         description: Estatisticas do criador (receita, vendas, views, seguidores, etc.)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     revenue:
 *                       type: string
 *                       example: "R$2,47m"
 *                     sale:
 *                       type: string
 *                       example: "52,78k"
 *                     video_revenue:
 *                       type: string
 *                     live_revenue:
 *                       type: string
 *                     video_views:
 *                       type: string
 *                     followers:
 *                       type: string
 *                     day_revenue:
 *                       type: string
 *                     day_sale:
 *                       type: string
 *                     day_followers:
 *                       type: string
 *                     unit_price:
 *                       type: string
 *       500:
 *         description: Erro interno
 */
app.get('/api/creator/:id/total', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)

    const data = kaloPost('/creator/detail/total', {
      id,
      ...range,
      cateIds: [],
      sellerId: '',
      authority: true,
    }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/creator/{id}/detail:
 *   get:
 *     summary: Detalhe do criador (perfil + MCN + contatos)
 *     description: Retorna nickname, handle, signature, follower_count, creator_type, mcn_name, has_mcn, creatorContent (whatsapp, instagram, email, youtube, etc.).
 *     tags: [Creators]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Perfil do criador }
 *       500: { description: Erro interno }
 */
app.get('/api/creator/:id/detail', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params

    // Accept explicit startDate/endDate or ?days=N (default 30d)
    let startDate, endDate
    if (req.query.startDate && req.query.endDate) {
      startDate = req.query.startDate
      endDate = req.query.endDate
    } else {
      const days = parseInt(req.query.days) || 30
      const range = getDateRange(days)
      startDate = range.startDate
      endDate = range.endDate
    }

    const cacheKey = `creator:detail:${id}:${country}:${startDate}:${endDate}`
    const cached = insightCacheGet(cacheKey)
    if (cached) return res.json({ ...cached, cached: true })

    const data = kaloPost('/creator/detail', { country, id, startDate, endDate }, country)
    if (data && data.success) insightCacheSet(cacheKey, data, 86400000)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Session & Cookies
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/session:
 *   get:
 *     summary: Verificar status da sessao
 *     tags: [Session]
 *     responses:
 *       200:
 *         description: Status da sessao
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                   description: Se a sessao esta ativa
 *                 hasCookies:
 *                   type: boolean
 *                   description: Se o arquivo cookies.txt existe e tem conteudo
 *                 checkedAt:
 *                   type: string
 *                   format: date-time
 */
app.get('/api/session', requireAdminKey, (_req, res) => {
  const hasCookies = !!getCookies()
  const valid = hasCookies ? checkSession() : false
  res.json({ valid, hasCookies, checkedAt: new Date().toISOString() })
})

/**
 * @swagger
 * /api/cookies:
 *   get:
 *     summary: Verificar se cookies estao configurados
 *     tags: [Session]
 *     responses:
 *       200:
 *         description: Status dos cookies
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists:
 *                   type: boolean
 *                 length:
 *                   type: integer
 *                 preview:
 *                   type: string
 *                   description: Primeiros 50 chars (mascarado)
 */
app.get('/api/cookies', requireAdminKey, (_req, res) => {
  const cookies = getCookies()
  res.json({
    exists: !!cookies,
    length: cookies.length,
    preview: cookies ? cookies.substring(0, 50) + '...' : null,
  })
})

/**
 * @swagger
 * /api/cookies:
 *   put:
 *     summary: Atualizar cookies de sessao
 *     tags: [Session]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cookies]
 *             properties:
 *               cookies:
 *                 type: string
 *                 description: String completa do header Cookie
 *     responses:
 *       200:
 *         description: Cookies atualizados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 sessionValid:
 *                   type: boolean
 *       400:
 *         description: Cookie string ausente
 */
app.put('/api/cookies', requireAdminKey, (req, res) => {
  const { cookies } = req.body || {}
  if (!cookies || typeof cookies !== 'string' || !cookies.trim()) {
    return res.status(400).json({ success: false, message: 'Campo "cookies" e obrigatorio (string nao vazia)' })
  }
  setCookies(cookies)
  const valid = checkSession()
  res.json({ success: true, sessionValid: valid, updatedAt: new Date().toISOString() })
})

// ---------------------------------------------------------------------------
// Alert test
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/alerts/test:
 *   post:
 *     summary: Enviar email de teste de alerta
 *     tags: [Session]
 *     responses:
 *       200:
 *         description: Email enviado com sucesso
 *       500:
 *         description: Falha ao enviar email
 */
app.post('/api/alerts/test', requireAdminKey, async (_req, res) => {
  try {
    const sent = await sendCookieExpiredAlert()
    res.json({ success: true, sent, message: sent ? 'Email enviado' : 'Email nao enviado (nao configurado ou enviado recentemente)' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/alerts/check:
 *   post:
 *     summary: Verificar cookies e enviar alerta se expirados
 *     tags: [Session]
 *     responses:
 *       200:
 *         description: Resultado da verificacao
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionValid:
 *                   type: boolean
 *                 alertSent:
 *                   type: boolean
 */
app.post('/api/alerts/check', async (_req, res) => {
  try {
    const valid = checkSession()
    let alertSent = false
    if (!valid) {
      alertSent = await sendCookieExpiredAlert().catch(() => false)
    }
    res.json({ sessionValid: valid, alertSent, checkedAt: new Date().toISOString() })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/config:
 *   get:
 *     summary: Ver configuracao atual (senhas mascaradas)
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Configuracao do sistema
 */
app.get('/api/config', requireAdminKey, (_req, res) => {
  const cfg = loadConfig()
  // Mask sensitive fields
  const masked = {
    ...cfg,
    resend_api_key: cfg.resend_api_key ? cfg.resend_api_key.substring(0, 8) + '****' : '',
  }
  res.json(masked)
})

/**
 * @swagger
 * /api/config:
 *   put:
 *     summary: Atualizar configuracao
 *     tags: [Config]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               resend_api_key:
 *                 type: string
 *                 description: API key do Resend (re_...)
 *               email_from:
 *                 type: string
 *                 default: "Kalodata Dashboard <onboarding@resend.dev>"
 *                 description: Remetente do email
 *               email_to:
 *                 type: string
 *                 description: Email destinatario dos alertas
 *               cookie_check_cron:
 *                 type: string
 *                 example: "0 0/6 * * *"
 *                 description: Expressao cron para verificacao periodica
 *     responses:
 *       200:
 *         description: Configuracao atualizada
 */
app.put('/api/config', requireAdminKey, (req, res) => {
  const current = loadConfig()
  const updated = { ...current, ...req.body }
  writeFileSync('config.json', JSON.stringify(updated, null, 2), 'utf-8')
  const touchedKalowave =
    Object.prototype.hasOwnProperty.call(req.body ?? {}, 'kalowave_cookies') ||
    Object.prototype.hasOwnProperty.call(req.body ?? {}, 'kalowave_token')
  if (touchedKalowave) invalidateKalowaveCache()
  res.json({
    success: true,
    message: 'Configuracao atualizada',
    kalowaveCacheInvalidated: touchedKalowave,
  })
})

/**
 * @swagger
 * /api/kalowave/refresh:
 *   post:
 *     summary: Invalida o cache do access token Kalowave e forca novo SSO no proximo request
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Cache invalidado
 */
app.post('/api/kalowave/refresh', requireAdminKey, (_req, res) => {
  invalidateKalowaveCache()
  res.json({ success: true, message: 'Kalowave token cache invalidado' })
})

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check do servidor
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: Servidor online
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 uptime:
 *                   type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() })
})

/**
 * @swagger
 * /api/probe-country:
 *   get:
 *     summary: Validar se um country code ÃÂ© aceito pelo upstream Kalodata
 *     tags: [Session]
 *     parameters:
 *       - in: query
 *         name: country
 *         required: true
 *         schema: { type: string, enum: [BR, US, GB, DE, FR, ES, IT] }
 *     responses:
 *       200: { description: Resultado do probe (sucesso, sample size, erro se houver) }
 */
app.get('/api/probe-country', (req, res) => {
  const country = parseCountry(req)
  const t0 = Date.now()
  try {
    // Bate num endpoint barato (top 1 produto, sem agregaÃÂ§ÃÂµes pesadas) sÃÂ³ pra
    // validar que o upstream aceita o country code dado e responde com data.
    const range = getDateRange(7)
    const data = kaloPost('/product/queryList', {
      country,
      ...range,
      pageNo: 1,
      pageSize: 1,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: 'revenue', type: 'DESC' }],
    }, country)
    const sample = data?.data?.dataList?.[0] || null
    res.json({
      country,
      ok: !!data?.success,
      hasData: !!sample,
      sampleRevenue: sample?.revenue || null,
      sampleProductName: sample?.product_name || null,
      durationMs: Date.now() - t0,
      raw: data?.success ? undefined : data,
    })
  } catch (e) {
    res.status(500).json({
      country,
      ok: false,
      error: e.message,
      durationMs: Date.now() - t0,
    })
  }
})

// ---------------------------------------------------------------------------
// Video Insight (Kalowave)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/insight/{videoId}/url:
 *   get:
 *     summary: Obter URL direta do video (MP4)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: videoId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do video no TikTok
 *     responses:
 *       200:
 *         description: URL do video
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     url:
 *                       type: string
 *                     status:
 *                       type: integer
 *       500:
 *         description: Erro
 */
// In-memory cache for insight endpoints. Upstream (clip.kalowave.com) pode
// levar 30s+ pra responder script-analysis; transcript nunca muda por videoId,
// e a URL expira sÃÂ³ quando o CDN gira. TTLs: transcript 7d, url 30min.
const INSIGHT_TRANSCRIPT_TTL = 7 * 24 * 60 * 60 * 1000
const INSIGHT_URL_TTL = 30 * 60 * 1000
const insightCache = new Map() // key Ã¢ÂÂ { data, expiresAt }

function insightCacheGet(key) {
  const entry = insightCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    insightCache.delete(key)
    return null
  }
  return entry.data
}

function insightCacheSet(key, data, ttl) {
  insightCache.set(key, { data, expiresAt: Date.now() + ttl })
}

app.get('/api/insight/:videoId/url', (req, res) => {
  try {
    const key = `url:${req.params.videoId}`
    const cached = insightCacheGet(key)
    if (cached) return res.json(cached)
    const data = kalowaveGet(`/api/video/video-url?id=${req.params.videoId}&videoSource=Kalodata`)
    if (data && data.success !== false) insightCacheSet(key, data, INSIGHT_URL_TTL)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/insight/{videoId}/export:
 *   post:
 *     summary: Exportar video (consome creditos)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: videoId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: URL de download do video exportado
 *       500:
 *         description: Erro
 */
app.post('/api/insight/:videoId/export', (req, res) => {
  try {
    const data = kalowaveGet(`/api/video/download-url?id=${req.params.videoId}&videoSource=Kalodata`)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/insight/{videoId}/transcript:
 *   get:
 *     summary: Obter transcricao e analise do video
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: videoId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID do video no TikTok
 *       - in: query
 *         name: translate
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Traduzir transcricao
 *     responses:
 *       200:
 *         description: Transcricao e analise do video
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     language:
 *                       type: string
 *                     gender:
 *                       type: string
 *                     camera_work:
 *                       type: string
 *                     key_to_success:
 *                       type: string
 *                     video_scripts:
 *                       type: array
 *                       items:
 *                         type: object
 *       500:
 *         description: Erro
 */
app.get('/api/insight/:videoId/transcript', (req, res) => {
  try {
    const translate = req.query.translate === 'true'
    const key = `transcript:${req.params.videoId}:${translate ? 'pt' : 'orig'}`
    const cached = insightCacheGet(key)
    if (cached) return res.json(cached)
    const data = kalowaveGet(`/api/video/script-analysis?id=${req.params.videoId}&videoSource=Kalodata&translate=${translate}&collectionId=`)
    if (data && data.success !== false) insightCacheSet(key, data, INSIGHT_TRANSCRIPT_TTL)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/insight/{videoId}/transcript:
 *   post:
 *     summary: Gerar transcricao e analise do video (consome creditos)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: videoId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Transcricao gerada
 *       500:
 *         description: Erro
 */
app.post('/api/insight/:videoId/transcript', (req, res) => {
  try {
    const data = kalowavePost('/api/video/script-analysis', {
      id: req.params.videoId,
      videoSource: 'Kalodata',
      translate: false,
      collectionId: '',
    })
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Creator Avatar (TikTok profile scrape)
// ---------------------------------------------------------------------------
// Cache with timestamp-based expiry (reading the entry also validates freshness).
// TTL of 5min balances TikTok metrics staleness (follower count) vs scrape cost.
const TIKTOK_CACHE_TTL = 5 * 60 * 1000
const tiktokProfileCache = new Map()

function getTikTokCache(handle) {
  const entry = tiktokProfileCache.get(handle)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    tiktokProfileCache.delete(handle)
    return null
  }
  return entry.data
}

function setTikTokCache(handle, data) {
  tiktokProfileCache.set(handle, { data, expiresAt: Date.now() + TIKTOK_CACHE_TTL })
}

/**
 * @swagger
 * /api/creator/{handle}/avatar:
 *   get:
 *     summary: Raspa avatar e metricas publicas do TikTok (bio, followers, likes)
 *     tags: [Creators]
 *     parameters:
 *       - in: path
 *         name: handle
 *         required: true
 *         schema: { type: string }
 *         description: Handle do TikTok (sem @)
 *       - in: query
 *         name: refresh
 *         schema: { type: string, enum: ["1"] }
 *         description: Forca refresh ignorando cache de 5min
 *     responses:
 *       200:
 *         description: Dados publicos do perfil (cache 5min)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 cached: { type: boolean, description: true se resposta veio do cache local }
 *                 data:
 *                   type: object
 *                   properties:
 *                     url: { type: string, description: URL do avatar }
 *                     bioLink: { type: string }
 *                     followerCount: { type: integer }
 *                     followingCount: { type: integer }
 *                     heartCount: { type: integer }
 *                     videoCount: { type: integer }
 *       400: { description: Handle invalido }
 *       500: { description: Erro interno }
 */
app.get('/api/creator/:handle/avatar', (req, res) => {
  const { handle } = req.params
  const forceRefresh = req.query.refresh === '1'
  if (!handle || !/^[\w.]+$/.test(handle)) {
    return res.status(400).json({ success: false, message: 'Invalid handle' })
  }

  if (!forceRefresh) {
    const cached = getTikTokCache(handle)
    if (cached) return res.json({ success: true, data: cached, cached: true })
  }

  try {
    const args = [
      '-s', '--max-time', '10', '-L',
      '-A', UA,
      `https://www.tiktok.com/@${handle}`,
    ]
    const html = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 15000 })

    const data = {}

    // Extract avatar
    const avatarMatch = html.match(/"avatarLarger":"([^"]+)"/)
      || html.match(/"avatarMedium":"([^"]+)"/)
      || html.match(/"avatarThumb":"([^"]+)"/)
    if (avatarMatch) {
      data.url = avatarMatch[1].replace(/\\u002F/g, '/')
    }

    // Extract bio link
    const bioLinkMatch = html.match(/"bioLink":\{[^}]*"link":"([^"]+)"/)
    if (bioLinkMatch) {
      data.bioLink = bioLinkMatch[1].replace(/\\u002F/g, '/')
    }

    // Extract follower/following/likes counts
    const followingMatch = html.match(/"followingCount":(\d+)/)
    const followerMatch = html.match(/"followerCount":(\d+)/)
    const heartMatch = html.match(/"heartCount":(\d+)/)
    const videoMatch = html.match(/"videoCount":(\d+)/)
    if (followingMatch) data.followingCount = parseInt(followingMatch[1])
    if (followerMatch) data.followerCount = parseInt(followerMatch[1])
    if (heartMatch) data.heartCount = parseInt(heartMatch[1])
    if (videoMatch) data.videoCount = parseInt(videoMatch[1])

    if (data.url || data.bioLink) {
      setTikTokCache(handle, data)
      return res.json({ success: true, data, cached: false })
    }

    res.json({ success: false, message: 'Profile data not found' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Creator Search (TikTok handle -> ID + profile)
// ---------------------------------------------------------------------------

/**
 * @swagger
 * /api/creator/search/{handle}:
 *   get:
 *     summary: Busca criador no TikTok pelo handle e retorna userId + perfil completo
 *     tags: [Creators]
 *     parameters:
 *       - in: path
 *         name: handle
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: refresh
 *         schema: { type: string, enum: ["1"] }
 *         description: Forca refresh ignorando cache de 5min
 *     responses:
 *       200:
 *         description: Perfil completo com userId
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 cached: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     userId: { type: string }
 *                     handle: { type: string }
 *                     nickname: { type: string }
 *                     signature: { type: string, description: Bio do criador }
 *                     url: { type: string }
 *                     bioLink: { type: string }
 *                     followerCount: { type: integer }
 *                     followingCount: { type: integer }
 *                     heartCount: { type: integer }
 *                     videoCount: { type: integer }
 *       400: { description: Handle invalido }
 *       500: { description: Erro interno }
 */
app.get('/api/creator/search/:handle', (req, res) => {
  const { handle } = req.params
  const forceRefresh = req.query.refresh === '1'
  if (!handle || !/^[\w.]+$/.test(handle)) {
    return res.status(400).json({ success: false, message: 'Invalid handle' })
  }

  // Check cache first (avatar endpoint caches profile data).
  // Only serve from cache if the entry has userId (search needs it).
  if (!forceRefresh) {
    const cached = getTikTokCache(handle)
    if (cached && cached.userId) {
      return res.json({ success: true, data: cached, cached: true })
    }
  }

  try {
    const args = [
      '-s', '--max-time', '10', '-L',
      '-A', UA,
      `https://www.tiktok.com/@${handle}`,
    ]
    const html = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 15000 })

    const data = {}

    // Extract user ID
    const idMatch = html.match(/"id":"(\d+)"/)
    if (idMatch) data.userId = idMatch[1]

    // Extract avatar
    const avatarMatch = html.match(/"avatarLarger":"([^"]+)"/)
      || html.match(/"avatarMedium":"([^"]+)"/)
      || html.match(/"avatarThumb":"([^"]+)"/)
    if (avatarMatch) data.url = avatarMatch[1].replace(/\\u002F/g, '/')

    // Extract nickname
    const nicknameMatch = html.match(/"nickname":"([^"]+)"/)
    if (nicknameMatch) data.nickname = nicknameMatch[1]

    // Extract bio
    const signatureMatch = html.match(/"signature":"([^"]*)"/)
    if (signatureMatch) data.signature = signatureMatch[1].replace(/\\n/g, '\n')

    // Extract bio link
    const bioLinkMatch = html.match(/"bioLink":\{[^}]*"link":"([^"]+)"/)
    if (bioLinkMatch) data.bioLink = bioLinkMatch[1].replace(/\\u002F/g, '/')

    // Extract counts
    const followingMatch = html.match(/"followingCount":(\d+)/)
    const followerMatch = html.match(/"followerCount":(\d+)/)
    const heartMatch = html.match(/"heartCount":(\d+)/)
    const videoMatch = html.match(/"videoCount":(\d+)/)
    if (followingMatch) data.followingCount = parseInt(followingMatch[1])
    if (followerMatch) data.followerCount = parseInt(followerMatch[1])
    if (heartMatch) data.heartCount = parseInt(heartMatch[1])
    if (videoMatch) data.videoCount = parseInt(videoMatch[1])

    data.handle = handle

    if (data.userId) {
      setTikTokCache(handle, data)
      return res.json({ success: true, data, cached: false })
    }

    res.json({ success: false, message: 'Creator not found on TikTok' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})


// ---------------------------------------------------------------------------
// Live (Livestream) detail endpoints
// /api/live/:id/detail      â combina /livestream/detail + /livestream/detail/total
// /api/live/:id/products    â /livestream/detail/product/queryList + count
// /api/live/:id/chart       â /livestream/detail/history
// /api/live/:id/categories  â /livestream/detail/productStrategy
//
// Paths confirmados via DevTools do Kalodata em 2026-05-27.
// Para lives encerradas (finish_time no passado) os dados nao mudam mais,
// entao usamos TTL longo (6h para detail/products, 24h para chart/categories).
// Para lives ativas (finish_time nulo ou no futuro) usamos TTL curto (5 min).
// ---------------------------------------------------------------------------

const LIVE_CACHE_SHORT = 5 * 60 * 1000          // 5 min â live ativa
const LIVE_CACHE_DETAIL = 6 * 60 * 60 * 1000     // 6 h  â detail / products
const LIVE_CACHE_LONG   = 24 * 60 * 60 * 1000    // 24 h â chart / categories
const liveCache = new Map()

function liveCacheGet(key) {
  const entry = liveCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    liveCache.delete(key)
    return null
  }
  return entry.data
}

function liveCacheSet(key, data, ttl) {
  liveCache.set(key, { data, expiresAt: Date.now() + ttl })
}

// Determina o TTL adequado dado o finish_time da live (unix segundos ou null).
function liveTtl(finishTimeUnix, baseTtl) {
  if (!finishTimeUnix) return LIVE_CACHE_SHORT
  const finishMs = parseInt(finishTimeUnix) * 1000
  if (Date.now() < finishMs) return LIVE_CACHE_SHORT
  return baseTtl
}

// Converte timestamp da live para YYYY-MM-DD
function liveTimestampToDate(ts) {
  const d = new Date(parseInt(ts) * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + dd
}

// Parseia finish_time que pode vir como unix (inteiro/string) ou "2026/05/26 20:05:27"
function parseFinishTime(ft) {
  if (!ft) return null
  if (/^\d{10,}$/.test(String(ft))) return parseInt(ft)
  const s2 = String(ft).replace(/\//g, '-').replace(' ', 'T')
  const parsed = new Date(s2.includes(':') && s2.split('T')[1]?.split(':').length >= 3 ? s2 : s2 + ':00')
  return isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000)
}

// Parseia create_time que vem como "2026/05/22 07:05:00"
function parseCreateTime(ct) {
  if (!ct) return null
  if (/^\d{10,}$/.test(String(ct))) return parseInt(ct)
  const s = String(ct).replace(/\//g, '-').replace(' ', 'T')
  const parsed = new Date(s.includes(':') && s.split('T')[1]?.split(':').length >= 3 ? s : s + ':00')
  return isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000)
}

/**
 * @swagger
 * /api/live/{id}/detail:
 *   get:
 *     summary: Cabecalho da live (criador, categorias, janela, duracao, metricas)
 *     tags: [Lives]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ID da live no TikTok
 *     responses:
 *       200: { description: Dados completos da live }
 *       500: { description: Erro interno }
 */
app.get('/api/live/:id/detail', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const cacheKey = `live:detail:${id}:${country}`

    const cached = liveCacheGet(cacheKey)
    if (cached) return res.json({ success: true, data: cached, cached: true })

    // 1. Dados base da live
    const baseResp = kaloPost('/livestream/detail', { id }, country)
    if (!baseResp || !baseResp.success) {
      return res.status(502).json({ success: false, message: baseResp?.message || 'upstream error on /livestream/detail' })
    }
    const base = baseResp.data?.base || baseResp.data || {}

    // 2. Metricas totais (revenue, sale, views, unit_price) â requer date range
    const createUnix = parseCreateTime(base.create_time)
    const finishUnix = parseFinishTime(base.finish_time)

    let totalData = {}
    if (createUnix) {
      const startDate = liveTimestampToDate(createUnix)
      const today = new Date()
      const endUnix = finishUnix || Math.floor(today.getTime() / 1000)
      const endDate = liveTimestampToDate(Math.min(endUnix, Math.floor(today.getTime() / 1000)))
      try {
        const totalResp = kaloPost('/livestream/detail/total', { id, startDate, endDate }, country)
        if (totalResp && totalResp.success) totalData = totalResp.data || {}
      } catch (_) { /* best-effort */ }
    }

    const data = {
      id,
      title: base.title || null,
      handle: base.handle || null,
      nickname: base.nickname || base.handle || null,
      creator_uid: base.creator_id || base.uid || null,
      avatar_url: base.avatar_url || null,
      categories: base.main_category || [],
      main_category_ids: base.main_category || [],
      start_time: base.create_time || null,
      finish_time: base.finish_time || null,
      duration: base.duration || null,
      duration_seconds: base.record_duration ? Math.round(base.record_duration / 1000) : null,
      products_count: parseInt(base.product_count) || 0,
      revenue: totalData.revenue || base.revenue || null,
      revenue_raw: null,
      sale: totalData.sale || (base.sale ? String(base.sale) : null),
      views: totalData.views || (base.views ? String(base.views) : null),
      views_raw: typeof base.views === 'number' ? base.views : null,
      viewers_count: totalData.viewer_num != null ? parseInt(totalData.viewer_num) : null,
      viewers_count_label: totalData.viewer_num != null ? String(totalData.viewer_num) : null,
      unit_price: totalData.unit_price || base.unit_price || null,
      screenshot_url: base.screenshotUrl || null,
      short_url: base.shortUrl || null,
      country: country,
      currency: headersForCountry(country).currency,
    }

    const ttl = liveTtl(finishUnix, LIVE_CACHE_DETAIL)
    liveCacheSet(cacheKey, data, ttl)

    res.json({ success: true, data, cached: false })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/live/{id}/products:
 *   get:
 *     summary: Lista paginada de produtos vendidos na live
 *     tags: [Lives]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: sortField
 *         schema: { type: string, default: revenue, enum: [revenue, sale, unit_price] }
 *     responses:
 *       200: { description: Produtos da live }
 *       500: { description: Erro interno }
 */
app.get('/api/live/:id/products', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const page = parseInt(req.query.page) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize) || 10, 100)
    const sortField = req.query.sortField || 'revenue'
    const categoryId = req.query.categoryId || ''

    const cacheKey = `live:products:${id}:${country}:${page}:${pageSize}:${sortField}:${categoryId}`
    const cached = liveCacheGet(cacheKey)
    if (cached) return res.json({ success: true, data: cached.items, total: cached.total, page, pageSize, cached: true })

    // Obter date range a partir do detalhe da live
    let startDate, endDate, finishUnix = null

    const detailCacheKey = `live:detail:${id}:${country}`
    const detailCached = liveCacheGet(detailCacheKey)
    if (detailCached) {
      const s = parseCreateTime(detailCached.start_time)
      const f = parseFinishTime(detailCached.finish_time)
      if (s) startDate = liveTimestampToDate(s)
      if (f) { finishUnix = f; endDate = liveTimestampToDate(f) }
    }

    // Fallback: buscar do upstream
    if (!startDate) {
      try {
        const baseResp = kaloPost('/livestream/detail', { id }, country)
        const base = baseResp?.data?.base || baseResp?.data || {}
        const s = parseCreateTime(base.create_time)
        const f = parseFinishTime(base.finish_time)
        if (s) startDate = liveTimestampToDate(s)
        if (f) { finishUnix = f; endDate = liveTimestampToDate(f) }
      } catch (_) { /* best-effort */ }
    }

    if (!endDate) endDate = new Date().toISOString().slice(0, 10)
    if (!startDate) startDate = endDate

    const payload = { id, startDate, endDate, pageNo: page, pageSize, sort: [{ field: sortField, type: 'DESC' }] }
    if (categoryId) payload.cateValue = [categoryId]
    const listResp = kaloPost('/livestream/detail/product/queryList', payload, country)
    if (!listResp || !listResp.success) {
      return res.status(502).json({ success: false, message: listResp?.message || 'upstream error on product/queryList' })
    }

    // Contagem total
    let total = null
    try {
      const countResp = kaloPost('/livestream/detail/product/count', { id, startDate, endDate, ...(categoryId ? { cateValue: [categoryId] } : {}) }, country)
      if (countResp && countResp.success) total = countResp.data
    } catch (_) { /* best-effort */ }

    const items = (listResp.data || []).map((p, i) => ({
      rank: (page - 1) * pageSize + i + 1,
      id: p.id || null,
      name: p.product_title || null,
      image_url: p.image_url || null,
      revenue: p.revenue || null,
      revenue_raw: null,
      sale: p.sale || null,
      unit_price: p.unit_price || null,
    }))

    const ttl = liveTtl(finishUnix, LIVE_CACHE_DETAIL)
    liveCacheSet(cacheKey, { items, total }, ttl)

    res.json({ success: true, data: items, total, page, pageSize, cached: false })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/live/{id}/chart:
 *   get:
 *     summary: Serie temporal de receita ao longo da live
 *     tags: [Lives]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Pontos de receita ao longo do tempo }
 *       500: { description: Erro interno }
 */
app.get('/api/live/:id/chart', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const cacheKey = `live:chart:${id}:${country}`

    const cached = liveCacheGet(cacheKey)
    if (cached) return res.json({ success: true, data: cached, cached: true })

    const resp = kaloPost('/livestream/detail/history', { id }, country)
    if (!resp || !resp.success) {
      return res.status(502).json({ success: false, message: resp?.message || 'upstream error on /livestream/detail/history' })
    }

    const raw = resp.data || []

    // Intervalo mediano entre pontos (segundos)
    let intervalSeconds = 300
    if (raw.length >= 2) {
      const diffs = []
      for (let i = 1; i < Math.min(raw.length, 20); i++) {
        const d = parseInt(raw[i].finish_time) - parseInt(raw[i - 1].finish_time)
        if (d > 0) diffs.push(d)
      }
      if (diffs.length > 0) {
        diffs.sort((a, b) => a - b)
        intervalSeconds = diffs[Math.floor(diffs.length / 2)]
      }
    }

    const points = raw.map(p => ({
      ts: new Date(parseInt(p.finish_time) * 1000).toISOString(),
      revenue: parseFloat(p.revenue) || 0,
      sale: parseInt(p.total_user_incre) || 0,
    }))

    // Se o ultimo ponto e mais de 1h atras, a live esta encerrada -> TTL 24h
    const lastPoint = raw[raw.length - 1]
    const lastTs = lastPoint ? parseInt(lastPoint.finish_time) * 1000 : 0
    const isFinished = lastTs > 0 && (Date.now() - lastTs) > 3600 * 1000
    const ttl = isFinished ? LIVE_CACHE_LONG : LIVE_CACHE_SHORT

    const data = { points, interval_seconds: intervalSeconds }
    liveCacheSet(cacheKey, data, ttl)

    res.json({ success: true, data, cached: false })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/live/{id}/categories:
 *   get:
 *     summary: Breakdown de receita por categoria (com total agregado)
 *     tags: [Lives]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Receita por categoria }
 *       500: { description: Erro interno }
 */
app.get('/api/live/:id/categories', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const cacheKey = `live:categories:${id}:${country}`

    const cached = liveCacheGet(cacheKey)
    if (cached) return res.json({ success: true, data: cached, cached: true })

    const resp = kaloPost('/livestream/detail/productStrategy', { id }, country)
    if (!resp || !resp.success) {
      return res.status(502).json({ success: false, message: resp?.message || 'upstream error on /livestream/detail/productStrategy' })
    }

    const raw = resp.data || []

    // Item com id="-1" e percentage=100 e o total de todas as categorias
    const totalItem = raw.find(c => String(c.id) === '-1' || String(c.percentage) === '100')
    const items = raw
      .filter(c => String(c.id) !== '-1' && String(c.id) !== '0' && c.cate_id !== null && c.cate_id !== 'Others')
      .map(c => ({
        id: String(c.id),
        label: c.cate_id || String(c.id),
        revenue: c.revenue || null,
        revenue_raw: null,
      }))

    const data = {
      total: {
        label: 'Total das categorias',
        revenue: totalItem ? totalItem.revenue : null,
        revenue_raw: null,
      },
      items,
    }

    liveCacheSet(cacheKey, data, LIVE_CACHE_LONG)
    res.json({ success: true, data, cached: false })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Legacy proxy (mantido para compatibilidade com o frontend)
// ---------------------------------------------------------------------------
app.use('/api/kalo', (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST only' })
  }
  const country = parseCountry(req)
  const kaloPath = req.url || '/'
  try {
    const data = kaloPost(kaloPath, req.body || {}, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kalodata API running on http://localhost:${PORT}`)
  console.log(`Swagger docs: http://localhost:${PORT}/api/docs`)
  console.log(`Cookies loaded: ${getCookies() ? 'YES' : 'NO'}`)
  console.log(`Cookie check cron: ${config.cookie_check_cron}`)
})
