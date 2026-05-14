// Service worker: dispara sync periódico de cookies enquanto auto-sync
// estiver ligado. O ciclo de 15 min cobre folga do TTL do cf_clearance
// (~30-60 min) — sempre haverá um cookie fresh no servidor.

const ALARM_NAME = 'kalodata-cookie-sync';

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
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 15 });
    syncOnce(); // sync imediato ao ligar
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) syncOnce();
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
