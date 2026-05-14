// Cookie Sync extension — v2.0
// Funcionalidades:
//   1. Copia cookies pra clipboard (fallback manual)
//   2. ENVIA cookies direto pro endpoint /api/cookies do servidor (1 clique)
//   3. Auto-sync a cada 15 min via chrome.alarms (background.js)
//   4. Settings persistidos em chrome.storage.local

const CF_COOKIE_PREFIXES = ['__cf', 'cf_', 'cfruid', '_cfuvid'];

const DOMAINS = {
  kalodata: {
    label: 'kalodata.com',
    urls: ['https://www.kalodata.com', 'https://kalodata.com'],
    domains: ['kalodata.com'],
    sessionCookies: ['SESSION'],
    openUrl: 'https://www.kalodata.com',
  },
};

const payload = { kalodata: '' };

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
  const sendBtn = document.getElementById(`send-${key}`);
  const copyBtn = document.getElementById(`copy-${key}`);

  const cookies = await collectCookies(def);
  const nonCfCount = cookies.filter((c) => !isCloudflareCookie(c.name)).length;
  const hasSession = def.sessionCookies.length > 0
    && cookies.some((c) => def.sessionCookies.includes(c.name));
  const logged = hasSession || nonCfCount > 0;
  const str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  statusEl.classList.toggle('ok', logged);
  statusEl.classList.toggle('off', !logged);
  statusText.textContent = logged ? 'Logado' : 'Não logado';
  subEl.textContent = cookies.length === 0
    ? `${def.label} · sem cookies`
    : `${def.label} · ${cookies.length} cookie${cookies.length > 1 ? 's' : ''}`;

  payload[key] = str;
  sendBtn.disabled = cookies.length === 0;
  copyBtn.disabled = cookies.length === 0;
}

async function getConfig() {
  return chrome.storage.local.get(['serverUrl', 'adminKey', 'autoSync']);
}

async function sendToServer(key) {
  const sendBtn = document.getElementById(`send-${key}`);
  const span = sendBtn.querySelector('span');
  const str = payload[key];
  if (!str) return;

  const cfg = await getConfig();
  if (!cfg.serverUrl || !cfg.adminKey) {
    sendBtn.classList.add('error');
    span.textContent = 'Configura URL + admin key';
    document.getElementById('config-section').classList.add('open');
    setTimeout(() => {
      sendBtn.classList.remove('error');
      span.textContent = 'Enviar pro servidor';
    }, 2400);
    return;
  }

  sendBtn.disabled = true;
  span.textContent = 'Enviando...';

  try {
    const r = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/cookies`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': cfg.adminKey,
      },
      body: JSON.stringify({ cookies: str }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) {
      sendBtn.classList.add('success');
      span.textContent = j.sessionValid ? '✓ Sessão válida' : '⚠ Aceito mas sessão inválida';
      await chrome.storage.local.set({
        lastSyncAt: Date.now(),
        lastSyncStatus: 'ok',
        lastSyncError: null,
        lastSessionValid: !!j.sessionValid,
      });
      renderLastSync();
    } else {
      sendBtn.classList.add('error');
      span.textContent = `Falha: ${j.message ?? r.status}`;
      await chrome.storage.local.set({
        lastSyncAt: Date.now(),
        lastSyncStatus: 'fail',
        lastSyncError: j.message ?? `HTTP ${r.status}`,
      });
      renderLastSync();
    }
  } catch (e) {
    sendBtn.classList.add('error');
    span.textContent = 'Erro de rede';
    await chrome.storage.local.set({
      lastSyncAt: Date.now(),
      lastSyncStatus: 'fail',
      lastSyncError: e?.message ?? 'Erro de rede',
    });
    renderLastSync();
  }

  setTimeout(() => {
    sendBtn.classList.remove('success', 'error');
    sendBtn.disabled = false;
    span.textContent = 'Enviar pro servidor';
  }, 2400);
}

function wireSend(key) {
  document.getElementById(`send-${key}`).addEventListener('click', () => sendToServer(key));
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
    const span = btn.querySelector('span');
    btn.classList.add('success');
    span.textContent = 'Copiado!';
    setTimeout(() => {
      btn.classList.remove('success');
      span.textContent = 'Copiar pro clipboard';
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

async function renderLastSync() {
  const el = document.getElementById('last-sync');
  const cfg = await chrome.storage.local.get(['lastSyncAt', 'lastSyncStatus', 'lastSyncError', 'lastSessionValid']);
  if (!cfg.lastSyncAt) {
    el.textContent = 'Nunca sincronizado';
    el.classList.remove('ok', 'fail');
    return;
  }
  const diffMin = Math.floor((Date.now() - cfg.lastSyncAt) / 60000);
  const when = diffMin < 1 ? 'agora' : diffMin < 60 ? `há ${diffMin} min` : `há ${Math.floor(diffMin / 60)}h`;
  if (cfg.lastSyncStatus === 'ok') {
    el.textContent = `Última sync: ${when} · ${cfg.lastSessionValid ? 'sessão válida' : 'sessão pendente'}`;
    el.classList.add('ok');
    el.classList.remove('fail');
  } else {
    el.textContent = `Última sync: ${when} · falhou (${cfg.lastSyncError ?? 'erro'})`;
    el.classList.add('fail');
    el.classList.remove('ok');
  }
}

async function wireAutoSync() {
  const switchEl = document.getElementById('auto-sync');
  const cfg = await getConfig();
  if (cfg.autoSync) switchEl.classList.add('on');
  switchEl.addEventListener('click', async () => {
    const now = await chrome.storage.local.get(['autoSync']);
    const next = !now.autoSync;
    await chrome.storage.local.set({ autoSync: next });
    switchEl.classList.toggle('on', next);
    chrome.runtime.sendMessage({ type: 'reschedule' });
  });
}

async function wireConfig() {
  const toggle = document.getElementById('toggle-config');
  const section = document.getElementById('config-section');
  const urlInput = document.getElementById('server-url');
  const keyInput = document.getElementById('admin-key');

  const cfg = await getConfig();
  urlInput.value = cfg.serverUrl ?? '';
  keyInput.value = cfg.adminKey ?? '';

  toggle.addEventListener('click', () => section.classList.toggle('open'));
  urlInput.addEventListener('change', async () => {
    await chrome.storage.local.set({ serverUrl: urlInput.value.trim() });
  });
  keyInput.addEventListener('change', async () => {
    await chrome.storage.local.set({ adminKey: keyInput.value.trim() });
  });
}

wireSend('kalodata');
wireCopy('kalodata');
wireOpenLinks();
wireAutoSync();
wireConfig();
loadCard('kalodata');
renderLastSync();
