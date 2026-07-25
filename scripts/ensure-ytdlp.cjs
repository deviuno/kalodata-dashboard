// Garante um yt-dlp ATUAL pro endpoint /api/tiktok/fetch (postinstall).
// Só age em Linux — em dev no Windows/Mac é no-op. Best-effort: NUNCA falha
// o npm install (o endpoint responde ytdlp_missing se nada funcionar).
//
// Estratégia: baixa o binário standalone oficial pra ./bin/yt-dlp (não depende
// de pip/apt — o apt do Ubuntu instala versão de 2022 cujo extractor do TikTok
// está quebrado: "Expecting value: line 1 column 1"). O server.js prefere
// ./bin/yt-dlp quando existe.
const { execSync } = require('child_process')
const { mkdirSync, existsSync } = require('fs')
const { join } = require('path')

if (process.platform !== 'linux') process.exit(0)

const binDir = join(__dirname, '..', 'bin')
const bin = join(binDir, 'yt-dlp')
mkdirSync(binDir, { recursive: true })

const sh = (cmd, timeout = 180000) => execSync(cmd, { stdio: 'ignore', shell: '/bin/bash', timeout })

try {
  sh(`curl -fsSL -o "${bin}" https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && chmod +x "${bin}"`)
  const v = execSync(`"${bin}" --version`, { shell: '/bin/bash', timeout: 15000 }).toString().trim()
  console.log('[ensure-ytdlp] binario standalone ok, versao', v)
  process.exit(0)
} catch { /* tenta pip como fallback */ }

const tentativas = [
  'pip3 install --break-system-packages -U yt-dlp',
  'pip3 install -U yt-dlp',
  'python3 -m pip install --break-system-packages -U yt-dlp',
]
for (const cmd of tentativas) {
  try {
    sh(cmd)
    console.log('[ensure-ytdlp] instalado via:', cmd)
    process.exit(0)
  } catch { /* tenta a próxima via */ }
}
console.warn('[ensure-ytdlp] nenhuma via funcionou — /api/tiktok/fetch vai responder ytdlp_missing/desatualizado')
process.exit(0)
