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
//
// v2.4 (2026-08-14): NÃO sincroniza mais com o navegador deslogado. Antes a
// única checagem era `cookies.length > 0` — e cookie de tracking (_ga, _fbp,
// _ttp) existe mesmo sem login, então a extensão enviava uma sessão anônima e o
// servidor gravava por cima da sessão boa. Foi assim que a sessão da VPS caiu em
// 13/08 às 19h. Agora o ciclo confirma o login em /api/sso/clip-token antes de
// mandar qualquer coisa, e respeita a recusa (HTTP 409) do servidor.

const ALARM_NAME = 'kalodata-cookie-sync';
const SYNC_INTERVAL_MIN = 5;
// Cookies que indicam renovação da sessão Kalodata (não os do Cloudflare).
const SESSION_COOKIE_HINTS = ['SESSION', 'sessionid', 'kalo_token', 'token'];
// Endpoint barato no Kalodata pra "tocar" a sessão e forçar Set-Cookie.
// /user/features é chamada normal da UI — não dispara analytics, é leve.
const KALODATA_PING_URL = 'https://www.kalodata.com/user/features';
// Só devolve success+token com sessão LOGADA. É a mesma sonda que o servidor e
// o refresh-cookies.sh usam, então os três concordam sobre o que é "logado".
const KALODATA_AUTH_URL = 'https://www.kalodata.com/api/sso/clip-token';

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

/**
 * O navegador está realmente logado no Kalodata?
 *
 * Cookie de tracking existe sempre, então contar cookies não responde isso.
 * Aqui a resposta vem do próprio Kalodata. Timeout de 8s; qualquer erro conta
 * como "não logado" — na dúvida a extensão fica quieta em vez de empurrar uma
 * sessão anônima pro servidor.
 */
async function isBrowserAuthenticated() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(KALODATA_AUTH_URL, {
      credentials: 'include',
      headers: { accept: 'application/json', country: 'BR', language: 'pt-BR' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j?.success && j?.data?.token);
  } catch (_) {
    return false;
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
      lastSyncError: 'Sem cookies pra enviar. Faça login na Kalodata.',
      lastSessionValid: false,
    });
    return;
  }
  const str = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  // 3. Trava de segurança: sem login no navegador, nada sai daqui. Mandar uma
  //    sessão anônima não é neutro, ela substitui a sessão viva do servidor.
  if (!(await isBrowserAuthenticated())) {
    await chrome.storage.local.set({
      lastSyncAt: Date.now(),
      lastSyncStatus: 'logged-out',
      lastSyncError: 'Navegador deslogado do Kalodata. Nada foi enviado.',
      lastSessionValid: false,
    });
    return;
  }

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
    // 409 = o servidor recusou porque o jar dele autentica e o nosso não. Isso
    // é o guarda funcionando, não uma falha de rede: registra como recusa.
    const rejected = r.status === 409 || !!j.rejected;
    await chrome.storage.local.set({
      lastSyncAt: Date.now(),
      lastSyncStatus: r.ok && j.success ? 'ok' : (rejected ? 'rejected' : 'fail'),
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

// Servidor padrão. O IP 187.127.0.217 que ficava aqui é FANTASMA (nunca
// respondeu em produção): quem instalasse a extensão e não trocasse o campo
// sincronizava cookies pro vazio, e a sessão caía sem ninguém entender.
const DEFAULT_SERVER_URL = 'https://kalo-api.domma.ai';
const LEGACY_SERVER_URLS = ['http://187.127.0.217:3456', 'http://187.127.0.217:5174'];

chrome.runtime.onInstalled.addListener(async () => {
  // Defaults na primeira instalação
  const cfg = await chrome.storage.local.get(['serverUrl', 'adminKey', 'autoSync']);
  if (cfg.serverUrl === undefined || LEGACY_SERVER_URLS.includes(cfg.serverUrl)) {
    // Também MIGRA quem já estava apontando pro IP morto.
    await chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
  }
  if (cfg.autoSync === undefined) {
    // Nasce ligado: a extensão só existe pra manter a sessão viva, e o padrão
    // desligado fazia a renovação depender de alguém lembrar de ativar.
    await chrome.storage.local.set({ autoSync: true });
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
