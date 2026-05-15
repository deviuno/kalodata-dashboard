// Service worker: dispara sync periódico de cookies enquanto auto-sync
// estiver ligado. v2.1 (2026-05-15): ciclo reduzido de 15 → 5 min porque
// observamos sessões expirando em ~10min (provavelmente rate-limit acumulado
// pelo monitor + crons multi-país pingando /user/features). Além do polling
// timed, escutamos chrome.cookies.onChanged pra sincronizar IMEDIATAMENTE
// sempre que o user navega no Kalodata e os cookies de auth são renovados —
// elimina o gap entre expiração e próximo poll.

const ALARM_NAME = 'kalodata-cookie-sync';
const SYNC_INTERVAL_MIN = 5;
// Cookies que indicam renovação da sessão Kalodata (não os do Cloudflare).
const SESSION_COOKIE_HINTS = ['SESSION', 'sessionid', 'kalo_token', 'token'];

const DOMAINS = {
  kalodata: {
    urls: ['https://www.kalodata.com', 'https://kalodata.com'],
    domains: ['kalodata.com'],
  },
};

async function collectCookies(def) {
  const seen = new Map();
  for (const url of def.urls) {
    try {
      const list = await chrome.cookies.getAll({ url });
      for (const c of list) if (!seen.has(c.name)) seen.set(c.name, c);
    } catch (_) { /* ignore */ }
  }
  for (const domain of def.domains) {
    try {
      const list = await chrome.cookies.getAll({ domain });
      for (const c of list) if (!seen.has(c.name)) seen.set(c.name, c);
    } catch (_) { /* ignore */ }
  }
  return Array.from(seen.values());
}

async function syncOnce() {
  const cfg = await chrome.storage.local.get(['serverUrl', 'adminKey', 'autoSync', 'lastSyncAt', 'lastSyncStatus']);
  if (!cfg.autoSync || !cfg.serverUrl || !cfg.adminKey) return;

  const cookies = await collectCookies(DOMAINS.kalodata);
  if (cookies.length === 0) {
    await chrome.storage.local.set({
      lastSyncAt: Date.now(),
      lastSyncStatus: 'no-cookies',
      lastSyncError: 'Sem cookies pra enviar — faça login na Kalodata',
    });
    return;
  }
  const str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

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
    await chrome.storage.local.set({
      lastSyncAt: Date.now(),
      lastSyncStatus: r.ok && j.success ? 'ok' : 'fail',
      lastSyncError: r.ok && j.success ? null : (j.message ?? `HTTP ${r.status}`),
      lastSessionValid: !!j.sessionValid,
    });
  } catch (e) {
    await chrome.storage.local.set({
      lastSyncAt: Date.now(),
      lastSyncStatus: 'fail',
      lastSyncError: e?.message ?? 'Erro de rede',
    });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // Defaults na primeira instalação
  const cfg = await chrome.storage.local.get(['serverUrl', 'adminKey', 'autoSync']);
  if (cfg.serverUrl === undefined) {
    await chrome.storage.local.set({ serverUrl: 'http://187.127.0.217:3456' });
  }
  if (cfg.autoSync === undefined) {
    await chrome.storage.local.set({ autoSync: false });
  }
  await rescheduleAlarm();
});

chrome.runtime.onStartup.addListener(rescheduleAlarm);

async function rescheduleAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const { autoSync } = await chrome.storage.local.get(['autoSync']);
  if (autoSync) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MIN });
    syncOnce(); // sync imediato ao ligar
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) syncOnce();
});

// Sync IMEDIATO quando cookies de sessão da Kalodata mudam — fechamento
// completo do gap entre expiração (~10min) e próximo poll (5min). Quando o
// user simplesmente navega no Kalodata, os cookies renovam automaticamente
// e a extensão captura na hora. Debounce de 2s pra evitar storm em refresh.
let cookieDebounceTimer = null;
chrome.cookies.onChanged.addListener((changeInfo) => {
  const c = changeInfo.cookie;
  if (!c?.domain || !c.domain.includes('kalodata.com')) return;
  // Ignora cookies do Cloudflare (mudam toda hora) — só liga em cookies
  // de sessão de aplicação que indicam login renovado.
  const isSession = SESSION_COOKIE_HINTS.some((h) => c.name.toLowerCase().includes(h.toLowerCase()));
  if (!isSession) return;

  if (cookieDebounceTimer) clearTimeout(cookieDebounceTimer);
  cookieDebounceTimer = setTimeout(() => {
    chrome.storage.local.get(['autoSync']).then(({ autoSync }) => {
      if (autoSync) syncOnce();
    });
  }, 2000);
});

// Trigger manual via popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync-now') {
    syncOnce().then(() => sendResponse({ done: true }));
    return true; // resposta async
  }
  if (msg.type === 'reschedule') {
    rescheduleAlarm().then(() => sendResponse({ done: true }));
    return true;
  }
});
