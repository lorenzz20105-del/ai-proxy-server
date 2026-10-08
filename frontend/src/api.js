const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export function getKey() {
  return localStorage.getItem('proxy_key') || '';
}
export function setKey(k) {
  localStorage.setItem('proxy_key', k);
}

async function req(path, options = {}) {
  const key = getKey();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const api = {
  health: () => fetch(`${BASE}/health`).then(r => r.json()),
  stats: () => req('/admin/stats'),
  accounts: () => req('/admin/accounts'),
  addAccount: (a) => req('/admin/accounts', { method: 'POST', body: JSON.stringify(a) }),
  updateAccount: (name, a) => req(`/admin/accounts/${name}`, { method: 'PUT', body: JSON.stringify(a) }),
  deleteAccount: (name) => req(`/admin/accounts/${name}`, { method: 'DELETE' }),
  strategy: (s) => req(`/admin/strategy?strategy=${s}`, { method: 'PUT' }),
  key: () => req('/admin/key'),
  logs: (limit = 100) => req(`/admin/logs?limit=${limit}`),
  clearLogs: () => req('/admin/logs', { method: 'DELETE' }),
  models: () => req('/v1/models'),
  locations: () => req('/admin/locations'),
  logsByAccount: (name) => req(`/admin/logs/account/${name}`),
  exportLogs: () => req('/admin/export-logs'),
  usage: () => req('/admin/usage'),
  cache: () => req('/admin/cache'),
  clearCache: () => req('/admin/cache', { method: 'DELETE' }),
  budget: () => req('/admin/budget'),
  setBudget: (usd) => req(`/admin/budget?usd=${usd}`, { method: 'PUT' }),
  aliases: () => req('/admin/aliases'),
  addAlias: (alias, targets) => req('/admin/alias?alias=' + encodeURIComponent(alias) + '&targets=' + encodeURIComponent(targets.join(',')), { method: 'POST' }),
  testChat: (model, message) => req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: message }] }) }),
  healthCheck: () => req('/admin/health-check', { method: 'POST' }),
  toggleAccount: (name, enabled) => req(`/admin/accounts/${name}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
};
