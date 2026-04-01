const DOMAINS = {
  kalodata: ['www.kalodata.com', 'kalodata.com'],
  kalowave: ['clip.kalowave.com', 'www.kaloclip.com'],
}

let currentDomain = 'kalodata'
let currentCookieString = ''

async function loadCookies(domain) {
  currentDomain = domain
  const urls = DOMAINS[domain]
  const allCookies = []

  for (const url of urls) {
    const cookies = await chrome.cookies.getAll({ domain: url })
    for (const c of cookies) {
      if (!allCookies.find(x => x.name === c.name)) {
        allCookies.push(c)
      }
    }
  }

  const box = document.getElementById('cookies')
  const count = document.getElementById('count')
  const copyBtn = document.getElementById('copy')

  if (allCookies.length === 0) {
    box.textContent = 'Nenhum cookie encontrado. Acesse o site primeiro.'
    count.textContent = ''
    currentCookieString = ''
    copyBtn.style.display = 'none'
    return
  }

  currentCookieString = allCookies.map(c => `${c.name}=${c.value}`).join('; ')
  box.textContent = currentCookieString
  count.textContent = `${allCookies.length} cookies`
  copyBtn.style.display = 'flex'
  copyBtn.textContent = 'Copiar Cookies'
  copyBtn.classList.remove('copied')

  // Update active tab
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.domain === domain)
  })
}

// Tab clicks
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => loadCookies(tab.dataset.domain))
})

// Copy button
document.getElementById('copy').addEventListener('click', async () => {
  if (!currentCookieString) return
  await navigator.clipboard.writeText(currentCookieString)
  const btn = document.getElementById('copy')
  btn.textContent = 'Copiado!'
  btn.classList.add('copied')
  setTimeout(() => {
    btn.textContent = 'Copiar Cookies'
    btn.classList.remove('copied')
  }, 2000)
})

// Load on open
loadCookies('kalodata')
