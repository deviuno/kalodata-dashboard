import express from 'express'
import cors from 'cors'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

const app = express()
app.use(cors())
app.use(express.json())

const PORT = 3456
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

function getCookies() {
  try {
    return readFileSync('cookies.txt', 'utf-8').trim()
  } catch {
    return ''
  }
}

function kaloPost(path, body) {
  const cookies = getCookies()
  if (!cookies) throw new Error('cookies.txt not found')

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

app.listen(PORT, () => {
  console.log(`Kalodata API proxy running on http://localhost:${PORT}`)
  console.log(`Cookies loaded: ${getCookies() ? 'YES' : 'NO'}`)
})
