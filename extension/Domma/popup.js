// Estratégia (padrão anterior — compatível com o textarea da dashboard):
// Ambos os cards copiam a string "name=value; name=value" dos cookies do
// domínio correspondente. A dashboard usa esses cookies pra manter o flow
// Kalodata → SSO → Kalowave JWT funcionando sem intervenção.

const CF_COOKIE_PREFIXES = ['__cf', 'cf_', 'cfruid', '_cfuvid'];

const DOMAINS = {
  kalodata: {
    label: 'kalodata.com',
    urls: ['https://www.kalodata.com', 'https://kalodata.com'],
    domains: ['kalodata.com'],
    sessionCookies: ['SESSION'],
    openUrl: 'https://www.kalodata.com',
  },
  kalowave: {
    label: 'clip.kalowave.com',
    urls: ['https://clip.kalowave.com', 'https://www.kaloclip.com', 'https://kaloclip.com'],
    domains: ['kalowave.com', 'kaloclip.com'],
    // Kalowave autentica por JWT em localStorage, mas a dashboard espera
    // a string de cookies pra passar pelo flow de auto-refresh SSO.
    sessionCookies: [],
    openUrl: 'https://clip.kalowave.com',
  },
};

const payload = { kalodata: '', kalowave: '' };

function isCloudflareCookie(name) {
  return CF_COOKIE_PREFIXES.some((p) => name.startsWith(p));
}

async function collectCookies(def) {
  const seen = new Map();
  for (const url of def.urls) {
    try {
      const list = await chrome.cookies.getAll({ url });
      for (const c of list) if (!seen.has(c.name)) seen.set(c.name, c);
    } catch (e) { console.warn('getAll url', url, e); }
  }
  for (const domain of def.domains) {
    try {
      const list = await chrome.cookies.getAll({ domain });
      for (const c of list) if (!seen.has(c.name)) seen.set(c.name, c);
    } catch (e) { console.warn('getAll domain', domain, e); }
  }
  return Array.from(seen.values());
}

async function loadCard(key) {
  const def = DOMAINS[key];
  const subEl = document.getElementById(`sub-${key}`);
  const statusEl = document.getElementById(`status-${key}`);
  const statusText = document.getElementById(`status-text-${key}`);
  const btn = document.getElementById(`copy-${key}`);
  const btnSpan = btn.querySelector('span');

  const cookies = await collectCookies(def);
  const nonCfCount = cookies.filter((c) => !isCloudflareCookie(c.name)).length;
  const hasSession = def.sessionCookies.length > 0
    && cookies.some((c) => def.sessionCookies.includes(c.name));
  // Considera "logado" se tiver um cookie de sessão conhecido OU qualquer
  // cookie não-Cloudflare (o Kalowave não tem nome fixo de sessão).
  const logged = hasSession || nonCfCount > 0;
  const str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  statusEl.classList.toggle('ok', logged);
  statusEl.classList.toggle('off', !logged);
  statusText.textContent = logged ? 'Logado' : 'Não logado';
  subEl.textContent = cookies.length === 0
    ? `${def.label} · sem cookies`
    : `${def.label} · ${cookies.length} cookie${cookies.length > 1 ? 's' : ''}`;

  payload[key] = str;
  btn.disabled = cookies.length === 0;
  btn.classList.remove('copied');
  btnSpan.textContent = cookies.length > 0 ? 'Copiar cookies' : 'Faça login primeiro';
}

function wireCopy(key) {
  const btn = document.getElementById(`copy-${key}`);
  btn.addEventListener('click', async () => {
    const str = payload[key];
    if (!str) return;
    try {
      await navigator.clipboard.writeText(str);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = str;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.classList.add('copied');
    btn.querySelector('span').textContent = 'Copiado!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('span').textContent = 'Copiar cookies';
    }, 1600);
  });
}

function wireOpenLinks() {
  document.querySelectorAll('.open-link[data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const url = el.getAttribute('data-open');
      if (url) chrome.tabs.create({ url });
    });
  });
}

wireCopy('kalodata');
wireCopy('kalowave');
wireOpenLinks();

loadCard('kalodata');
loadCard('kalowave');
