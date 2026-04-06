import express from 'express'
import cors from 'cors'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { Resend } from 'resend'
import cron from 'node-cron'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = 3456
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

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
    kalowave_cookies: ''
  }
  try {
    const raw = readFileSync('config.json', 'utf-8')
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return defaults
  }
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
function kaloPost(path, body) {
  const cookies = getCookies()
  if (!cookies) throw new Error('cookies.txt not found or empty')

  const args = [
    '-s', '--max-time', '30',
    '-A', UA,
    '-b', cookies,
    '-H', 'content-type: application/json',
    '-H', 'country: BR',
    '-H', 'currency: BRL',
    '-H', 'language: pt-BR',
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
  ]

  const result = execFileSync('curl', args, { encoding: 'utf-8', timeout: 35000 })
  return JSON.parse(result)
}

// ---------------------------------------------------------------------------
// Kalowave (clip.kalowave.com) proxy helper
// ---------------------------------------------------------------------------
let kalowaveCache = { token: '', expiresAt: 0 }

function getKalowaveToken() {
  // Use cache if valid (10 min margin)
  if (kalowaveCache.token && Date.now() < kalowaveCache.expiresAt - 600000) {
    return kalowaveCache.token
  }

  const cfg = loadConfig()

  // Auto: Kalodata cookies → SSO token → Kalowave access token
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
      const ssoResult = JSON.parse(execFileSync('curl', ssoArgs, { encoding: 'utf-8', timeout: 20000 }))

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

        const oauthResult = JSON.parse(execFileSync('curl', oauthArgs, { encoding: 'utf-8', timeout: 20000 }))

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

  const result = execFileSync('curl', args, { encoding: 'utf-8', timeout: 35000 })
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

  const result = execFileSync('curl', args, { encoding: 'utf-8', timeout: 35000 })
  return JSON.parse(result)
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function getDateRange(days) {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  const fmt = (d) => d.toISOString().split('T')[0]
  return { startDate: fmt(start), endDate: fmt(end) }
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
    console.warn('[ALERT] Resend not configured — skipping alert. Set resend_api_key and email_to in config.json.')
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
    console.warn('[CRON] Session invalid — sending alert')
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
app.get('/api/products', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/product/queryList', {
      country: 'BR',
      ...range,
      pageNo: page,
      pageSize,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    })
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
    const result = execFileSync('curl', [
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
app.get('/api/videos', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/video/queryList', {
      country: 'BR',
      ...range,
      pageNo: page,
      pageSize,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    })
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
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20

    const data = kaloPost('/homepage/hot/video/queryList', {
      country: 'BR',
      pageIndex: page,
      pageSize,
    })
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
app.get('/api/creators', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize) || 10, 10)
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/creator/queryList', {
      country: 'BR',
      ...range,
      pageNo: page,
      pageSize,
      cateIds: [],
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    })
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
    const keyword = (req.query.keyword || '').trim()
    if (!keyword) return res.json({ success: true, data: [] })

    const data = kaloPost('/overview/fullText/search', {
      country_code: 'br',
      keyword,
      scope: [{ index: 'creator', pageNo: 1, pageSize: 20 }],
    })
    const creators = data?.data?.creator || []
    res.json({ success: true, data: creators })
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
    })
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
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)

    const data = kaloPost('/creator/detail/total', {
      id,
      ...range,
      cateIds: [],
      sellerId: '',
      authority: true,
    })
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
app.get('/api/session', (_req, res) => {
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
app.get('/api/cookies', (_req, res) => {
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
app.put('/api/cookies', (req, res) => {
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
app.post('/api/alerts/test', async (_req, res) => {
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
app.get('/api/config', (_req, res) => {
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
app.put('/api/config', (req, res) => {
  const current = loadConfig()
  const updated = { ...current, ...req.body }
  writeFileSync('config.json', JSON.stringify(updated, null, 2), 'utf-8')
  res.json({ success: true, message: 'Configuracao atualizada' })
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
app.get('/api/insight/:videoId/url', (req, res) => {
  try {
    const data = kalowaveGet(`/api/video/video-url?id=${req.params.videoId}&videoSource=Kalodata`)
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
    const data = kalowaveGet(`/api/video/script-analysis?id=${req.params.videoId}&videoSource=Kalodata&translate=${translate}&collectionId=`)
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
const tiktokProfileCache = new Map()

app.get('/api/creator/:handle/avatar', (req, res) => {
  const { handle } = req.params
  if (!handle || !/^[\w.]+$/.test(handle)) {
    return res.status(400).json({ success: false, message: 'Invalid handle' })
  }

  if (tiktokProfileCache.has(handle)) {
    return res.json({ success: true, data: tiktokProfileCache.get(handle) })
  }

  try {
    const args = [
      '-s', '--max-time', '10', '-L',
      '-A', UA,
      `https://www.tiktok.com/@${handle}`,
    ]
    const html = execFileSync('curl', args, { encoding: 'utf-8', timeout: 15000 })

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
      tiktokProfileCache.set(handle, data)
      setTimeout(() => tiktokProfileCache.delete(handle), 3600000)
      return res.json({ success: true, data })
    }

    res.json({ success: false, message: 'Profile data not found' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ---------------------------------------------------------------------------
// Creator Search (TikTok handle -> ID + profile)
// ---------------------------------------------------------------------------
app.get('/api/creator/search/:handle', (req, res) => {
  const { handle } = req.params
  if (!handle || !/^[\w.]+$/.test(handle)) {
    return res.status(400).json({ success: false, message: 'Invalid handle' })
  }

  // Check cache first (avatar endpoint caches profile data)
  if (tiktokProfileCache.has(handle) && tiktokProfileCache.get(handle).userId) {
    return res.json({ success: true, data: tiktokProfileCache.get(handle) })
  }

  try {
    const args = [
      '-s', '--max-time', '10', '-L',
      '-A', UA,
      `https://www.tiktok.com/@${handle}`,
    ]
    const html = execFileSync('curl', args, { encoding: 'utf-8', timeout: 15000 })

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
      tiktokProfileCache.set(handle, data)
      setTimeout(() => tiktokProfileCache.delete(handle), 3600000)
      return res.json({ success: true, data })
    }

    res.json({ success: false, message: 'Creator not found on TikTok' })
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
  const kaloPath = req.url || '/'
  try {
    const data = kaloPost(kaloPath, req.body || {})
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
