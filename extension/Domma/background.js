// Service worker: dispara sync periódico de cookies enquanto auto-sync
// estiver ligado.
//
// v2.1 (2026-05-15): ciclo reduzido de 15 → 5 min + listener de
// chrome.cookies.onChanged pra sync imediato.
//
// v2.2 (2026-05-15): PING ATIVO antes de coletar cookies. Antes do
// chrome.cookies.getAll, faz fetch silencioso pra
// kalodata.com/user/features. Esse request usa os cookies do browser e,
// se forem renováveis (refresh token ainda válido), o servidor responde
// com Set-Cookie atualizando a sessão. Sem isso, a extensão capturava
// cookies já expirados — e o sync mandava lixo pro servidor.
//
// Funciona MESMO sem aba Kalodata aberta porque o service worker tem
// permissão `host_permissions` pra kalodata.com.

const ALARM_NAME = 'kalodata-cookie-sync';
const SYNC_INTERVAL_MIN = 5;
// Cookies que indicam renovação da sessão Kalodata (não os do Cloudflare).
const SESSION_COOKIE_HINTS = ['SESSION', 'sessionid', 'kalo_token', 'token'];
// Endpoint barato no Kalodata pra "tocar" a sessão e forçar Set-Cookie.
// /user/features é chamada normal da UI — não dispara analytics, é leve.
const KALODATA_PING_URL = 'https://www.kalodata.com/user/features';

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

/**
 * Faz POST silencioso pra /user/features no Kalodata. O browser anexa os
 * cookies automaticamente; se a sessão estiver renovável, o servidor
 * responde Set-Cookie e o ttl reseta. Se cookies já estão totalmente
 * expirados/revogados, retorna 401 (logamos mas seguimos — o sync abaixo
 * vai mandar o que tiver e o servidor reporta sessionValid=false).
 *
 * Aguarda no máx 8s. Falha silenciosa — não impede o sync de cookies.
 */
async function pingKalodata() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    await fetch(KALODATA_PING_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'country': 'BR',
        'currency': 'BRL',
        'language': 'pt-BR',
      },
      body: JSON.stringify({ country: 'BR', list: ['PRODUCT.LIST'] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (_) {
    // Sem rede / timeout / CORS — segue sem reclamar
  }
}

async function syncOnce() {
  const cfg = await chrome.storage.local.get(['serverUrl', 'adminKey', 'autoSync', 'lastSyncAt', 'lastSyncStatus']);
  if (!cfg.autoSync || !cfg.serverUrl || !cfg.adminKey) return;

  // 1. Ping ativo: força Kalodata a renovar Set-Cookie ANTES de coletarmos.
  await pingKalodata();

  // 2. Coleta cookies (agora frescos, se ping funcionou).
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
