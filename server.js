import express from 'express'
import cors from 'cors'
import { execFileSync, execFile } from 'child_process'
import { createHmac, createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync, statSync, createReadStream, unlinkSync, renameSync, copyFile } from 'fs'
import { Resend } from 'resend'
import cron from 'node-cron'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { headersForCountry, parseCountry, countryLowercase, DEFAULT_COUNTRY, COUNTRY_CONFIG } from './lib/countries.js'
import { runScraperFn, getQueueStats } from './lib/scraper-queue.js'
import { newHeaderDumpPath, headerDumpArgs, absorbHeaderDump } from './lib/cookie-jar.js'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = parseInt(process.env.PORT) || 4001
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// Proxy pool — GEO-AWARE (Tarefa 2)
// ---------------------------------------------------------------------------
// Prioridade:
//   1. PROXY_URL_TEMPLATE  — substitui {CC} pelo country em minúsculas (geo-aware)
//      Ex: http://user:pass_country-{CC}@geo.iproyal.com:12321
//   2. PROXY_LIST          — pool fixo de URLs (round-robin, como antes)
//   3. PROXY_URL           — URL único/rotativo (como antes)
//   4. (nada)              — sem proxy
// ---------------------------------------------------------------------------

const VALID_CC = new Set(['br','us','gb','de','fr','es','it'])
const PROXY_TEMPLATE = process.env.PROXY_URL_TEMPLATE
  ? process.env.PROXY_URL_TEMPLATE.trim()
  : null

const PROXY_URLS = (() => {
  if (PROXY_TEMPLATE) return [] // não usa pool fixo quando template está ativo
  if (process.env.PROXY_LIST) {
    return process.env.PROXY_LIST.split(',').map(p => p.trim()).filter(Boolean)
  }
  if (process.env.PROXY_URL) {
    return [process.env.PROXY_URL.trim()]
  }
  return []
})()

let _proxyIdx = 0

/**
 * Retorna a URL de proxy para o country informado.
 * - Se PROXY_URL_TEMPLATE está definido, substitui {CC} pelo cc do país (geo-aware).
 * - Caso contrário, usa pool round-robin (PROXY_LIST/PROXY_URL).
 * - Retorna null se nenhuma config de proxy existir.
 * @param {string} [country] - ex: 'BR', 'us', 'GB'
 */
function getNextProxy (country) {
  if (PROXY_TEMPLATE) {
    const cc = (typeof country === 'string' ? country.toLowerCase() : 'br')
    const finalCc = VALID_CC.has(cc) ? cc : 'br'
    return PROXY_TEMPLATE.replace('{CC}', finalCc)
  }
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
    const proxy = getNextProxy(country)
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
// TikTok fetch (download de vídeo público via yt-dlp)
// ---------------------------------------------------------------------------
// POST /api/tiktok/fetch  body: { url }
// Baixa o mp4 de um vídeo público do TikTok e devolve o binário (video/mp4).
// Usado pela edge import-tiktok-video do Domma (usuário cola o link no chat e
// o vídeo entra na conversa como anexo analisável). Erros viram códigos
// estáveis pra UI explicar o motivo ao usuário:
//   invalid_url | not_found | private | region_blocked | too_large |
//   timeout | ytdlp_missing | download_failed
const TIKTOK_URL_RE = /^https?:\/\/(www\.|vm\.|vt\.|m\.)?tiktok\.com\/\S+$/i
// Prefere o binário standalone atualizado (baixado pelo postinstall
// scripts/ensure-ytdlp.cjs); o do sistema (apt) é de 2022 e está quebrado.
const YTDLP_BIN = existsSync('./bin/yt-dlp') ? './bin/yt-dlp' : 'yt-dlp'

// Handshake usado em TODA chamada de yt-dlp ao TikTok/Instagram.
//
// `--impersonate chrome` (sem versão) resolve para o alvo mais novo do
// curl_cffi — hoje chrome-146/macos-26 — e desde 10/08/2026 o Akamai do TikTok
// NEGA esse handshake: devolve 200 com uma página "Site Maintenance" de 537
// bytes (`x-cache: TCP_DENIED`), sem os dados do vídeo. O yt-dlp então morre em
// `_solve_challenge_and_set_cookies` com "Unexpected response from webpage
// request" e todo download público falhava. Não é o yt-dlp desatualizado: a
// nightly 2026.08.04 falha igual, e o issue upstream 17403 segue aberto.
//
// Medido na VPS: o alvo antigo `chrome-116` (perfil Windows) passa 5/5, e o
// User-Agent explícito de Chrome/Windows é o que faz o Akamai entregar a página
// real — com UA de macOS a mesma requisição volta bloqueada. O Instagram baixa
// igual nos dois. Se voltar a falhar em massa, o teste de um minuto é
// `./bin/yt-dlp --impersonate <alvo> --user-agent "<ua>" --get-title <link>`
// varrendo os alvos de `--list-impersonate-targets`.
const YTDLP_IMPERSONATE = 'chrome-116'
const YTDLP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// ── Fallback do TikTok pelo ScrapeCreators (15/08/2026) ─────────────────────
// O extractor de TikTok do yt-dlp quebrou GLOBALMENTE: a estável 2026.07.04 e a
// nightly 2026.08.04 falham igual, em TODOS os alvos de impersonate, com e sem
// proxy residencial, e também fora desta VPS (testado de uma máquina doméstica
// com IP brasileiro). O dump da página tem 537 bytes com "Site Maintenance", que
// é a assinatura de bloqueio do Akamai. Ou seja: não é alvo de handshake, não é
// IP e não é versão, então trocar configuração não resolve.
//
// O ScrapeCreators (que o projeto já assina e já usa para o Radar e a Fábrica)
// devolve o `play_addr` do vídeo, e ele baixa LIMPO, sem marca d'água: conferido
// no frame em 15/08. O `has_watermark: true` do payload se refere ao
// `download_addr`, que é o do botão de download do app; o `play_addr` é o que o
// app reproduz.
//
// A URL expira em algumas horas, e é por isso que `_shared/scrapecreators.ts`
// do lado das edges guarda `videoUrl: null` de propósito. Aqui não importa: o
// download é IMEDIATO e o arquivo vai para o bucket logo em seguida.
//
// Fica como FALLBACK, e não como caminho principal, por dois motivos: cada
// chamada consome crédito da conta, e o yt-dlp volta a ser melhor no dia em que
// o upstream consertar (ele entrega o formato já escolhido pelo seletor `-f`,
// que é o que garante h264 com áudio).
const SCRAPECREATORS_KEY = process.env.SCRAPECREATORS_API_KEY || ''
const SCRAPECREATORS_VIDEO_URL = 'https://api.scrapecreators.com/v2/tiktok/video'
/** Teto do arquivo vindo do fallback, espelhando o --max-filesize do yt-dlp. */
const SC_MAX_BYTES = 250 * 1024 * 1024
const SC_TIMEOUT_MS = 60000

/**
 * Baixa o mp4 do TikTok pelo ScrapeCreators e grava em `destino`.
 * Devolve null quando deu certo, ou um código de erro para o chamador registrar.
 *
 * Só as fontes SEM marca d'água entram: `play_addr` (a que o app reproduz) e
 * `play_addr_h264` (a mesma coisa, com o codec garantido). O `download_addr`
 * ficou de fora em 31/08/2026 — ele é o arquivo do botão de download do app, e
 * chega com o logo do TikTok e o @ do autor queimados no quadro.
 */
async function baixarTikTokViaScrapeCreators (url, destino) {
  if (!SCRAPECREATORS_KEY) return 'sc_sem_chave'
  let detalhe
  try {
    const resp = await fetch(`${SCRAPECREATORS_VIDEO_URL}?url=${encodeURIComponent(url)}`, {
      headers: { 'x-api-key': SCRAPECREATORS_KEY },
      signal: AbortSignal.timeout(SC_TIMEOUT_MS),
    })
    if (!resp.ok) return `sc_http_${resp.status}`
    const corpo = await resp.json()
    detalhe = corpo && corpo.aweme_detail
  } catch (e) {
    return 'sc_indisponivel'
  }
  const video = (detalhe && detalhe.video) || null
  if (!video) return 'sc_sem_video'

  const candidatas = []
  for (const campo of ['play_addr', 'play_addr_h264']) {
    const lista = (video[campo] && video[campo].url_list) || []
    for (const u of lista) if (typeof u === 'string' && u) candidatas.push(u)
  }
  if (!candidatas.length) return 'sc_sem_url'

  // As URLs do CDN do TikTok recusam requisição sem UA de navegador e sem
  // Referer do próprio tiktok.com: sem os dois vem 403.
  const cabecalhos = { 'User-Agent': YTDLP_UA, Referer: 'https://www.tiktok.com/' }
  for (const candidata of candidatas) {
    try {
      const r = await fetch(candidata, { headers: cabecalhos, signal: AbortSignal.timeout(SC_TIMEOUT_MS) })
      if (!r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      // Uma página de erro do CDN também chega com 200: um mp4 de verdade não
      // tem 50 KB, e deixar passar viraria "arquivo quebrado" lá na frente.
      if (buf.length < 50000) continue
      if (buf.length > SC_MAX_BYTES) return 'too_large'
      writeFileSync(destino, buf)
      return null
    } catch (e) {
      // Próxima candidata: a lista traz o mesmo arquivo em CDNs diferentes.
    }
  }
  return 'sc_download_falhou'
}

// ── Caminho próprio do TikTok, pelo FlareSolverr (17/08/2026) ───────────────
// O ScrapeCreators cobra por chamada, e em 17/08 a conta zerou: com o extractor
// do yt-dlp quebrado, o baixador parou INTEIRO (HTTP 402, "out of credits"). O
// que o serviço pago faz por nós é uma coisa só: abrir a página num navegador de
// verdade, que é o que o Akamai do TikTok exige desde 15/08.
//
// Só que navegador de verdade nós já temos nesta máquina: o FlareSolverr que
// renova o cf_clearance da sessão de mercado a cada 20 min. Medido em 17/08 no
// mesmo link que falhava na tela: ele abre a página ("Challenge not detected"),
// resolve o encurtador vt.tiktok.com até a URL real e devolve o HTML com o bloco
// __UNIVERSAL_DATA_FOR_REHYDRATION__, de onde sai o endereço do arquivo. O mp4
// baixou h264+aac, íntegro no ffprobe, sem gastar crédito.
//
// Por isso este caminho entra ANTES do pago: mesma capacidade, custo zero por
// vídeo. O ScrapeCreators fica como última rede, para o dia em que o TikTok
// mudar o formato da página e este extrator aqui precisar de manutenção.
//
// NÃO usa a sessão nomeada `kalodata-session`: aquela guarda o login do mercado
// e é a coisa mais frágil da VPS (só volta com humano logando). Sessão anônima
// por chamada custa alguns segundos a mais e não tem como contaminar o login.
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1'
const FS_PAGE_TIMEOUT_MS = 90000
const FS_DOWNLOAD_TIMEOUT_MS = 60000

/** Lê os codecs presentes no arquivo. Devolve { video, audio } em minúsculas. */
function codecsDoArquivo (caminho) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', caminho], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve({ video: '', audio: '' })
      const achado = { video: '', audio: '' }
      for (const linha of String(stdout || '').trim().split('\n')) {
        const [nome, tipo] = linha.trim().split(',')
        if (tipo === 'video' && !achado.video) achado.video = String(nome || '').toLowerCase()
        if (tipo === 'audio' && !achado.audio) achado.audio = String(nome || '').toLowerCase()
      }
      resolve(achado)
    })
  })
}

/** Abre uma URL no FlareSolverr. Devolve a `solution` ou null. */
async function abrePaginaNoFlareSolverr (url) {
  try {
    const resp = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: FS_PAGE_TIMEOUT_MS - 10000 }),
      signal: AbortSignal.timeout(FS_PAGE_TIMEOUT_MS),
    })
    if (!resp.ok) return null
    const corpo = await resp.json()
    if (!corpo || corpo.status !== 'ok') return null
    return corpo.solution || null
  } catch (e) {
    return null
  }
}

/**
 * Candidatas da PÁGINA NORMAL do vídeo, que é a de melhor qualidade: o
 * `bitrateInfo` lista as faixas, e nele existe 1080p (medido 17/08: a página
 * oferece 1080x1920, enquanto o embed só tem 576x1024).
 *
 * A ordem segue a mesma regra do seletor `-f` do yt-dlp: h264 primeiro (as
 * faixas h265/bytevc1 do TikTok vêm sem trilha de áudio na prática) e, entre as
 * h264, a de maior quadro.
 */
function candidatasDaPagina (html) {
  const bloco = html.match(/id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  if (!bloco) return null
  let item
  try {
    item = JSON.parse(bloco[1]).__DEFAULT_SCOPE__['webapp.video-detail'].itemInfo.itemStruct
  } catch (e) {
    return null
  }
  if (item && item.imagePost) return { photo: true, urls: [] }
  const video = item && item.video
  if (!video) return null

  const faixas = Array.isArray(video.bitrateInfo) ? video.bitrateInfo.slice() : []
  const pontua = (f) => {
    const pa = f.PlayAddr || {}
    const codec = String(f.CodecType || '').toLowerCase()
    const ehH264 = !codec || codec.includes('h264') || codec.includes('avc')
    return [ehH264 ? 1 : 0, (Number(pa.Width) || 0) * (Number(pa.Height) || 0), Number(f.Bitrate) || 0]
  }
  faixas.sort((a, b) => {
    const [ah, aq, ab] = pontua(a)
    const [bh, bq, bb] = pontua(b)
    return (bh - ah) || (bq - aq) || (bb - ab)
  })

  const urls = []
  for (const faixa of faixas) {
    for (const u of (faixa.PlayAddr && faixa.PlayAddr.UrlList) || []) {
      if (typeof u === 'string' && u) urls.push(u)
    }
  }
  // `playAddr` sim, `downloadAddr` NUNCA. O segundo é o arquivo do botão
  // "Salvar vídeo" do app e vem com a marca d'água QUEIMADA na imagem: logo do
  // TikTok, @ do autor e, nos vídeos de TikTok Shop, a faixa "Unauthorised
  // commercial use of video strictly prohibited". Ele era a última candidata
  // "porque arquivo com marca ainda é melhor que erro" — não é: quem baixa aqui
  // baixa para editar e publicar, e a marca inviabiliza o uso. Erro é resposta
  // melhor do que vídeo marcado.
  if (typeof video.playAddr === 'string' && video.playAddr) urls.push(video.playAddr)
  return urls.length ? { photo: false, urls } : null
}

/**
 * Candidatas da página de EMBED (`/embed/v2/<id>`).
 *
 * ATENÇÃO (31/08/2026): o embed entrega SÓ o stream COM MARCA D'ÁGUA. Medido
 * hoje em 4 vídeos, um deles o que o cliente reclamou: a única URL de vídeo do
 * payload (`itemInfos.video.urls`, e as duas cópias dela no `<video src>` da
 * página) aponta para o bucket `tos-*-ve-*`, e o frame extraído mostra o logo
 * do TikTok, o @ do autor e, em vídeo de TikTok Shop, a faixa "Unauthorised
 * commercial use of video strictly prohibited". Não há no embed nenhuma outra
 * URL de vídeo para escolher — a `tos-alisg-v-*` que aparece no HTML é a trilha
 * sonora. Ou seja, este caminho NÃO tem conserto por parsing.
 *
 * Foi ele que virou o primeiro da fila em 24/08 (commit `cd9ace2`), quando a
 * comparação entre os caminhos olhou codec e resolução e não olhou o quadro.
 * Desde então todo download de TikTok saía marcado. Agora ele só entra com
 * TIKTOK_ACEITA_MARCA_DAGUA=1, para o dia em que sobrar ele ou nada.
 *
 * Ela existe porque a URL canônica (`tiktok.com/@user/video/<id>`) é RECUSADA
 * pelo Akamai mesmo no navegador: devolve a página "Site Maintenance" de 520
 * bytes, medido 17/08 em 5 tentativas, inclusive com sessão já aquecida na home.
 * Só o link curto (vt./vm.) entrega a página real. Como o usuário cola o que
 * quiser, sem o embed metade dos links não teria caminho próprio.
 *
 * Em compensação o embed só traz uma resolução (576x1024 no caso medido), por
 * isso ele é o segundo a ser tentado, e não o primeiro.
 */
function candidatasDoEmbed (html) {
  const bloco = html.match(/id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/)
  if (!bloco) return null
  try {
    const dados = JSON.parse(bloco[1]).source.data
    const chave = Object.keys(dados).find((k) => k.includes('/embed/'))
    const videoData = chave && dados[chave] && dados[chave].videoData
    if (!videoData) return null
    if (videoData.imagePostInfo) return { photo: true, urls: [] }
    const urls = ((videoData.itemInfos && videoData.itemInfos.video) || {}).urls || []
    const limpas = urls.filter((u) => typeof u === 'string' && u)
    return limpas.length ? { photo: false, urls: limpas } : null
  } catch (e) {
    return null
  }
}

/** ID numérico do vídeo, venha ele da URL colada ou da URL que o encurtador abriu. */
function idDoVideoTikTok (...urls) {
  for (const u of urls) {
    const m = String(u || '').match(/\/video\/(\d{8,})/)
    if (m) return m[1]
  }
  return null
}

/**
 * Abre o encurtador (vt./vm.) só até o redirect, para descobrir o ID do vídeo.
 *
 * Vale a requisição extra porque é ela que garante o caminho do embed quando a
 * página do vídeo vem sem os dados: sem o ID não há embed, e o link curto (o que
 * o botão Compartilhar do TikTok entrega, ou seja, o caso comum) ficaria sem
 * rede de segurança. O redirect responde 301 na hora, sem passar pelo bloqueio
 * que derruba a página canônica.
 */
async function idPeloEncurtador (url) {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': YTDLP_UA },
      signal: AbortSignal.timeout(20000),
    })
    return idDoVideoTikTok(r.headers.get('location'))
  } catch (e) {
    return null
  }
}

/**
 * Baixa o mp4 do TikTok abrindo a página no FlareSolverr e lendo o endereço do
 * arquivo no JSON que o próprio site embute.
 * Devolve null quando deu certo, ou um código de erro para o chamador registrar.
 */
async function baixarTikTokViaFlareSolverr (url, destino) {
  let cabecalhos = null
  let candidatas = null
  let idVideo = idDoVideoTikTok(url)

  // A URL canônica já traz o ID, e ela é RECUSADA pelo Akamai mesmo dentro do
  // navegador: volta a "Site Maintenance" de ~520 bytes, sempre (medido 17/08
  // em 5 tentativas e de novo em 24/08, 520 e 521 bytes). Quando o link colado
  // já é canônico, tentar a página duas vezes é gastar ~3s para ouvir o mesmo
  // não duas vezes, então o embed vira o primeiro caminho em vez do último.
  // Links curtos (vt./vm.) seguem tentando a página: neles ela funciona, é lá
  // que mora o 1080p, e a casca vazia é intermitente.
  // Se o bloqueio cair um dia, FS_TENTA_PAGINA_CANONICA=1 devolve a tentativa.
  const tentaPagina = !idVideo || process.env.FS_TENTA_PAGINA_CANONICA === '1'
  // O ID pelo encurtador só era buscado DEPOIS das tentativas de página, em
  // série. Como ele é uma requisição de redirect (rápida) e é o que destrava o
  // embed, ele sai na frente e espera junto.
  const idEmParalelo = idVideo ? null : idPeloEncurtador(url)

  const cabecalhosDe = (solucao) => {
    // O CDN do TikTok recusa quem não parece navegador: precisa do MESMO
    // User-Agent que abriu a página, do Referer do tiktok.com e dos cookies da
    // sessão. Faltando qualquer um deles vem 403.
    const h = { 'User-Agent': solucao.userAgent || YTDLP_UA, Referer: 'https://www.tiktok.com/' }
    const cookies = (solucao.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ')
    if (cookies) h.Cookie = cookies
    return h
  }

  // A página vem hidratada uma hora e como casca vazia na outra: medido 17/08,
  // o MESMO link alternou entre 619 KB (com dados) e 46-70 KB (sem), e a segunda
  // rodada de tentativas passou 3/3. É a mesma intermitência de sempre do
  // TikTok, então repetir vale mais que desistir.
  for (let tentativa = 1; tentaPagina && tentativa <= 2 && !candidatas; tentativa++) {
    const solucao = await abrePaginaNoFlareSolverr(url)
    if (!solucao) { console.warn('[flaresolverr] pagina nao abriu (tentativa ' + tentativa + ')'); continue }
    idVideo = idVideo || idDoVideoTikTok(solucao.url)
    const achado = candidatasDaPagina(solucao.response || '')
    if (achado && achado.photo) return 'fs_photo_mode'
    if (achado) {
      candidatas = achado.urls
      cabecalhos = cabecalhosDe(solucao)
    } else {
      console.warn('[flaresolverr] pagina veio sem os dados do video (tentativa ' + tentativa + ', ' + String(solucao.response || '').length + ' bytes)')
    }
  }

  if (!candidatas && !idVideo && idEmParalelo) idVideo = await idEmParalelo

  // A queda para o embed leva junto a marca d'água (ver `candidatasDoEmbed`),
  // então ela também ficou atrás da chave.
  if (!candidatas && idVideo && ACEITA_MARCA_DAGUA) {
    console.warn('[flaresolverr] caindo para o embed do video ' + idVideo)
    const solucao = await abrePaginaNoFlareSolverr(`https://www.tiktok.com/embed/v2/${idVideo}`)
    if (solucao) {
      const achado = candidatasDoEmbed(solucao.response || '')
      if (achado && achado.photo) return 'fs_photo_mode'
      if (achado) {
        candidatas = achado.urls
        cabecalhos = cabecalhosDe(solucao)
      }
    }
  }

  if (!candidatas || !candidatas.length) return 'fs_sem_dados'

  return baixaPrimeiraCandidataBoa(candidatas, cabecalhos, destino, 'flaresolverr')
}

/**
 * Percorre as candidatas até uma virar arquivo bom no disco. Devolve null no
 * sucesso, ou um código de erro.
 *
 * Vive fora dos dois extratores porque os dois entregam a MESMA coisa (uma
 * lista de endereços do CDN e os cabeçalhos que ele aceita) e precisam das
 * mesmas recusas: página de erro disfarçada de 200, faixa muda, arquivo grande
 * demais. Duas cópias disso divergiriam na primeira manutenção.
 *
 * `marca` só rotula o log: saber por qual caminho o arquivo veio é metade do
 * diagnóstico quando o TikTok muda de novo.
 */
async function baixaPrimeiraCandidataBoa (candidatas, cabecalhos, destino, marca) {
  // O motivo de cada recusa vai para o log: quando isso aqui falhar de novo (e
  // vai, o TikTok muda), a diferença entre "o CDN negou" e "veio sem áudio" é o
  // que separa cinco minutos de diagnóstico de uma tarde.
  let ultimoErro = 'fs_download_falhou'
  let n = 0
  for (const candidata of candidatas) {
    n++
    const onde = `candidata ${n}/${candidatas.length}`
    try {
      const r = await fetch(candidata, { headers: cabecalhos, signal: AbortSignal.timeout(FS_DOWNLOAD_TIMEOUT_MS) })
      if (!r.ok) { console.warn(`[${marca}] ${onde}: HTTP ${r.status}`); continue }
      const buf = Buffer.from(await r.arrayBuffer())
      // Página de erro do CDN também chega com 200: um mp4 de verdade não tem
      // 50 KB, e deixar passar viraria "arquivo quebrado" lá na frente.
      if (buf.length < 50000) { console.warn(`[${marca}] ${onde}: corpo de ${buf.length} bytes, nao e video`); continue }
      if (buf.length > SC_MAX_BYTES) return 'too_large'
      writeFileSync(destino, buf)
      // A faixa escolhida pode vir MUDA (aconteceu com os formatos "1080p" do
      // TikTok em 26/07, com o metadado mentindo que tinha aac). Como aqui a
      // escolha é nossa, e não do yt-dlp, conferimos antes de aceitar: sem
      // áudio, tenta a próxima candidata em vez de entregar vídeo sem som.
      const { video: cv, audio: ca } = await codecsDoArquivo(destino)
      if (cv && ca) {
        console.warn(`[${marca}] ${onde}: ok, ${buf.length} bytes (${cv}+${ca})`)
        return null
      }
      console.warn(`[${marca}] ${onde}: recusada por codec (video=${cv || '-'}, audio=${ca || '-'})`)
      ultimoErro = ca && !cv ? 'fs_photo_mode' : 'fs_sem_audio'
      try { unlinkSync(destino) } catch { /* já removido */ }
    } catch (e) {
      // Próxima candidata: a lista traz o mesmo arquivo em CDNs diferentes.
      console.warn(`[${marca}] ${onde}: ${String((e && e.message) || e).slice(0, 120)}`)
    }
  }
  return ultimoErro
}

// ── Caminho principal do TikTok: a própria página, sem navegador (31/08/2026)
// O embed era o caminho mais curto, mas só serve o arquivo marcado (ver
// `candidatasDoEmbed`). A página do vídeo serve o stream de reprodução, o
// limpo, e o achado de hoje é que ela também responde a um GET COMUM: com o
// `YTDLP_UA` e os parâmetros de compartilhamento (`is_from_webapp=1&
// sender_device=pc`) ela volta hidratada, com o bloco
// __UNIVERSAL_DATA_FOR_REHYDRATION__ inteiro, em ~0,6s e sem cookie nenhum.
//
// O que muda em relação a 17/08, quando "a página canônica é sempre recusada":
// aquilo vale para o FlareSolverr, e continua valendo (reconferido hoje, 521
// bytes de "Site Maintenance"). O navegador de verdade é que é barrado; o GET
// simples passa. Não confundir os dois casos.
//
// Em compensação a página é uma ROLETA: o mesmo link volta ora hidratado
// (~420 KB), ora como casca vazia (~44 KB). Por isso a tentativa é repetida —
// cada rodada custa menos de um segundo, e medido em 6 vídeos distintos foram
// 5 resolvidos, 4 deles na primeira tentativa. O que a roleta derrubar cai no
// yt-dlp logo atrás, que lê a MESMA página com outra pilha de TLS.
//
// O handle não importa: `@i` funciona igual, então link com handle errado
// também passa a baixar.
const TK_PAGINA_TIMEOUT_MS = 20000
const TK_PAGINA_TENTATIVAS = Math.max(1, Number(process.env.TIKTOK_PAGINA_TENTATIVAS || 6))
const TK_PAGINA_ESPERA_MS = 400

// Duas respostas ruins diferentes, e confundir as duas custa caro:
//
// - CASCA VAZIA (~44 KB): a roleta normal do TikTok. Repetir resolve.
// - DESAFIO DO WAF (~1,5 KB, "Please wait...", `_wafchallengeid`): o IP levou
//   limite de taxa. Repetir aqui não resolve NADA e ainda afunda mais o
//   bloqueio, então a rodada para na primeira aparição e o caminho entra de
//   castigo, com os pedidos indo direto para o yt-dlp (que fala com o mesmo
//   endereço por outra pilha de TLS e continua passando). Apareceu de verdade
//   em 31/08, depois de uma rajada de testes contra o mesmo IP.
//
// O castigo é uma REDUÇÃO, não um bloqueio: durante ele ainda vai uma tentativa
// por pedido. O bloqueio total custava caro na volta — medido em 31/08, o WAF
// soltou o IP e o caminho bom seguiu de fora por mais quatro minutos, porque
// ninguém estava olhando. Uma sonda de meio segundo devolve o caminho no
// primeiro pedido depois que o TikTok libera, e no bloqueio de verdade custa
// uma requisição em vez de seis.
const TK_PAGINA_CASTIGO_MS = 5 * 60 * 1000
let paginaDeCastigoAte = 0

const ehDesafioDoWaf = (html) => html.length < 20000 && /_wafchallengeid|SlardarWAF/.test(html)

async function baixarTikTokViaPaginaDireta (url, destino) {
  const idVideo = idDoVideoTikTok(url) || await idPeloEncurtador(url)
  if (!idVideo) return 'pg_sem_id'
  const alvo = `https://www.tiktok.com/@i/video/${idVideo}?is_from_webapp=1&sender_device=pc`
  const limite = Date.now() < paginaDeCastigoAte ? 1 : TK_PAGINA_TENTATIVAS

  let achado = null
  for (let i = 1; i <= limite && !achado; i++) {
    let html = ''
    try {
      const r = await fetch(alvo, {
        headers: { 'User-Agent': YTDLP_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
        signal: AbortSignal.timeout(TK_PAGINA_TIMEOUT_MS),
      })
      if (r.ok) html = await r.text()
      else console.warn(`[pagina] tentativa ${i}: HTTP ${r.status}`)
    } catch (e) {
      console.warn(`[pagina] tentativa ${i}: ${String((e && e.message) || e).slice(0, 100)}`)
    }
    if (html) {
      if (ehDesafioDoWaf(html)) {
        paginaDeCastigoAte = Date.now() + TK_PAGINA_CASTIGO_MS
        console.warn(`[pagina] desafio do WAF na tentativa ${i}: caminho reduzido a uma sonda por ${TK_PAGINA_CASTIGO_MS / 60000} min`)
        return 'pg_waf'
      }
      const lido = candidatasDaPagina(html)
      if (lido && lido.photo) return 'fs_photo_mode'
      if (lido) achado = lido
      else console.warn(`[pagina] tentativa ${i}: casca sem os dados do video (${html.length} bytes)`)
    }
    if (!achado && i < limite) {
      await new Promise((pronto) => setTimeout(pronto, TK_PAGINA_ESPERA_MS))
    }
  }
  if (!achado || !achado.urls.length) return 'pg_sem_dados'

  // Sem cookie: a lista de candidatas traz o mesmo arquivo em vários espelhos
  // do CDN e os primeiros costumam responder 403 — `baixaPrimeiraCandidataBoa`
  // já percorre até um deles entregar (medido: 2 negados e o 3o baixou).
  return baixaPrimeiraCandidataBoa(
    achado.urls,
    { 'User-Agent': YTDLP_UA, Referer: 'https://www.tiktok.com/' },
    destino,
    'pagina',
  )
}

// ── Caminho mais curto do TikTok: o embed sem navegador (24/08/2026) ────────
// O que o FlareSolverr traz de volta na página de embed, um GET comum traz
// igual: medido hoje da própria VPS, `GET /embed/v2/<id>` com User-Agent de
// navegador responde 200 com os 317 KB de JSON em ~0,6s, sem cookie nenhum, e o
// CDN entrega o mp4 só com esse mesmo User-Agent e o Referer do tiktok.com.
//
// A diferença é o tempo: abrir um navegador de verdade custa 3 a 5s por vídeo, e
// como o FlareSolverr atende um pedido por vez, dois downloads simultâneos já
// fizeram um deles levar 19s (medido hoje, com tráfego real na máquina).
//
// A qualidade é a mesma: tanto o embed quanto a página do vídeo acabam
// entregando h264 576x1024 — as faixas 1080p do TikTok são h265 e vêm mudas,
// então já eram recusadas nos dois caminhos.
//
// O FlareSolverr fica logo atrás. Esta porta aqui é a que o Akamai fecha
// primeiro quando aperta (foi o que aconteceu com a página canônica em 15/08), e
// nesse dia o navegador de verdade volta a ser necessário sem ninguém precisar
// fazer deploy.
//
// DESLIGADO desde 31/08/2026: o que ele entrega é o arquivo com marca d'água.
// Continua no código porque é o único caminho que nunca falhou por bloqueio, e
// num dia de emergência TIKTOK_ACEITA_MARCA_DAGUA=1 religa a fila inteira sem
// deploy. Ligar isso é uma decisão de produto, não de infraestrutura.
const TK_EMBED_TIMEOUT_MS = 20000
const ACEITA_MARCA_DAGUA = process.env.TIKTOK_ACEITA_MARCA_DAGUA === '1'

async function baixarTikTokViaEmbedDireto (url, destino) {
  const idVideo = idDoVideoTikTok(url) || await idPeloEncurtador(url)
  if (!idVideo) return 'ed_sem_id'

  let html = ''
  try {
    const r = await fetch(`https://www.tiktok.com/embed/v2/${idVideo}`, {
      headers: { 'User-Agent': YTDLP_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(TK_EMBED_TIMEOUT_MS),
    })
    if (!r.ok) return 'ed_http_' + r.status
    html = await r.text()
  } catch (e) {
    return 'ed_' + String((e && e.name) || 'falhou').toLowerCase()
  }

  const achado = candidatasDoEmbed(html)
  if (achado && achado.photo) return 'fs_photo_mode'
  if (!achado || !achado.urls.length) return 'ed_sem_dados'

  return baixaPrimeiraCandidataBoa(
    achado.urls,
    { 'User-Agent': YTDLP_UA, Referer: 'https://www.tiktok.com/' },
    destino,
    'embed',
  )
}

// GET /api/tiktok/health — versão do yt-dlp instalada (diagnóstico).
app.get('/api/tiktok/health', requireAdminKey, (_req, res) => {
  execFile(YTDLP_BIN, ['--version'], { timeout: 10000 }, (err, stdout) => {
    if (err) return res.json({ success: false, ytdlp: null, bin: YTDLP_BIN, error: err.code === 'ENOENT' ? 'ytdlp_missing' : String(err.message).slice(0, 120) })
    res.json({ success: true, ytdlp: String(stdout).trim(), bin: YTDLP_BIN })
  })
})
// URLs aceitas: TikTok (inclui encurtadores vm./vt.) e Instagram (reel/p/tv/share).
const INSTAGRAM_URL_RE = /^https?:\/\/(www\.)?instagram\.com\/\S+$/i
function urlDeVideoValida (url) {
  return TIKTOK_URL_RE.test(url) || INSTAGRAM_URL_RE.test(url)
}

// Nome de arquivo amigável pro download (id do TikTok ou shortcode do Insta).
function nomeArquivoVideo (url) {
  const tk = url.match(/video\/(\d{8,})/)
  if (tk) return `tiktok-${tk[1]}.mp4`
  const ig = url.match(/instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,})/i)
  if (ig) return `instagram-${ig[1]}.mp4`
  return `video-${Date.now()}.mp4`
}

// ── Cache curto do arquivo pronto (24/08/2026) ──────────────────────────────
// O mesmo link volta com frequência: a pessoa baixa, confere, baixa de novo; o
// lote traz links repetidos; e o chat importa justamente o vídeo que ela acabou
// de baixar na tela. Nos logs de 24/08 o mesmo id apareceu 4 vezes no dia, cada
// uma pagando os ~20s inteiros.
//
// O que é guardado é o arquivo JÁ PRONTO para entrega (formato escolhido,
// ffprobe feito, transcode aplicado se precisou), então a segunda vez custa uma
// cópia local em vez de duas idas ao TikTok. Meia hora é curto de propósito: é
// tempo de sessão de trabalho, não de arquivo velho servido para outra pessoa.
const DL_CACHE_TTL_MS = 30 * 60 * 1000
const DL_CACHE_MAX = 20
// Vídeo grande é raro e é justamente o que encheria o disco: 20 arquivos de
// 250 MB seriam 5 GB parados no /tmp para servir uma repetição que talvez não
// venha. Acima disso, o segundo pedido baixa de novo.
const DL_CACHE_MAX_BYTES = 60 * 1024 * 1024
const dlCache = new Map() // chave -> { caminho, quando }

function chaveDeCache (url) {
  const id = idDoVideoTikTok(url)
  if (id) return 'tk_' + id
  const ig = String(url).match(/instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]{5,})/i)
  if (ig) return 'ig_' + ig[1]
  // Link curto (vt./vm.) não traz o id: a própria URL, sem query, serve.
  return 'u_' + createHash('sha1').update(String(url).split('?')[0]).digest('hex').slice(0, 16)
}

function doCacheDeDownload (chave) {
  const item = dlCache.get(chave)
  if (!item) return null
  // O /tmp é do sistema: se a limpeza dele levou o arquivo, o registro mente.
  if (Date.now() - item.quando > DL_CACHE_TTL_MS || !existsSync(item.caminho)) {
    dlCache.delete(chave)
    try { unlinkSync(item.caminho) } catch { /* já não existe */ }
    return null
  }
  return item.caminho
}

function guardaNoCacheDeDownload (chave, origem) {
  try {
    if (statSync(origem).size > DL_CACHE_MAX_BYTES) return
  } catch { return /* sumiu entre a entrega e aqui */ }
  const destino = `/tmp/dlcache_${chave}.mp4`
  // Grava fora do lugar e só depois renomeia: dois downloads do MESMO vídeo em
  // paralelo escreveriam no mesmo caminho, e um terceiro pedido no meio disso
  // levaria arquivo pela metade. O rename é atômico, a cópia direta não é.
  const parcial = `${destino}.${Math.floor(Math.random() * 1e6)}.tmp`
  // Cópia assíncrona e sem espera: o usuário já está recebendo o arquivo, e uma
  // falha aqui só custa o próximo download ser normal.
  copyFile(origem, parcial, (err) => {
    if (err) { try { unlinkSync(parcial) } catch { /* nem chegou a existir */ } return }
    try { renameSync(parcial, destino) } catch { try { unlinkSync(parcial) } catch { /* já foi */ } return }
    dlCache.set(chave, { caminho: destino, quando: Date.now() })
    const agora = Date.now()
    for (const [k, v] of [...dlCache]) {
      if (agora - v.quando > DL_CACHE_TTL_MS) {
        dlCache.delete(k)
        try { unlinkSync(v.caminho) } catch { /* já não existe */ }
      }
    }
    while (dlCache.size > DL_CACHE_MAX) {
      const [k, v] = [...dlCache].sort((a, b) => a[1].quando - b[1].quando)[0]
      dlCache.delete(k)
      try { unlinkSync(v.caminho) } catch { /* já não existe */ }
    }
  })
}

// Núcleo compartilhado: baixa com yt-dlp (retry via proxy residencial BR) e
// STREAMA o arquivo na resposta. `onFim` roda ao terminar (sucesso ou falha)
// — usado pelo rate limit de concorrência da rota pública.
function baixarVideoTo (res, url, { attachment = false, onFim = () => {} } = {}) {
  // Marco zero da requisição: é dele que sai o orçamento de tempo usado na
  // decisão de recodificar ou não (ver transcodaParaH264).
  const t0 = Date.now()
  const out = `/tmp/dlfetch_${Date.now()}_${Math.floor(Math.random() * 1e6)}.mp4`
  const cleanup = () => { try { unlinkSync(out) } catch { /* já removido */ } }
  const chaveCache = chaveDeCache(url)
  let veioDoCache = false

  // `onFim` é quem devolve a vaga de "um download por vez" desse visitante, e
  // ele PRECISA rodar em todo caminho de saída — inclusive quando o cliente
  // desiste no meio. Sem essa garantia o visitante ficava preso no
  // "Já tem um download seu em andamento. Espere ele terminar." até o processo
  // reiniciar: o front desiste em 150s, a resposta morria pendurada e a vaga
  // nunca voltava. O guard evita liberar duas vezes (abort + fim normal).
  let finalizado = false
  const finaliza = () => {
    if (finalizado) return
    finalizado = true
    try { onFim() } catch { /* callback do chamador não derruba o download */ }
  }
  const fim = (fn) => { finaliza(); return fn() }

  // Cliente foi embora (aba fechada, front abortou por timeout, rede caiu):
  // devolve a vaga na hora, sem esperar o yt-dlp/ffmpeg terminarem. Vale para
  // a fase de download E para a de envio; `enviaArquivo` derruba o stream.
  //
  // `clienteFoi` também interrompe a cadeia de tentativas: sem ela, o processo
  // seguia baixando pra ninguém e escrevia o .mp4 DEPOIS da limpeza, deixando
  // órfão no /tmp (medido: ainda sobrava um por download abortado).
  let clienteFoi = false
  let filho = null
  res.on('close', () => {
    if (res.writableEnded) return // resposta completa, o fluxo normal cuida
    clienteFoi = true
    console.warn('[video-download] cliente desistiu, liberando a vaga')
    if (filho) { try { filho.kill('SIGKILL') } catch { /* já morreu */ } }
    cleanup()
    finaliza()
  })
  // Desistência no meio do yt-dlp deixa o arquivo aparecer depois do kill;
  // uma última varrida fecha a janela entre o kill e a escrita do disco.
  const desistiu = () => {
    if (!clienteFoi) return false
    setTimeout(cleanup, 2000)
    return true
  }

  const classify = (err, stderr) => {
    const s = String(stderr || (err && err.message) || '')
    if (err && err.code === 'ENOENT') return 'ytdlp_missing'
    if ((err && err.killed) || /timed? ?out/i.test(s)) return 'timeout'
    if (/private|login required|rate.?limit reached|requested content is not available/i.test(s)) return 'private'
    if (/not available in your|geo.?restrict/i.test(s)) return 'region_blocked'
    if (/unavailable|does not exist|404|no longer|unable to find/i.test(s)) return 'not_found'
    if (/max-filesize|file is larger/i.test(s)) return 'too_large'
    return 'download_failed'
  }

  const ehInstagram = INSTAGRAM_URL_RE.test(url)

  const roda = (proxy, cb) => {
    const args = [
      url,
      '-o', out,
      '--no-playlist',
      // H264 PRIMEIRO: os formatos bytevc1/hevc "1080p" do TikTok vêm SEM
      // trilha de áudio na prática (o metadado mente dizendo aac — verificado
      // com ffprobe em 26/07, caso real "baixou sem áudio"). Os h264 são os
      // streams de reprodução reais, com áudio e compatíveis com qualquer
      // player/editor. Depois: qualquer muxed com áudio > merge vídeo+áudio
      // via ffmpeg (existe na VPS) > o que der.
      //
      // INSTAGRAM tem outra armadilha: as faixas DASH de maior resolução vêm em
      // VP9 (vp09.*) e nenhum filtro de codec acima bate nelas, então o antigo
      // `bv*+ba` mergiava VP9 dentro de .mp4 — o arquivo abre, toca o áudio e
      // NÃO mostra imagem no Windows/QuickTime/editores (medido 04/08/2026 no
      // reel DLIX4hkRjh9: saiu vp9 1080p). Os formatos progressivos do IG
      // ("1", "2", "3", com codec não anunciado) são H.264+AAC muxados, então
      // pra Instagram eles vêm primeiro; VP9/AV1 só como último recurso, e aí
      // o transcode em `responde` conserta.
      //
      // O `[format_id!=download]` de toda a cadeia do TikTok é a trava contra a
      // marca d'água: o extractor expõe um formato chamado `download`, que o
      // próprio yt-dlp rotula "watermarked" na lista, e ele é h264/mp4 como os
      // bons — ou seja, casaria com o primeiro filtro num dia em que os outros
      // sumissem, e o vídeo sairia marcado sem ninguém notar.
      '-f', ehInstagram
        ? 'b[ext=mp4]/b/bv*[vcodec^=avc1]+ba/bv*+ba'
        : 'b[vcodec^=h264][ext=mp4][format_id!=download]/b[acodec!=none][ext=mp4][format_id!=download]/b[acodec!=none][format_id!=download]/bv*[format_id!=download]+ba/b[format_id!=download]',
      '--merge-output-format', 'mp4',
      '--max-filesize', '250M',
      '--no-progress',
      '--socket-timeout', '20',
      '--force-overwrites',
    ]
    if (proxy) args.push('--proxy', proxy)
    // Impersonation em TODA tentativa (curl_cffi vem embutido no binario
    // standalone bin/yt-dlp). Sem isso o TikTok responde com challenge cookie e
    // o extractor morre em 'Unable to extract universal data for rehydration' —
    // medido em 30/07/2026, mesmo video baixa normal com o handshake de Chrome.
    // Alvo e User-Agent vêm fixados de YTDLP_IMPERSONATE/YTDLP_UA: ver o
    // comentário lá em cima, o alvo "chrome" solto passou a ser bloqueado.
    args.push('--impersonate', YTDLP_IMPERSONATE, '--user-agent', YTDLP_UA)
    // Guarda o processo pra poder matá-lo se o cliente desistir: sem isso a VPS
    // (compartilhada com o worker de render) segue baixando pra ninguém.
    filho = execFile(YTDLP_BIN, args, { timeout: 90000 }, cb)
  }

  const responde = () => {
    if (desistiu()) return
    if (!existsSync(out)) {
      // --max-filesize estourado faz o yt-dlp pular o download sem erro e sem arquivo
      return fim(() => res.status(422).json({ success: false, code: 'too_large', message: 'Vídeo acima do limite de 250MB.' }))
    }
    // Post de FOTOS do TikTok (photo mode): nao existe faixa de video, so a
    // trilha sonora, e o yt-dlp entrega um mp3 com nome de .mp4. Entregar isso
    // ao usuario e o mesmo que entregar arquivo quebrado, entao recusamos com
    // motivo proprio em vez de deixar ele descobrir no player.
    // A mesma chamada traz o tamanho do quadro e a duração, que são o que
    // permite ESTIMAR o custo da recodificação antes de começar (ver
    // transcodaParaH264): um ffprobe a mais só pra isso seria desperdício.
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name,width,height', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { timeout: 15000 }, (errProbe, soProbe) => {
      const linhas = String(soProbe || '').trim().split('\n').map((l) => l.trim()).filter(Boolean)
      // A linha do stream vem como "codec,largura,altura"; a do format, só a duração.
      const linhaStream = linhas.find((l) => l.includes(',')) || ''
      const [codecCru, wCru, hCru] = linhaStream.split(',')
      const codec = String(codecCru || '').toLowerCase()
      const larg = Number(wCru) || 0
      const alt = Number(hCru) || 0
      const dur = Number(linhas[linhas.length - 1]) || 0
      if (!errProbe && !codec) {
        cleanup()
        console.warn('[video-download] arquivo sem faixa de video (photo mode)')
        return fim(() => res.status(422).json({ success: false, code: 'photo_mode', message: 'Esse link é um carrossel de fotos, não tem vídeo para baixar.' }))
      }
      // Rede de segurança: se mesmo assim veio um codec que os players comuns
      // não decodificam, recodifica antes de entregar.
      if (codec && !CODECS_TOCAVEIS.has(codec)) return transcodaParaH264(codec, { dur, larg, alt })
      enviaArquivo()
    })
  }

  // H.264 é o único que abre em tudo (Windows, iOS, Android, CapCut, Premiere).
  // VP9/AV1 dentro de .mp4 é exatamente o caso "abriu, ouço o áudio e a imagem
  // não aparece"; HEVC no Windows depende de codec pago instalado.
  const CODECS_TOCAVEIS = new Set(['h264'])

  const transcodaParaH264 = (codec, { dur = 0, larg = 0, alt = 0 } = {}) => {
    // Quanto ainda dá pra gastar antes do front desistir. Sem esse cálculo o
    // ffmpeg tinha 90s fixos e o pior caso era o mais burro possível: o usuário
    // esperava os 90s inteiros, o encode estourava no meio e ele recebia o
    // ORIGINAL do mesmo jeito. Aconteceu duas vezes em 12/08/2026 com um vídeo
    // de 92 MB. Se não cabe, entregamos o original na hora.
    const restante = DL_ORCAMENTO_MS - (Date.now() - t0) - DL_MARGEM_ENVIO_MS

    // Custo estimado do encode, medido nesta VPS (4 cores) em 12/08/2026:
    // 180s de 1080x1920 saem em 80s com veryfast/3 threads, ou seja ~0,45s de
    // processamento por segundo de vídeo em Full HD. O custo acompanha a
    // quantidade de pixels, então resoluções menores escalam pra baixo.
    const pixels = larg * alt
    const fator = pixels > 0 ? pixels / (1080 * 1920) : 1
    const custoMs = dur > 0 ? dur * 450 * fator : 0

    if (custoMs > 0 && custoMs > restante) {
      console.warn(
        '[video-download] recodificação de ' + codec + ' pulada: precisaria de ~' +
        Math.round(custoMs / 1000) + 's e só restam ' + Math.round(restante / 1000) +
        's; entregando o original',
      )
      return enviaArquivo()
    }

    const conv = out.replace(/\.mp4$/, '_h264.mp4')
    console.warn('[video-download] recodificando ' + codec + ' -> h264 (~' + Math.round(custoMs / 1000) + 's estimados)')
    // Também vai pra `filho`: se o cliente desistir no meio do encode, o
    // res.on('close') mata o ffmpeg em vez de deixar 3 núcleos ocupados numa
    // VPS compartilhada pra produzir um arquivo que ninguém vai buscar.
    filho = execFile('ffmpeg', [
      '-y', '-i', out,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      // 3 de 4 núcleos: com 2 o mesmo encode levava 96s, com 3 cai pra 80s, e o
      // núcleo que sobra mantém o scraper e o worker de render respirando.
      // Presets mais rápidos foram medidos e descartados: ultrafast corta o
      // tempo pela metade mas entrega 152 MB no lugar de 60 MB, o que só empurra
      // a espera do usuário do servidor para a rede dele.
      '-threads', '3',
      conv,
      // O teto agora é o que sobrou do orçamento, não um número fixo.
    ], { timeout: Math.max(15000, restante) }, (errConv) => {
      // Encode morto pelo abandono do cliente: leva junto o arquivo parcial.
      if (clienteFoi) { try { unlinkSync(conv) } catch { /* nem existiu */ } return void desistiu() }
      if (errConv || !existsSync(conv)) {
        console.warn('[video-download] recodificacao falhou, entregando original', String((errConv && errConv.message) || '').slice(0, 200))
        try { unlinkSync(conv) } catch { /* nem chegou a existir */ }
        return enviaArquivo()
      }
      try { renameSync(conv, out) } catch { /* fica com o original */ }
      enviaArquivo()
    })
  }

  const enviaArquivo = () => {
    // Guarda para o próximo pedido do mesmo link (não regrava o que veio dele).
    if (!veioDoCache) guardaNoCacheDeDownload(chaveCache, out)
    let size
    try {
      size = statSync(out).size
    } catch (e) {
      // O arquivo sumiu entre a checagem e o envio (limpeza do /tmp, disco).
      // Sem o try isso viraria exceção solta e a vaga do visitante ficaria
      // presa, que é justamente o que não pode acontecer.
      return encerra('download_failed', String((e && e.message) || 'arquivo sumiu'))
    }
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Length', String(size))
    if (attachment) {
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivoVideo(url)}"`)
    }
    const stream = createReadStream(out)
    // `pipe` NÃO derruba a origem quando o destino morre: se o cliente some no
    // meio do envio, o read stream fica pendurado, o 'close' dele nunca chega e
    // o arquivo fica órfão no /tmp (havia um de 29/07 lá). Por isso o
    // res.on('close') lá em cima destrói este stream explicitamente.
    res.on('close', () => { stream.destroy() })
    stream.pipe(res)
    stream.on('close', () => { cleanup(); finaliza() })
    stream.on('error', () => { cleanup(); finaliza(); try { res.destroy() } catch { /* já fechado */ } })
  }

  // Cadeia de tentativas: DIRETO -> DIRETO -> PROXY.
  //
  // Medido em 30/07/2026 (3 chamadas identicas ao mesmo video): 2 passaram e 1
  // morreu em "Unable to extract universal data for rehydration". O challenge do
  // TikTok e intermitente, entao repetir a MESMA requisicao direta e o retry com
  // melhor retorno. O proxy residencial ficou por ultimo porque estava
  // respondendo "CONNECT tunnel failed, response 504": com ele em 2o lugar,
  // qualquer tropeco na 1a tentativa virava erro final pro usuario.
  const encerra = (code, stderr) => {
    cleanup()
    return fim(() => res.status(422).json({ success: false, code, message: String(stderr || '').slice(0, 300) }))
  }
  // Erros que nao adianta repetir: o video nao existe, e grande demais ou o
  // binario sumiu. Repetir so faria o usuario esperar 3x pelo mesmo nao.
  const definitivo = (code) => code === 'ytdlp_missing' || code === 'not_found' || code === 'too_large'

  /**
   * Rede paga, só para TikTok e só depois de tudo mais falhar: cada chamada
   * consome crédito (em 17/08 o crédito acabou e derrubou o baixador inteiro).
   *
   * O erro que o usuário vê continua sendo o do yt-dlp em qualquer desfecho: é
   * o que descreve a causa raiz, e trocar por "fs_..."/"sc_..." só esconderia
   * o motivo real. Os códigos dos fallbacks ficam no log.
   */
  const tentaPago = (code, stderr) => {
    if (ehInstagram || !SCRAPECREATORS_KEY) return encerra(code, stderr)
    console.warn('[video-download] tentando ScrapeCreators')
    baixarTikTokViaScrapeCreators(url, out)
      .then((erroSc) => {
        if (desistiu()) return
        if (!erroSc) {
          console.warn('[video-download] ScrapeCreators resolveu o que o yt-dlp nao conseguiu')
          return responde()
        }
        console.warn('[video-download] ScrapeCreators tambem falhou:', erroSc)
        return encerra(code, stderr)
      })
      .catch((e) => {
        if (desistiu()) return
        console.warn('[video-download] ScrapeCreators estourou:', String((e && e.message) || e).slice(0, 200))
        return encerra(code, stderr)
      })
  }

  // As três tentativas do yt-dlp. `aoEsgotar(code, stderr)` decide o que vem
  // depois — mudou de dono em 24/08: antes era sempre o fim da linha, agora
  // para TikTok ela é que virou o plano B.
  const cadeiaYtdlp = (aoEsgotar) => {
    roda(null, (err, _stdout, stderr) => {
      if (desistiu()) return
      if (!err) return responde()
      const code1 = classify(err, stderr)
      if (definitivo(code1)) return encerra(code1, stderr)
      console.warn('[video-download] 1a tentativa falhou (' + code1 + '), repetindo direto', String(stderr || '').slice(0, 300))

      roda(null, (err2, _stdout2, stderr2) => {
        if (desistiu()) return
        if (!err2) return responde()
        const code2 = classify(err2, stderr2)
        if (definitivo(code2)) return encerra(code2, stderr2)

        const proxy = getNextProxy('br')
        if (!proxy) {
          console.warn('[video-download] 2 tentativas diretas falharam e nao ha proxy', code2)
          return aoEsgotar(code2, stderr2)
        }
        console.warn('[video-download] 2a tentativa falhou (' + code2 + '), ultima via proxy residencial')

        roda(proxy, (err3, _stdout3, stderr3) => {
          if (desistiu()) return
          if (!err3) return responde()
          const code3 = classify(err3, stderr3)
          console.warn('[video-download] falha nas 3 tentativas', code3, String(stderr3 || '').slice(0, 300))
          return aoEsgotar(code3, stderr3)
        })
      })
    })
  }

  /**
   * TikTok começa pelo caminho próprio, e não pelo yt-dlp.
   *
   * Por quê (medido em 24/08/2026, com os logs de produção do dia): o extractor
   * de TikTok do yt-dlp falhava em 100% dos links desde 15/08 — "Unexpected
   * response from webpage request" —, mas ele continuava sendo o primeiro da
   * fila. Resultado: TODO download começava com ~14s de três tentativas
   * condenadas (2 diretas de ~3s e uma via proxy residencial de ~10s) antes de
   * chegar em quem resolve. Numa chamada real de 20,3s, 14s eram esses.
   *
   * Em 31/08 o yt-dlp voltou a funcionar em parte dos links (medido: 2 de 6),
   * então ele deixou de ser peso morto e virou a segunda perna — logo atrás da
   * página, que é o mesmo dado por um caminho três vezes mais barato. O
   * Instagram, onde ele nunca quebrou, segue começando por ele.
   * TIKTOK_YTDLP_PRIMEIRO=1 restaura a ordem antiga sem deploy.
   */
  const comecaPeloCaminhoProprio = !ehInstagram && process.env.TIKTOK_YTDLP_PRIMEIRO !== '1'

  const caminhoProprio = (passos, aoFalhar) => {
    // Carrossel de fotos é resposta final, não falha de caminho: nem o yt-dlp
    // nem o pago têm vídeo para entregar, os dois devolveriam o mesmo mp3 com
    // nome de .mp4 — e o pago ainda gastaria crédito.
    const respondeFoto = () => {
      cleanup()
      return fim(() => res.status(422).json({ success: false, code: 'photo_mode', message: 'Esse link é um carrossel de fotos, não tem vídeo para baixar.' }))
    }

    const tenta = (nome, baixa, proximo) => {
      console.warn('[video-download] TikTok: tentando ' + nome)
      baixa(url, out)
        .then((erro) => {
          if (desistiu()) return
          if (!erro) {
            console.warn('[video-download] ' + nome + ' entregou')
            return responde()
          }
          if (erro === 'fs_photo_mode') return respondeFoto()
          console.warn('[video-download] ' + nome + ' nao resolveu (' + erro + ')')
          cleanup() // sobra de tentativa parcial não engana quem vem depois
          return proximo()
        })
        .catch((e) => {
          if (desistiu()) return
          console.warn('[video-download] ' + nome + ' estourou:', String((e && e.message) || e).slice(0, 120))
          cleanup()
          return proximo()
        })
    }

    // Roda os caminhos em ordem, caindo para `aoFalhar` quando acabam.
    const passo = (i) => () => {
      if (i >= passos.length) return aoFalhar()
      return tenta(passos[i][0], passos[i][1], passo(i + 1))
    }
    return passo(0)()
  }

  // A fila do TikTok, do mais barato para o mais caro, e TODA ela sem marca
  // d'água. Antes o primeiro era o embed, que é o rápido e é o marcado.
  //
  // 1. a página do vídeo por GET comum (~1s, roleta resolvida na repetição)
  // 2. o yt-dlp (~2s por tentativa; lê a mesma página com outra pilha de TLS,
  //    então acerta em parte do que a roleta negou)
  // 3. o FlareSolverr (3 a 5s e um pedido por vez; para link curto, onde a
  //    página abre no navegador de verdade)
  // 4. o ScrapeCreators, pago e hoje sem crédito
  const passosPagina = [['a pagina do video', baixarTikTokViaPaginaDireta]]
  const passosNavegador = [['o FlareSolverr', baixarTikTokViaFlareSolverr]]
  if (ACEITA_MARCA_DAGUA) passosNavegador.push(['o embed (COM marca dagua)', baixarTikTokViaEmbedDireto])

  const comeca = () => {
    if (ehInstagram) return cadeiaYtdlp(encerra)
    const depoisDoYtdlp = (code, stderr) => caminhoProprio(passosNavegador, () => tentaPago(code, stderr))
    if (comecaPeloCaminhoProprio) {
      return caminhoProprio(passosPagina, () => cadeiaYtdlp(depoisDoYtdlp))
    }
    // Ordem antiga (TIKTOK_YTDLP_PRIMEIRO=1): yt-dlp, caminhos próprios, pago.
    return cadeiaYtdlp((code, stderr) => caminhoProprio(passosPagina, () => depoisDoYtdlp(code, stderr)))
  }

  // Mesmo vídeo pedido de novo dentro da janela: entrega a cópia local e pula o
  // caminho inteiro. Se a cópia falhar, o download normal acontece como sempre.
  const jaBaixado = doCacheDeDownload(chaveCache)
  if (jaBaixado) {
    copyFile(jaBaixado, out, (errCopia) => {
      if (desistiu()) return
      if (errCopia) {
        console.warn('[video-download] copia do cache falhou, baixando de novo')
        return comeca()
      }
      veioDoCache = true
      console.warn('[video-download] entregue do cache local (' + chaveCache + ')')
      enviaArquivo()
    })
    return
  }

  comeca()
}

// Rota ADMIN (usada pela edge import-tiktok-video do chat). Aceita TikTok e
// Instagram — mesmo contrato de antes.
app.post('/api/tiktok/fetch', requireAdminKey, (req, res) => {
  const url = String((req.body && req.body.url) || '').trim()
  if (!urlDeVideoValida(url)) {
    return res.status(400).json({ success: false, code: 'invalid_url', message: 'URL inválida (aceito TikTok e Instagram).' })
  }
  baixarVideoTo(res, url)
})

// ---------------------------------------------------------------------------
// Download PÚBLICO (página /baixar do domma.ai)
// ---------------------------------------------------------------------------
// Sem admin key: qualquer visitante baixa 1 vídeo por vez, com teto diário por
// IP. Assinantes mandam o header `x-download-permit` (emitido pela edge
// download-permit, HMAC com a MESMA admin_key — validação offline aqui) e
// ganham teto alto pro modo lote.
const DL_ANON_POR_DIA = 5
const DL_ASSINANTE_POR_DIA = 200
// Teto de validade da vaga de "um download por vez". Acima da soma do pior
// caso real (3 tentativas de 90s + recodificação), então só dispara
// quando alguma saída esqueceu de devolver a vaga.
const DL_VAGA_MAX_MS = 6 * 60 * 1000
// Quanto o navegador do usuário espera antes de desistir (o front usa 150s).
// Gastar mais que isso não entrega nada a ninguém: a resposta chega numa
// conexão que já morreu.
const DL_ORCAMENTO_MS = 150 * 1000
// Reserva para empacotar e mandar o arquivo pela rede depois de pronto.
const DL_MARGEM_ENVIO_MS = 20 * 1000
const dlJanelas = new Map() // chave -> { dia: 'YYYY-MM-DD', count, ativo: bool }

function validaPermit (token) {
  if (!token) return null
  const adminKey = (loadConfig().admin_key || '').trim()
  if (!adminKey) return null
  const partes = String(token).split('.')
  if (partes.length !== 3) return null
  const [exp, userId, sig] = partes
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return null
  const want = createHmac('sha256', adminKey).update(exp + '.' + userId).digest('hex')
  if (want !== sig) return null
  return { userId }
}

function ipDoRequest (req) {
  return String(
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'desconhecido',
  )
}

app.post('/api/public/video-download', (req, res) => {
  const url = String((req.body && req.body.url) || '').trim()
  if (!urlDeVideoValida(url)) {
    return res.status(400).json({ success: false, code: 'invalid_url', message: 'Cole um link de vídeo do TikTok ou do Instagram.' })
  }

  const permit = validaPermit(req.headers['x-download-permit'])
  const chave = permit ? `u:${permit.userId}` : `ip:${ipDoRequest(req)}`
  const limite = permit ? DL_ASSINANTE_POR_DIA : DL_ANON_POR_DIA
  const hoje = new Date().toISOString().slice(0, 10)

  // Janela diária em memória (reinicia com o processo — suficiente pro abuso
  // casual; o pesado é barrado pelo teto + 1 download simultâneo por chave).
  if (dlJanelas.size > 20000) dlJanelas.clear() // trava de memória
  let jan = dlJanelas.get(chave)
  if (!jan || jan.dia !== hoje) { jan = { dia: hoje, count: 0, ativo: false, desde: 0 }; dlJanelas.set(chave, jan) }
  // A vaga tem prazo de validade. Um download real morre em bem menos que isso
  // (3 tentativas de 90s + recodificação), então passar de DL_VAGA_MAX_MS só
  // acontece se alguma saída nova esquecer de devolver a vaga. Sem esse teto,
  // um caso desses prendia o visitante no "espere o download terminar" até o
  // processo reiniciar — foi o que um cliente relatou em 12/08/2026.
  if (jan.ativo && Date.now() - (jan.desde || 0) > DL_VAGA_MAX_MS) {
    console.warn('[video-download] vaga presa há', Math.round((Date.now() - (jan.desde || 0)) / 1000) + 's, liberando', chave)
    jan.ativo = false
  }
  if (jan.ativo) {
    return res.status(429).json({ success: false, code: 'busy', message: 'Já existe um download em andamento. Aguarde ele terminar.' })
  }
  if (jan.count >= limite) {
    return res.status(429).json({
      success: false,
      code: 'rate_limited',
      message: permit
        ? 'Limite diário de downloads atingido.'
        : 'Limite diário gratuito atingido. Assine o Domma pra baixar em lote e sem esse teto.',
    })
  }
  jan.count++
  jan.ativo = true
  jan.desde = Date.now()
  baixarVideoTo(res, url, { attachment: true, onFim: () => { jan.ativo = false } })
})

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
const COOKIE_FILE = 'cookies.txt'
// Ultimo jar que provou estar AUTENTICADO. Serve de rede de seguranca: se algo
// gravar lixo por cima (ver o PUT /api/cookies), o keepalive volta pra ele.
const LAST_GOOD_FILE = 'cookies.txt.last-good'

function getCookies() {
  try {
    return readFileSync(COOKIE_FILE, 'utf-8').trim()
  } catch {
    return ''
  }
}

function setCookies(cookies) {
  writeFileSync(COOKIE_FILE, cookies.trim() + '\n', 'utf-8')
}

function getLastGoodCookies() {
  try {
    return readFileSync(LAST_GOOD_FILE, 'utf-8').trim()
  } catch {
    return ''
  }
}

function saveLastGoodCookies(cookies) {
  const value = String(cookies || '').trim()
  if (!value || value === getLastGoodCookies()) return
  try {
    writeFileSync(LAST_GOOD_FILE, value + '\n', 'utf-8')
  } catch (e) {
    console.warn('[cookies] nao consegui gravar o last-good:', e?.message)
  }
}

/**
 * Diz se uma string de cookies esta de fato LOGADA no Kalodata.
 *
 * `/api/sso/clip-token` so devolve success+token com sessao autenticada — e a
 * mesma sonda que o refresh-cookies.sh usa, o que mantem os dois criterios
 * iguais. Cookie anonimo (so tracking: _ga, _fbp, _ttp...) reprova aqui, e e
 * exatamente isso que precisamos distinguir: a extensao Cookie Sync manda
 * cookies mesmo com o Chrome deslogado, porque cookie de tracking sempre existe.
 *
 * Nunca lanca: qualquer falha (rede, Cloudflare, JSON torto) vira `false`.
 */
function isAuthenticatedCookie(cookies) {
  const value = String(cookies || '').trim()
  if (!value) return false
  try {
    const out = execFileSync('/usr/local/bin/curl_chrome116', [
      '-s', '--max-time', '20',
      '-A', UA,
      '-b', value,
      '-H', 'accept: application/json',
      '-H', 'country: BR',
      '-H', 'language: pt-BR',
      'https://www.kalodata.com/api/sso/clip-token',
    ], { encoding: 'utf-8', timeout: 25000 })
    const d = JSON.parse(out)
    return !!(d?.success && d?.data?.token)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Kalodata proxy helper
// ---------------------------------------------------------------------------
function kaloPost(path, body, country = DEFAULT_COUNTRY, proxyUrl = null) {
  const cookies = getCookies()
  if (!cookies) throw new Error('cookies.txt not found or empty')
  const hdrFile = newHeaderDumpPath()

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
    ...headerDumpArgs(hdrFile),
  ]

  let result
  try {
    result = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 35000 })
  } finally {
    // Absorve a renovacao de sessao mesmo quando a chamada falha.
    absorbHeaderDump(hdrFile)
  }
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
  const hdrFile = newHeaderDumpPath()

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
    ...headerDumpArgs(hdrFile),
  ]

  let result
  try {
    result = execFileSync('/usr/local/bin/curl_chrome116', args, { encoding: 'utf-8', timeout: 35000 })
  } finally {
    absorbHeaderDump(hdrFile)
  }
  if (result.trimStart().startsWith('<')) {
    throw new Error('Cloudflare challenge Ã¢ÂÂ atualize os cookies (precisa do cf_clearance)')
  }
  if (!result.trim()) return { success: false, data: null, message: 'upstream returned empty body' }
  return JSON.parse(result)
}

// ---------------------------------------------------------------------------
// kaloPostAsync / kaloGetAsync — variantes assíncronas (execFile + fila + proxy)
// Usadas pelos endpoints novos/corrigidos desta sessão. kaloPost/kaloGet SYNC
// ficam intocados (callers existentes não quebram). execFile não bloqueia o event
// loop; a fila (scraper-queue) limita concorrência, faz dedup e timeout;
// getNextProxy dá paridade geo com kaloPostPaginated. --max-time 20 alinha com o
// cold-start (~22s) e o timeout de 20s do consumidor (Domma edge).
// ---------------------------------------------------------------------------
const _CURL_BIN = '/usr/local/bin/curl_chrome116'
const _CURL_MAX_TIME = parseInt(process.env.CURL_MAX_TIME) || 20
const _execTimeout = () => (parseInt(process.env.REQUEST_TIMEOUT_MS) || 22000) - 1000

function _execCurl (args) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      _CURL_BIN, args,
      { encoding: 'utf-8', timeout: _execTimeout(), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 * 32 },
      (err, stdout) => err ? reject(err) : resolve(stdout),
    )
    if (child && typeof child.unref === 'function') child.unref()
  })
}

function _parseCurlResult (result) {
  if (result.trimStart().startsWith('<')) {
    throw new Error('Cloudflare challenge — atualize os cookies (precisa do cf_clearance)')
  }
  if (!result.trim()) return { success: false, data: null, message: 'upstream returned empty body' }
  return JSON.parse(result)
}

async function kaloPostAsync (path, body, country = DEFAULT_COUNTRY, proxyUrl = undefined) {
  const cookies = getCookies()
  if (!cookies) throw new Error('cookies.txt not found or empty')
  const hdrFile = newHeaderDumpPath()

  const proxy = (proxyUrl !== undefined) ? proxyUrl : getNextProxy(country)
  const ctx = headersForCountry(country)

  const args = [
    '-s', '--max-time', String(_CURL_MAX_TIME),
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
    ...proxyCurlArgs(proxy),
    ...headerDumpArgs(hdrFile),
  ]

  const key = `POST:${path}:${country}:${JSON.stringify(body)}`.substring(0, 256)
  let result
  try {
    result = await runScraperFn(key, () => _execCurl(args))
  } finally {
    absorbHeaderDump(hdrFile)
  }
  if (proxy) console.log('[proxy] kaloPostAsync', path, 'via', proxy.replace(/:[^:@]*@/, ':***@'))
  return _parseCurlResult(result)
}

async function kaloGetAsync (path, country = DEFAULT_COUNTRY) {
  const cookies = getCookies()
  if (!cookies) throw new Error('cookies.txt not found or empty')
  const hdrFile = newHeaderDumpPath()

  const proxy = getNextProxy(country)
  const ctx = headersForCountry(country)

  const args = [
    '-s', '--max-time', String(_CURL_MAX_TIME),
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
    ...proxyCurlArgs(proxy),
    ...headerDumpArgs(hdrFile),
  ]

  const key = `GET:${path}:${country}`
  let result
  try {
    result = await runScraperFn(key, () => _execCurl(args))
  } finally {
    absorbHeaderDump(hdrFile)
  }
  return _parseCurlResult(result)
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
  // 2026-08-01: a janela voltou pra D-1. Medido contra a UI logada no mesmo dia:
  // ela manda 02/07~31/07 pra "Ultimos 30 dias" e 25/07~31/07 pra "Ultimos 7 dias",
  // ou seja termina em ONTEM, nao em anteontem. O comentario acima descreve o que
  // valia em 14/05; a fonte mudou. Com D-2 o /creator/detail/video/queryList passou
  // a devolver um conjunto degradado (todos revenue "R$0,00") pra parte dos
  // criadores, e o /total ficava ~0,8% abaixo do que a fonte mostra
  // (saratikshop 30d: D-2 R$52,42 mil, D-1 R$52,85 mil, UI R$52,85 mil).
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - (days - 1))
  // NAO devolver `days` aqui. Os 21 handlers fazem `...range` direto no body do
  // upstream, e um campo `days` sobrando faz o /creator/detail/video/queryList
  // trocar a resposta por um conjunto degradado: os videos organicos, todos com
  // revenue "R$0,00". Medido em 01/08/2026, mesmo payload, unica diferenca:
  //   sem days -> 10 itens, topo R$14,14 mil   |   com days:30 -> 10 itens, todos R$0,00
  // Nenhum handler le range.days (conferido com grep), entao sai sem quebrar nada.
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
// Cron: keep-alive da sessao
// ---------------------------------------------------------------------------
// A sessao do Kalodata morre por INATIVIDADE. Como toda chamada agora absorve o
// Set-Cookie (lib/cookie-jar.js), basta tocar o upstream de tempos em tempos pra
// ela se renovar sozinha - sem depender do Chrome do dono com a extensao Cookie
// Sync aberta, que era o unico caminho ate aqui (PC desligado de madrugada =
// sessao caida de manha). `/user/features` e a mesma chamada barata que a
// extensao usa no "ping ativo".
const KEEPALIVE_CRON = process.env.KALO_KEEPALIVE_CRON || config.session_keepalive_cron || '*/10 * * * *'
cron.schedule(KEEPALIVE_CRON, () => {
  const current = getCookies()
  if (!current) return // sem sessao base nao ha o que renovar
  try {
    const ok = checkSession() // dispara /user/features -> Set-Cookie -> jar
    if (ok) {
      // Jar vivo: vira o ponto de restauracao. Nao custa nada quando nao mudou.
      saveLastGoodCookies(getCookies())
      return
    }

    // Sessao recusada. Se alguem gravou lixo por cima (a extensao Cookie Sync
    // ja fez isso), o ultimo jar autenticado ainda pode estar de pe — volta pra
    // ele. Se o proprio last-good tambem morreu, ai e login humano mesmo.
    const lastGood = getLastGoodCookies()
    if (lastGood && lastGood !== current && isAuthenticatedCookie(lastGood)) {
      setCookies(lastGood)
      console.warn('[KEEPALIVE] jar restaurado a partir de cookies.txt.last-good')
      return
    }
    console.warn('[KEEPALIVE] upstream recusou a sessao (precisa de novo login)')
  } catch (e) {
    console.warn('[KEEPALIVE] falhou:', e?.message)
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
// ---------------------------------------------------------------------------
// Árvore de categorias (GET /api/categories?country=BR)
// ---------------------------------------------------------------------------
// Fonte: POST /api/configurations com [{key:'global.category.tree'}] — é o
// `config/fetchCategoryConfig` do bundle do site, que popula o Cascader de
// categorias das listagens. Devolvemos o value cru (árvore completa L1>L2>L3).
// Cache por país: 7 dias em sucesso, 1h em falha.
const cateTreeCache = new Map() // country -> { body, status, expiresAt }

app.get('/api/categories', (req, res) => {
  const country = parseCountry(req)
  const hit = cateTreeCache.get(country)
  if (hit && Date.now() < hit.expiresAt) return res.status(hit.status).json(hit.body)
  try {
    const out = kaloPost('/api/configurations', [{ key: 'global.category.tree' }], country)
    const ok = out && out.success !== false && (out.data ?? out.list)
    const body = { success: !!ok, source_path: '/api/configurations', data: out?.data ?? out?.list ?? null }
    const status = ok ? 200 : 502
    cateTreeCache.set(country, { body, status, expiresAt: Date.now() + (ok ? 7 * 86400000 : 3600000) })
    return res.status(status).json(body)
  } catch (e) {
    const body = { success: false, message: e.message }
    cateTreeCache.set(country, { body, status: 500, expiresAt: Date.now() + 3600000 })
    return res.status(500).json(body)
  }
})

// Filtro de categoria nas listagens: `?cateIds=601450,824328` (CSV) ou o legado
// `?cateId=601450` (singular). IDs compostos de subnível ("601450-848776") são
// aceitos como vêm — o upstream usa esse formato pra L2/L3. Vazio = sem filtro.
function parseCateIds(req) {
  const raw = req.query.cateIds ?? req.query.cateId ?? ''
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+(-\d+){0,2}$/.test(s))
    .slice(0, 10)
}

app.get('/api/products', async (req, res) => {
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const cateIds = parseCateIds(req)
    const range = getDateRange(days)

    const data = await kaloPostWithRetry('/product/queryList', () => ({
      country,
      ...range,
      pageNo: page,
      pageSize,
      cateIds,
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, { targetCount: cateIds.length ? 1 : Math.min(pageSize - 5, 55) })

    // Coluna "Vídeos que vendem": os 3 vídeos de maior receita de cada produto,
    // numa chamada de lote (/product/enrich) em vez de uma por produto.
    if (data && Array.isArray(data.data) && data.data.length > 0) {
      await enrichProductVideos(data.data, country, range)
    }

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

/**
 * @swagger
 * /api/video/{id}/products:
 *   get:
 *     summary: Produtos vendidos por um video (com share de receita)
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30, enum: [7, 30] }
 *       - in: query
 *         name: country
 *         schema: { type: string, default: BR }
 *     responses:
 *       200:
 *         description: Lista de produtos (id, product_title, revenue, sale, percentage, min/max_price, categorias)
 *       500:
 *         description: Erro interno
 */
app.get('/api/video/:id/products', async (req, res) => {
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' })
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 30
    const range = getDateRange(days)
    const data = await kaloPostAsync('/video/detail/stat/queryProductList', {
      id, country, ...range, pageNo: 1, pageSize: parseInt(req.query.pageSize) || 10,
    }, country)
    res.json(data)
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/video/{id}/similar:
 *   get:
 *     summary: Outros videos que vendem o mesmo produto
 *     tags: [Videos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30, enum: [7, 30] }
 *       - in: query
 *         name: country
 *         schema: { type: string, default: BR }
 *     responses:
 *       200:
 *         description: '{ type: "product", revenue: [videos...] } — mesmo shape do upstream'
 *       500:
 *         description: Erro interno
 */
app.get('/api/video/:id/similar', async (req, res) => {
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, message: 'Invalid id' })
  try {
    const country = parseCountry(req)
    const days = parseInt(req.query.days) || 30
    const range = getDateRange(days)
    const data = await kaloPostAsync('/video/detail/similar/revenue', {
      id, country, ...range, pageNo: 1, pageSize: parseInt(req.query.pageSize) || 10,
    }, country)
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
    const cateIds = parseCateIds(req)
    const range = getDateRange(days)

    const data = await kaloPostWithRetry('/video/queryList', () => ({
      country,
      ...range,
      pageNo: page,
      pageSize,
      cateIds,
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, { targetCount: cateIds.length ? 1 : Math.min(pageSize - 5, 55) })

    // Coluna Produto: o upstream tem um endpoint de LOTE — POST /video/enrich
    // ({ids,country,startDate,endDate,cateIds}) devolve [{id, product_id}] pra
    // página inteira numa chamada só (~0,4s medidos com 20 ids). É o mesmo que a
    // própria listagem da Kalodata usa pra desenhar a coluna Produto. Substituiu
    // a tentativa antiga de N+1 via /video/detail/product/queryList (devolvia
    // vazio e por isso ficou desligada).
    if (data && Array.isArray(data.data) && data.data.length > 0) {
      await enrichVideoProducts(data.data, country, range)
    }

    res.json(data)
  } catch (e) {
    if (e.scraper_busy)    return res.status(503).json({ success: false, error: 'scraper_busy',    retriable: true })
    if (e.scraper_timeout) return res.status(503).json({ success: false, error: 'scraper_timeout', retriable: true })
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

    // Coluna "Produtos mais vendidos" da live: até 3 produtos por transmissão,
    // numa chamada de lote (/livestream/enrich). O corte acima já rodou, então
    // só enriquecemos o que de fato vai na resposta.
    const rows = (data && (Array.isArray(data.data) ? data.data : Array.isArray(data.list) ? data.list : null)) || null
    if (rows && rows.length > 0) await enrichLiveProducts(rows, country, range)

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
app.get('/api/creator/:id/lives', async (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = await kaloPostAsync('/creator/detail/live/queryList', {
      id,
      country,
      ...range,
      pageNo: page,
      pageSize,
      sort: [{ field: sortField, type: 'DESC' }],
    }, country)
    res.json(data)
  } catch (e) {
    if (e.scraper_busy)    return res.status(503).json({ success: false, error: 'scraper_busy',    retriable: true })
    if (e.scraper_timeout) return res.status(503).json({ success: false, error: 'scraper_timeout', retriable: true })
    res.status(500).json({ success: false, message: e.message })
  }
})

/**
 * @swagger
 * /api/creator/{id}/videos:
 *   get:
 *     summary: Videos de vendas de um criador (valores fieis Kalodata)
 *     tags: [Creators]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: country
 *         schema: { type: string, default: BR }
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, enum: [7, 30] }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: sortField
 *         schema: { type: string, default: revenue }
 *     responses:
 *       200: { description: Videos do criador com sale/revenue fieis }
 *       503: { description: Scraper ocupado ou timeout }
 */
app.get('/api/creator/:id/videos', async (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    // pageSize AQUI e sempre 10, nao o que o cliente pediu. Medido em 01/08/2026
    // contra dois criadores: com qualquer outro valor (5, 11, 12, 15, 20, 30, 50) o
    // upstream troca a resposta por um conjunto degradado, com os videos organicos e
    // revenue "R$0,00" em todos. Com 10 ele devolve os 10 primeiros por receita, com
    // sale/revenue/views fieis. Paginar tambem nao rende: pageNo 2 volta vazio ou com
    // o mesmo lixo, entao 10 e o teto real do endpoint. Mesmo padrao do page_size=10
    // que ja conheciamos da EchoTik nas sublistas.
    const UPSTREAM_PAGE_SIZE = 10
    const data = await kaloPostAsync('/creator/detail/video/queryList', {
      id,
      ...range,
      authority: true,
      pageNo: page,
      pageSize: UPSTREAM_PAGE_SIZE,
      sort: [{ field: sortField, type: 'DESC' }],
    }, country)

    const items = Array.isArray(data?.data) ? data.data
                : Array.isArray(data?.list) ? data.list
                : Array.isArray(data?.items) ? data.items : []

    // `total` vinha como items.length, o que fazia o consumidor achar que o criador
    // so tem 10 videos. O count real e outro endpoint (saratikshop: 1139).
    let total = items.length
    try {
      const c = await kaloPostAsync('/creator/detail/video/count', {
        id, ...range, authority: true, pageNo: 1, pageSize: UPSTREAM_PAGE_SIZE,
        sort: [{ field: sortField, type: 'DESC' }],
        cateIds: [], sellerId: '', videoType: '',
      }, country)
      if (typeof c?.data === 'number' && c.data > 0) total = c.data
    } catch { /* count e best-effort: sem ele fica o tamanho da pagina */ }

    res.json({ success: true, data: items, total, pageSize: UPSTREAM_PAGE_SIZE, capped: pageSize > UPSTREAM_PAGE_SIZE })
  } catch (e) {
    if (e.scraper_busy)    return res.status(503).json({ success: false, error: 'scraper_busy',    retriable: true })
    if (e.scraper_timeout) return res.status(503).json({ success: false, error: 'scraper_timeout', retriable: true })
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
    const cateIds = parseCateIds(req)
    const range = getDateRange(days)

    const data = await kaloPostWithRetry('/shop/queryList', () => ({
      country,
      ...range,
      pageNo: page,
      pageSize,
      cateIds,
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, { targetCount: cateIds.length ? 1 : Math.min(pageSize - 5, 55) })

    // Coluna "Produtos mais vendidos" da loja: 3 por linha, em lote.
    if (data && Array.isArray(data.data) && data.data.length > 0) {
      await enrichShopProducts(data.data, country, range)
    }

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
 * /api/product/{id}/creators:
 *   get:
 *     summary: Criadores que venderam um produto
 *     tags: [Products, Creators]
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
 *         schema: { type: string, default: revenue, enum: [revenue, sale, video_revenue, live_revenue] }
 *     responses:
 *       200: { description: Lista de criadores }
 *       500: { description: Erro interno }
 */
app.get('/api/product/:id/creators', (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = kaloPost('/product/detail/creator/queryList', {
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
    const cateIds = parseCateIds(req)
    const range = getDateRange(days)

    // O upstream ACEITA a página cheia: /creator/queryList com pageSize=60 devolve
    // os 60 numa única chamada (validado em 2026-07-30 — mesma ordem e mesmos
    // criadores que as 6 páginas de 10 traziam). Fatiar de 10 em 10 com 1,2s de
    // espera entre as páginas custava 6 requisições e ~23s de resposta: acima do
    // teto de 20s do market-proxy e do orçamento do market-sync, que por isso
    // parou de atualizar criadores e deixou a listagem do app congelada por dias.
    // Uma chamada resolve, e de quebra reduz a carga na VPS e a exposição a
    // bloqueio (menos requisições ao upstream, não mais).
    const UPSTREAM_CREATOR_PAGE = Math.min(Math.max(pageSize, 10), 60)
    const data = await kaloPostPaginated('/creator/queryList', (pageNo) => ({
      country,
      ...range,
      pageNo,
      pageSize: UPSTREAM_CREATOR_PAGE,
      cateIds,
      showCateIds: [],
      sort: [{ field: sortField, type: 'DESC' }],
    }), country, {
      targetCount: pageSize,          // acumula até o que o cliente pediu (ex: 60)
      upstreamPageSize: UPSTREAM_CREATOR_PAGE,
      maxPages: Math.ceil(pageSize / UPSTREAM_CREATOR_PAGE) + 1,  // páginas necessárias + margem
      baseDelay: 1200,
      needsSort: false,               // upstream já retorna em ordem de revenue
    })
    // Corta ao pageSize pedido pelo cliente
    if (data && Array.isArray(data.data)) data.data = data.data.slice(0, pageSize)
    else if (data && Array.isArray(data.list)) data.list = data.list.slice(0, pageSize)

    // Coluna "Produtos mais vendidos" do criador: 3 por linha, em lote (o corte
    // acima já rodou, então só enriquecemos o que vai na resposta).
    const rows = (data && (Array.isArray(data.data) ? data.data : Array.isArray(data.list) ? data.list : null)) || null
    if (rows && rows.length > 0) await enrichCreatorProducts(rows, country, range)

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
// Lojas com que o criador de fato trabalha, direto da fonte.
// Antes esse path nao existia (404) e o market-proxy DERIVAVA a lista a partir dos
// produtos, agrupando por seller_id. A derivacao erra: pra saratikshop em 30d ela
// dava "Mawwal Arabia BR R$9,97k / 255 vendas" enquanto a fonte diz
// "R$16,11 mil / 98 vendas". Aqui vem atribuido de verdade, com video_revenue e
// live_revenue separados. pageSize 10 pelo mesmo motivo dos videos.
app.get('/api/creator/:id/shops', async (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const sortField = req.query.sortField || 'revenue'
    const range = getDateRange(days)

    const data = await kaloPostAsync('/creator/detail/searchCooperativeShops', {
      id,
      ...range,
      authority: true,
      pageNo: page,
      pageSize: 10,
      sort: [{ field: sortField, type: 'DESC' }],
      cateIds: [],
      sellerId: '',
    }, country)

    const items = Array.isArray(data?.data) ? data.data
                : Array.isArray(data?.list) ? data.list
                : Array.isArray(data?.items) ? data.items : []

    // Normaliza pro shape que o market-proxy ja consome nas lojas derivadas
    // (id/name/revenue/products/sale), mantendo os extras da fonte.
    const shops = items.map((it) => ({
      id: String(it.seller_id ?? ''),
      seller_id: String(it.seller_id ?? ''),
      name: it.shop_name ?? '',
      shop_name: it.shop_name ?? '',
      revenue: it.revenue ?? null,
      sale: it.sale ?? null,
      products: it.product_count ?? null,
      product_count: it.product_count ?? null,
      seller_type: it.seller_type ?? null,
      video_revenue: it.video_revenue ?? null,
      live_revenue: it.live_revenue ?? null,
    })).filter((x) => x.id)

    res.json({ success: true, data: shops, total: shops.length })
  } catch (e) {
    if (e.scraper_busy)    return res.status(503).json({ success: false, error: 'scraper_busy',    retriable: true })
    if (e.scraper_timeout) return res.status(503).json({ success: false, error: 'scraper_timeout', retriable: true })
    res.status(500).json({ success: false, message: e.message })
  }
})

app.get('/api/creator/:id/products', async (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 20
    const range = getDateRange(days)

    const data = await kaloPostAsync('/creator/detail/searchProducts', {
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
    if (e.scraper_busy)    return res.status(503).json({ success: false, error: 'scraper_busy',    retriable: true })
    if (e.scraper_timeout) return res.status(503).json({ success: false, error: 'scraper_timeout', retriable: true })
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
app.get('/api/creator/:id/total', async (req, res) => {
  try {
    const country = parseCountry(req)
    const { id } = req.params
    const days = parseInt(req.query.days) || 7
    const range = getDateRange(days)

    const data = await kaloPostAsync('/creator/detail/total', {
      id,
      ...range,
      cateIds: [],
      sellerId: '',
      authority: true,
    }, country)
    res.json(data)
  } catch (e) {
    if (e.scraper_busy)    return res.status(503).json({ success: false, error: 'scraper_busy',    retriable: true })
    if (e.scraper_timeout) return res.status(503).json({ success: false, error: 'scraper_timeout', retriable: true })
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
  const lastGood = getLastGoodCookies()
  res.json({
    exists: !!cookies,
    length: cookies.length,
    preview: cookies ? cookies.substring(0, 50) + '...' : null,
    // Ponto de restauracao do keepalive: se o jar atual for lixo, e daqui que
    // ele volta. `sameAsCurrent:false` com sessao caida = alguem gravou por cima.
    lastGood: {
      exists: !!lastGood,
      length: lastGood.length,
      sameAsCurrent: !!lastGood && lastGood === cookies,
    },
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
  const { cookies, force } = req.body || {}
  if (!cookies || typeof cookies !== 'string' || !cookies.trim()) {
    return res.status(400).json({ success: false, message: 'Campo "cookies" e obrigatorio (string nao vazia)' })
  }

  const incoming = cookies.trim()
  const current = getCookies()

  // No-op: a extensao reenvia o mesmo jar a cada 5 min. Sem isso, gastariamos
  // duas sondas de autenticacao por ciclo pra nao mudar nada.
  if (incoming === current) {
    return res.json({ success: true, sessionValid: null, unchanged: true, updatedAt: new Date().toISOString() })
  }

  const incomingAuth = isAuthenticatedCookie(incoming)

  // GUARDA (2026-08-14): antes daqui o PUT gravava cegamente. Em 13/08 as 19h a
  // extensao Cookie Sync, rodando num Chrome deslogado, trocou o jar autenticado
  // (1976 chars) por um anonimo (1651) e derrubou a sessao — o keepalive e o
  // refresh-cookies.sh nao tem como desfazer isso, so um login humano.
  // Agora cookie que nao autentica nunca passa por cima de um que autentica.
  if (!incomingAuth && !force) {
    if (current && isAuthenticatedCookie(current)) {
      console.warn('[cookies] PUT recusado: cookie recebido nao autentica e o atual autentica')
      return res.status(409).json({
        success: false,
        rejected: true,
        sessionValid: true,
        message: 'Cookie recebido nao esta logado no Kalodata. O jar autenticado atual foi mantido. Faca login em kalodata.com antes de sincronizar (ou repita com force:true).',
      })
    }
  }

  setCookies(incoming)
  if (incomingAuth) saveLastGoodCookies(incoming)
  const valid = checkSession()
  res.json({ success: true, sessionValid: valid, authenticated: incomingAuth, updatedAt: new Date().toISOString() })
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
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), queue: getQueueStats() })
})

// ---------------------------------------------------------------------------
// Foto de perfil (avatar) — conversão de HEIC
// ---------------------------------------------------------------------------
// A busca de usuários do TikTok devolve o avatar SÓ em .heic, e nenhum
// navegador de desktop desenha HEIC: a <img> dispara onerror e a Fábrica
// mostrava o ícone genérico no lugar da foto em quase toda a listagem.
// Medido em 13/08/2026: a mesma foto em .jpeg (que só o endpoint de perfil
// entrega, a 1 crédito por página) abre normal, e trocar a extensão na URL
// assinada dá 403.
//
// Esta rota baixa a imagem e devolve JPEG. É o caminho que não custa crédito
// nenhum no provedor, e o resultado fica em cache aqui e no navegador.
// Allowlist por PADRÃO, não por nome exato: o CDN do TikTok serve cada objeto
// pela região de quem pede, e o sufixo acompanha (`tiktokcdn-us.com`,
// `tiktokcdn-eu.com`, e o que mais aparecer). Com a lista fixa, a capa de um
// vídeo servida pela Europa era recusada aqui com invalid_url e continuava sem
// aparecer na tela — medido em 13/08/2026 com `p16-common-sign.tiktokcdn-eu.com`.
// O padrão continua fechado o suficiente: só domínios de mídia do TikTok, do
// Instagram e do Facebook.
const AVATAR_HOSTS_OK = [
  /(^|\.)tiktokcdn(-[a-z0-9]+)?\.com$/i,
  /(^|\.)tiktokcdn-[a-z0-9]+\.[a-z]{2,}$/i,
  /(^|\.)ibyteimg\.com$/i,
  /(^|\.)cdninstagram\.com$/i,
  /(^|\.)fbcdn\.net$/i,
]
const AVATAR_MAX_BYTES = 8 * 1024 * 1024
const AVATAR_TTL_MS = 6 * 60 * 60 * 1000
const AVATAR_CACHE_MAX = 500
const avatarCache = new Map() // url -> { buf, at }

function avatarHostPermitido (u) {
  try {
    const url = new URL(u)
    if (url.protocol !== 'https:') return false
    return AVATAR_HOSTS_OK.some((padrao) => padrao.test(url.hostname))
  } catch {
    return false
  }
}

app.get('/api/avatar', async (req, res) => {
  const u = String(req.query.u || '').trim()
  // Allowlist de host: sem ela a rota viraria um proxy aberto pra qualquer
  // endereço, inclusive da rede interna da VPS.
  if (!avatarHostPermitido(u)) return res.status(400).json({ success: false, code: 'invalid_url' })

  const agora = Date.now()
  const emCache = avatarCache.get(u)
  if (emCache && agora - emCache.at < AVATAR_TTL_MS) {
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    return res.end(emCache.buf)
  }

  const base = `/tmp/avt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  const orig = `${base}.bin`
  const jpg = `${base}.jpg`
  // Destino do resize é arquivo PRÓPRIO, e com extensão .jpg: o ffmpeg escolhe
  // o formato de saída pela extensão, então mandar o resultado de volta no
  // `.bin` de entrada fazia o ffmpeg falhar em silêncio e a rota devolvia os
  // bytes HEIC originais rotulados como JPEG — o navegador seguia sem desenhar.
  const menor = `${base}_p.jpg`
  const limpa = () => { for (const f of [orig, jpg, menor]) { try { unlinkSync(f) } catch { /* já foi */ } } }

  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) { limpa(); return res.status(502).json({ success: false, code: 'upstream_' + r.status }) }
    const bytes = Buffer.from(await r.arrayBuffer())
    if (bytes.length > AVATAR_MAX_BYTES) { limpa(); return res.status(413).json({ success: false, code: 'too_large' }) }

    // "ftyp....heic/heix/mif1" nos primeiros bytes: é o container HEIF. Olhar o
    // conteúdo em vez da extensão porque a URL vem com querystring assinada e
    // nem sempre carrega o sufixo.
    const cabecalho = bytes.subarray(0, 32).toString('latin1')
    const ehHeic = /ftyp(heic|heix|hevc|mif1|msf1)/i.test(cabecalho)

    let saida = bytes
    if (ehHeic) {
      writeFileSync(orig, bytes)
      await new Promise((resolve, reject) => {
        execFile('heif-convert', ['-q', '82', orig, jpg], { timeout: 20000 }, (e) => (e ? reject(e) : resolve()))
      })
      // Avatar aparece em ~40px na tela; 200px cobre telas retina e derruba o
      // arquivo de ~100 KB pra poucos KB, que é o que o operador espera baixar
      // numa listagem com dezenas de páginas.
      await new Promise((resolve) => {
        execFile('ffmpeg', ['-v', 'error', '-y', '-i', jpg, '-vf', 'scale=200:-1', '-q:v', '4', menor], { timeout: 20000 }, () => resolve())
      })
      // O resize é otimização; se falhar, entrega o JPEG inteiro, que já é o
      // que importa — o navegador desenha os dois.
      saida = existsSync(menor) && statSync(menor).size > 0 ? readFileSync(menor) : readFileSync(jpg)
    }

    if (avatarCache.size > AVATAR_CACHE_MAX) avatarCache.clear()
    avatarCache.set(u, { buf: saida, at: agora })
    limpa()
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    return res.end(saida)
  } catch (e) {
    limpa()
    console.warn('[avatar] falhou', String((e && e.message) || e).slice(0, 160))
    return res.status(502).json({ success: false, code: 'convert_failed' })
  }
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

// Produtos atribuídos por vídeo (coluna Produto da listagem). Populado pelo
// /api/videos a partir do endpoint de LOTE /video/enrich. Consts/fns ficam
// disponíveis em request-time (módulo já carregado), igual ao insightCache.
const videoProductsCache = new Map() // `${escopo}:${id}` -> { value, expiresAt }

function vpCacheGet (key) {
  const e = videoProductsCache.get(key)
  if (!e) return null
  if (Date.now() >= e.expiresAt) { videoProductsCache.delete(key); return null }
  return e.value
}
function vpCacheSet (key, value) {
  const TTL = 12 * 60 * 60 * 1000 // 12h
  videoProductsCache.set(key, { value, expiresAt: Date.now() + TTL })
}

// Lote máximo por chamada de enrich. A listagem da Kalodata manda 10 (tamanho
// da página dela), mas o endpoint aceita a página inteira: 60 ids medidos em
// 0,56s. Com 60, a listagem padrão do Domma (pageSize=60) resolve numa chamada
// só. Com o lote de 20 anterior eram 3 chamadas SEQUENCIAIS, e sob fila ocupada
// isso estourava o teto abaixo — o proxy então cacheava por 12h uma resposta
// com quase nada enriquecido.
const VP_CHUNK = 60
// Teto de espera do enrichment DENTRO da request. O lote mede menos de 1s, mas
// a fila do scraper pode estar ocupada; passando disso devolvemos a listagem
// sem o campo enriquecido (o fetch segue e popula o cache pra próxima).
const VP_WAIT_MS = 12000

/**
 * Motor dos três enriquecimentos de listagem, todos com a mesma forma: o
 * upstream tem um endpoint de LOTE que recebe os ids da página e devolve o
 * vínculo cruzado de cada item.
 *
 *   /video/enrich      → produto de cada vídeo   (coluna Produto em vídeos)
 *   /livestream/enrich → produtos de cada live   (coluna Produtos em lives)
 *   /product/enrich    → vídeos de cada produto  (coluna Vídeos em produtos)
 *
 * Cache-first por id (12h, namespaced por escopo). Nunca lança: falha de
 * enrichment deixa a listagem sair sem o campo, que é o comportamento antigo.
 *
 * @param {object[]} items    itens da listagem (mutados no lugar)
 * @param {string}   field    nome do campo a preencher em cada item
 * @param {string}   scope    prefixo da chave de cache
 * @param {string}   path     endpoint de lote no upstream
 * @param {Function} mapRow   (row) => [linhaId, valor] extraído da resposta
 */
async function enrichListing (items, { field, scope, path, mapRow }, country, range) {
  const missing = []
  for (const it of items) {
    const id = it.id ? String(it.id) : ''
    it[field] = []
    if (!id) continue
    const cached = vpCacheGet(`${scope}:${id}`)
    if (cached !== null) it[field] = cached
    else missing.push(id)
  }
  if (!missing.length) return

  const chunks = []
  for (let i = 0; i < missing.length; i += VP_CHUNK) chunks.push(missing.slice(i, i + VP_CHUNK))

  // Pedaços em PARALELO (a fila do scraper já limita a concorrência real): com
  // chunks sequenciais, uma página grande somava as latências e passava do teto.
  const job = Promise.all(chunks.map(async (ids) => {
    try {
      const resp = await kaloPostAsync(path, { ids, country, ...range, cateIds: [] }, country)
      const rows = Array.isArray(resp?.data) ? resp.data : []
      const byId = new Map()
      for (const r of rows) {
        const pair = mapRow(r)
        if (!pair) continue
        const [rowId, value] = pair
        if (!rowId || !value || !value.length) continue
        byId.set(rowId, [...(byId.get(rowId) || []), ...value])
      }
      // Cacheia TODO id pedido — inclusive os que voltaram vazios, senão item
      // sem vínculo seria re-perguntado a cada request.
      for (const id of ids) vpCacheSet(`${scope}:${id}`, byId.get(id) || [])
    } catch (e) {
      // Sem negative cache aqui: erro é da chamada, não do dado. Cachear []
      // esconderia o vínculo por 12h por causa de um timeout.
      console.warn(`[enrich ${scope}] ${ids.length} ids: ${e.message}`)
    }
  }))

  await Promise.race([job, new Promise(r => {
    const t = setTimeout(r, VP_WAIT_MS)
    if (typeof t.unref === 'function') t.unref()
  })])

  // Reaplica o que chegou a tempo (o resto fica pra próxima request, já cacheado).
  for (const it of items) {
    const id = it.id ? String(it.id) : ''
    if (!id || (it[field] && it[field].length)) continue
    const cached = vpCacheGet(`${scope}:${id}`)
    if (cached) it[field] = cached
  }
}

/** Vídeo → produto que ele vende. `title` vem null (o enrich só dá o id). */
function enrichVideoProducts (items, country, range) {
  return enrichListing(items, {
    field: 'products',
    scope: 'vp',
    path: '/video/enrich',
    mapRow: (r) => {
      const vid = String(r?.id ?? '')
      const pid = String(r?.product_id ?? r?.productId ?? '')
      if (!vid || !pid) return null
      return [vid, [{ id: pid, title: String(r?.product_title ?? r?.title ?? '') || null }]]
    },
  }, country, range)
}

// Live, criador e loja compartilham a MESMA resposta de enrich
// (`{id, product_ids:[3]}`) — muda só o path e o namespace de cache.
function productIdsRow (r) {
  const id = String(r?.id ?? '')
  const ids = Array.isArray(r?.product_ids) ? r.product_ids : []
  if (!id) return null
  return [id, ids.map(p => ({ id: String(p), title: null })).filter(p => p.id)]
}

/** Live → produtos mais vendidos nela (o upstream devolve os 3 principais). */
function enrichLiveProducts (items, country, range) {
  return enrichListing(items, {
    field: 'products', scope: 'lp', path: '/livestream/enrich', mapRow: productIdsRow,
  }, country, range)
}

/** Criador → produtos mais vendidos por ele. */
function enrichCreatorProducts (items, country, range) {
  return enrichListing(items, {
    field: 'products', scope: 'cp', path: '/creator/enrich', mapRow: productIdsRow,
  }, country, range)
}

/** Loja → produtos mais vendidos dela. */
function enrichShopProducts (items, country, range) {
  return enrichListing(items, {
    field: 'products', scope: 'sp', path: '/shop/enrich', mapRow: productIdsRow,
  }, country, range)
}

/** Produto → vídeos de maior receita que o vendem (o upstream devolve 3). */
function enrichProductVideos (items, country, range) {
  return enrichListing(items, {
    field: 'videos',
    scope: 'pv',
    path: '/product/enrich',
    mapRow: (r) => {
      const pid = String(r?.id ?? '')
      const vids = Array.isArray(r?.videos) ? r.videos : []
      if (!pid) return null
      return [pid, vids
        .map(v => ({ id: String(v?.id ?? ''), content_type: v?.contentType ?? v?.content_type ?? null }))
        .filter(v => v.id)]
    },
  }, country, range)
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
// Engajamento de vídeo (curtidas, comentários, compartilhamentos)
// ---------------------------------------------------------------------------
// POR QUE ISTO EXISTE: a listagem de vídeos do Domma tem três colunas que nunca
// preenchem, porque o upstream Kalodata NÃO devolve engajamento em /api/videos
// (só views, receita, vendas e ads). O EchoTik tem o dado, mas a API dele só
// expõe ranklists, sem consulta por id, e apenas 24% dos ids do kalo têm par lá.
//
// A fonte que responde por qualquer id é o próprio TikTok, e nós já falamos com
// ele: o mesmo yt-dlp do baixador devolve like_count/comment_count/repost_count
// com --skip-download, sem trazer um byte de vídeo (medido: ~6s por item).
//
// ATENÇÃO À NATUREZA DO NÚMERO: aqui vem o TOTAL ACUMULADO do vídeo, não o do
// período da listagem. No mesmo vídeo, o kalo mostrava 1,36M de views nos 7
// dias e o TikTok 1,8M desde sempre. Quem exibe precisa rotular como total,
// senão o cliente compara com as colunas vizinhas (que são do período) e tira
// conclusão errada.
const engagementCache = new Map()

/** 12h para acerto (engajamento não muda de hora em hora), 30min para falha. */
const ENG_TTL_OK_MS = 12 * 60 * 60 * 1000
const ENG_TTL_FAIL_MS = 30 * 60 * 1000

/** Teto por chamada. A listagem do Domma pede 60; acima disso o tempo estoura. */
const ENG_MAX_ITEMS = 60

/**
 * Quantos yt-dlp rodam ao mesmo tempo.
 *
 * A VPS é COMPARTILHADA com o scraper de mercado e com o worker de render de
 * vídeo (ffmpeg). Subir isto satura a CPU e derruba o resto: já aconteceu de o
 * ffmpeg preso deixar até o SSH sem resposta. Quatro processos leves de rede,
 * sem transcodificação, é o que cabe sem competir com eles.
 */
const ENG_CONCURRENCY = 4

/**
 * Teto de espera DENTRO da request. Passando disso devolvemos o que já ficou
 * pronto e o resto continua em background populando o cache para a próxima
 * chamada. Mesmo desenho do VP_WAIT_MS do enrichment de listagem: a tela nunca
 * fica esperando, ela completa depois.
 */
const ENG_WAIT_MS = 25000

function engCacheGet (id) {
  const e = engagementCache.get(id)
  if (!e) return null
  if (Date.now() >= e.expiresAt) { engagementCache.delete(id); return null }
  return e.value
}

function engCacheSet (id, value, ok) {
  engagementCache.set(id, {
    value,
    expiresAt: Date.now() + (ok ? ENG_TTL_OK_MS : ENG_TTL_FAIL_MS),
  })
}

/** URL canônica do vídeo. Sem handle o TikTok aceita o placeholder. */
function tiktokVideoUrl (id, handle) {
  const user = String(handle || '').replace(/^@+/, '').trim() || 'tiktok'
  return `https://www.tiktok.com/@${user}/video/${id}`
}

/**
 * Lê o engajamento de UM vídeo. Nunca lança: devolve null quando não deu, e o
 * chamador cacheia isso por pouco tempo para não martelar o TikTok.
 *
 * `--skip-download --dump-json` traz o metadado inteiro sem baixar mídia. O
 * handshake de YTDLP_IMPERSONATE/YTDLP_UA é obrigatório pelo mesmo motivo do
 * baixador: sem ele o TikTok responde com challenge e o extractor morre.
 */
function fetchEngagement (id, handle, cb) {
  const url = tiktokVideoUrl(id, handle)
  const args = [
    url,
    '--skip-download',
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '15',
    '--impersonate', YTDLP_IMPERSONATE,
    '--user-agent', YTDLP_UA,
  ]

  const parse = (stdout) => {
    try {
      const j = JSON.parse(String(stdout).trim().split('\n')[0])
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
      const out = {
        likes: n(j.like_count),
        comments: n(j.comment_count),
        shares: n(j.repost_count),
        views: n(j.view_count),
      }
      // Sem nenhum dos quatro não é resposta útil: trata como falha para não
      // cachear zero por 12h e mostrar "0 curtidas" num vídeo com milhares.
      return Object.values(out).some((v) => v != null) ? out : null
    } catch {
      return null
    }
  }

  const roda = (proxy, next) => {
    const a = proxy ? [...args, '--proxy', proxy] : args
    execFile(YTDLP_BIN, a, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, next)
  }

  // DIRETO -> DIRETO -> PROXY, a mesma cadeia do baixador, e pelo mesmo motivo
  // medido em 05/08/2026: o challenge do TikTok ("Unable to extract universal
  // data for rehydration") é INTERMITENTE no IP da VPS, então a segunda direta
  // costuma passar; já o proxy residencial responde 403 Forbidden neste
  // momento. Gastar a única tentativa direta e cair no proxy era trocar o
  // caminho que funciona pelo que não funciona.
  roda(null, (err, stdout) => {
    const ok = !err && parse(stdout)
    if (ok) return cb(ok)
    // Respiro curto: o challenge vem em rajada, e reemendar no mesmo instante
    // costuma colher a mesma negativa.
    setTimeout(() => {
      roda(null, (err2, stdout2) => {
        const ok2 = !err2 && parse(stdout2)
        if (ok2) return cb(ok2)
        const proxy = getNextProxy('br')
        if (!proxy) return cb(null)
        roda(proxy, (err3, stdout3) => cb(!err3 ? parse(stdout3) : null))
      })
    }, 800)
  })
}

/**
 * @swagger
 * /api/videos/engagement:
 *   post:
 *     summary: Curtidas, comentarios e compartilhamentos de uma lista de videos
 *     description: >
 *       Numeros TOTAIS do video (acumulados desde a publicacao), lidos do
 *       TikTok. Nao sao do periodo da listagem. Cache de 12h por id.
 *     tags: [Videos]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     handle: { type: string }
 *     responses:
 *       200:
 *         description: "Mapa id -> { likes, comments, shares, views }. Id ausente do mapa = nao resolvido."
 */
app.post('/api/videos/engagement', async (req, res) => {
  try {
    const raw = Array.isArray(req.body?.items) ? req.body.items : []
    const items = []
    const seen = new Set()
    for (const it of raw) {
      const id = String(it?.id ?? '').trim()
      if (!/^\d{6,}$/.test(id) || seen.has(id)) continue
      seen.add(id)
      items.push({ id, handle: String(it?.handle ?? '').trim() })
      if (items.length >= ENG_MAX_ITEMS) break
    }
    if (!items.length) return res.json({ success: true, data: {}, pending: 0 })

    const data = {}
    const missing = []
    for (const it of items) {
      const cached = engCacheGet(it.id)
      if (cached === null) missing.push(it)
      else if (cached) data[it.id] = cached
      // cached === false (falha recente): sai do mapa, o front mostra vazio.
    }

    if (!missing.length) return res.json({ success: true, data, pending: 0 })

    // Fila com concorrência fixa. O job continua depois do timeout da resposta:
    // o que não deu tempo entra no cache e sai pronto na próxima chamada.
    let cursor = 0
    const resolved = new Map()
    const worker = async () => {
      while (cursor < missing.length) {
        const it = missing[cursor++]
        const value = await new Promise((r) => fetchEngagement(it.id, it.handle, r))
        engCacheSet(it.id, value || false, Boolean(value))
        if (value) resolved.set(it.id, value)
      }
    }
    const job = Promise.all(
      Array.from({ length: Math.min(ENG_CONCURRENCY, missing.length) }, worker),
    )

    await Promise.race([
      job,
      new Promise((r) => {
        const t = setTimeout(r, ENG_WAIT_MS)
        if (typeof t.unref === 'function') t.unref()
      }),
    ])

    for (const [id, value] of resolved) data[id] = value
    const pending = missing.length - resolved.size
    if (pending > 0) console.warn(`[engagement] ${pending} de ${missing.length} ficaram para a proxima chamada`)
    res.json({ success: true, data, pending })
  } catch (e) {
    console.error('[engagement]', e && e.message)
    res.status(500).json({ success: false, message: e && e.message ? e.message : 'internal error' })
  }
})

// ---------------------------------------------------------------------------
// Error middleware — converte erros da fila (kaloPostAsync/kaloGetAsync) em 503
// retriable. Handlers que já capturam individualmente não chegam aqui.
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err && err.scraper_busy)    return res.status(503).json({ success: false, error: 'scraper_busy',    retriable: true })
  if (err && err.scraper_timeout) return res.status(503).json({ success: false, error: 'scraper_timeout', retriable: true })
  console.error('[unhandled]', err && err.message ? err.message : err)
  res.status(500).json({ success: false, message: err && err.message ? err.message : 'internal error' })
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
