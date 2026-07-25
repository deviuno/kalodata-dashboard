// Garante o yt-dlp na VPS (postinstall). Só age em Linux — em dev no Windows/
// Mac é no-op. Best-effort: NUNCA falha o npm install (o endpoint
// /api/tiktok/fetch responde ytdlp_missing se a instalação não rolar).
const { execSync } = require('child_process')

if (process.platform !== 'linux') process.exit(0)

try {
  execSync('command -v yt-dlp', { stdio: 'ignore', shell: '/bin/bash' })
  process.exit(0) // já instalado
} catch { /* segue pra instalação */ }

const tentativas = [
  'pip3 install --break-system-packages -U yt-dlp',
  'pip3 install -U yt-dlp',
  'apt-get install -y yt-dlp',
]
for (const cmd of tentativas) {
  try {
    execSync(cmd, { stdio: 'ignore', shell: '/bin/bash', timeout: 180000 })
    console.log('[ensure-ytdlp] instalado via:', cmd)
    process.exit(0)
  } catch { /* tenta a próxima via */ }
}
console.warn('[ensure-ytdlp] não consegui instalar o yt-dlp — /api/tiktok/fetch vai responder ytdlp_missing')
process.exit(0)
