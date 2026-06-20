/**
 * lib/scraper-queue.js
 * Fila de concorrência limitada para as chamadas ASYNC ao scraper Kalodata.
 * Apenas kaloPostAsync / kaloGetAsync passam por aqui — kaloPost / kaloGet sync
 * ficam intocados e NÃO usam a fila.
 *
 *  - MAX_CONCURRENCY  slots simultâneos        (env MAX_CONCURRENCY,    default 2)
 *  - REQUEST_TIMEOUT_MS  timeout por slot       (env REQUEST_TIMEOUT_MS, default 22000)
 *  - MAX_QUEUE        backpressure              (env MAX_QUEUE,          default 20)
 *  - Dedup: mesma key em voo → compartilha a Promise existente (não re-raspa)
 */

const MAX_CONCURRENCY    = parseInt(process.env.MAX_CONCURRENCY)    || 2
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 22000
const MAX_QUEUE          = parseInt(process.env.MAX_QUEUE)          || 20

let inFlight   = 0
let queueDepth = 0
const waitQueue   = []        // [{ resolve, reject, fn }]
const inFlightMap = new Map() // key -> Promise (dedup)

export function getQueueStats () {
  return { inFlight, queueDepth, MAX_CONCURRENCY, MAX_QUEUE, REQUEST_TIMEOUT_MS }
}

/**
 * Enfileira fn() com controle de concorrência, timeout e dedup.
 * @param {string}   key  chave de dedup ("POST:/path:country:bodyHash")
 * @param {function} fn   () => Promise<any>
 * @returns {Promise<any>} resolve/rejeita com o resultado de fn()
 */
export function runScraperFn (key, fn) {
  // Dedup: mesma key já em voo -> devolve a Promise existente
  if (inFlightMap.has(key)) return inFlightMap.get(key)

  // Backpressure: fila cheia -> rejeita imediatamente
  if (queueDepth >= MAX_QUEUE) {
    return Promise.reject(Object.assign(new Error('scraper_busy: queue full'), { scraper_busy: true }))
  }

  const p = new Promise((resolve, reject) => {
    queueDepth++
    waitQueue.push({ resolve, reject, fn })
    _drain()
  }).finally(() => {
    inFlightMap.delete(key)
  })

  inFlightMap.set(key, p)
  return p
}

function _drain () {
  while (inFlight < MAX_CONCURRENCY && waitQueue.length > 0) {
    const { resolve, reject, fn } = waitQueue.shift()
    queueDepth--
    inFlight++

    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      inFlight--
      _drain()
      reject(Object.assign(new Error('scraper_timeout'), { scraper_timeout: true }))
    }, REQUEST_TIMEOUT_MS)

    Promise.resolve()
      .then(() => fn())
      .then(result => {
        if (done) return
        done = true
        clearTimeout(timer)
        inFlight--
        _drain()
        resolve(result)
      })
      .catch(err => {
        if (done) return
        done = true
        clearTimeout(timer)
        inFlight--
        _drain()
        reject(err)
      })
  }
}
