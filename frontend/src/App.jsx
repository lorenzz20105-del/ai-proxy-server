import { useState, useEffect, useCallback } from 'react';
import { api, getKey, setKey } from './api';
import './App.css';

const TABS = ['Dashboard', 'Providers', 'Playground', 'Logs', 'Settings'];

function KeyGate({ onDone }) {
  const [val, setVal] = useState('');
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>AI Proxy Console</h1>
        <p>Enter your proxy master API key to continue.</p>
        <input type="password" placeholder="x-api-key" value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && val && (setKey(val), onDone())} />
        <button onClick={() => val && (setKey(val), onDone())}>Connect</button>
      </div>
    </div>
  );
}

function Badge({ ok, children }) {
  return <span className={`badge ${ok ? 'ok' : 'err'}`}>{children}</span>;
}

function Dashboard() {
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);
  const [locations, setLocations] = useState(null);
  const [usage, setUsage] = useState(null);
  const load = useCallback(async () => {
    try { setStats(await api.stats()); } catch {}
    try { setHealth(await api.health()); } catch {}
    try { setLocations((await api.locations()).locations); } catch {}
    try { setUsage(await api.usage()); } catch {}
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  if (!stats) return <p className="muted">Loading…</p>;
  const totalReq = stats.accounts.reduce((s, a) => s + a.requests, 0);
  const totalErr = stats.accounts.reduce((s, a) => s + a.errors, 0);

  return (
    <div>
      <div className="cards">
        <div className="card"><h3>{totalReq}</h3><p>Total Requests</p></div>
        <div className="card"><h3>{totalErr}</h3><p>Errors</p></div>
        <div className="card"><h3>{health?.healthy_accounts ?? '—'}/{health?.total_accounts ?? '—'}</h3><p>Healthy Accounts</p></div>
        <div className="card"><h3>{stats.strategy}</h3><p>Strategy</p></div>
        <div className="card"><h3>{Object.keys(locations || {}).length}</h3><p>Locations</p></div>
        <div className="card"><h3>{usage?.cost?.total_usd ? `$${usage.cost.total_usd.toFixed(4)}` : '—'}</h3><p>Total Cost</p></div>
        <div className="card"><h3>{usage?.cache?.entries ?? 0}</h3><p>Cache Entries</p></div>
        <div className="card"><h3>{usage?.tokens?.by_account ? Object.values(usage.tokens.by_account).reduce((s, t) => s + t.total, 0) : 0}</h3><p>Total Tokens</p></div>
        <div className="card"><h3>{usage?.latency?.by_account ? Object.values(usage.latency.by_account).find(l => l)?.avg ?? '—' : '—'}s</h3><p>Avg Latency</p></div>
      </div>

      {locations && (
        <>
          <h2>Locations</h2>
          <div className="cards">
            {Object.entries(locations).map(([loc, names]) => (
              <div className="card" key={loc}>
                <h3 style={{fontSize: 16}}>{loc}</h3>
                <p>{names.join(', ')}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {usage?.cost?.by_model && Object.keys(usage.cost.by_model).length > 0 && (
        <>
          <h2>Cost by Model</h2>
          <table>
            <thead><tr><th>Model</th><th>Cost (USD)</th><th>Tokens</th><th>Avg Latency</th></tr></thead>
            <tbody>
              {Object.entries(usage.cost.by_model).map(([m, c]) => (
                <tr key={m}>
                  <td><code>{m}</code></td>
                  <td>${c.toFixed(4)}</td>
                  <td>{usage?.tokens?.by_model?.[m]?.total ?? 0}</td>
                  <td>{usage?.latency?.by_model?.[m]?.avg != null ? `${usage.latency.by_model[m].avg}s` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {usage?.model_usage && Object.keys(usage.model_usage).length > 0 && (
        <>
          <h2>Model Usage</h2>
          <table>
            <thead><tr><th>Model</th><th>Requests</th></tr></thead>
            <tbody>
              {Object.entries(usage.model_usage).map(([m, count]) => (
                <tr key={m}><td><code>{m}</code></td><td>{count}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {usage?.tokens?.by_account && Object.keys(usage.tokens.by_account).length > 0 && (
        <>
          <h2>Token Usage by Account</h2>
          <table>
            <thead><tr><th>Account</th><th>Prompt</th><th>Completion</th><th>Total</th></tr></thead>
            <tbody>
              {Object.entries(usage.tokens.by_account).map(([name, t]) => (
                <tr key={name}><td><code>{name}</code></td><td>{t.prompt}</td><td>{t.completion}</td><td>{t.total}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="row between">
        <h2>Accounts</h2>
        <button className="small" onClick={async () => { const r = await api.healthCheck(); alert(JSON.stringify(r.results.map(x => `${x.name}: ${x.status}`), null, 2)); }}>Health Check</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Location</th><th>Status</th><th>Requests</th><th>Errors</th><th>Success</th><th>Tokens</th><th>Avg Latency</th><th>Last Used</th><th>Models</th></tr></thead>
        <tbody>
          {stats.accounts.map(a => (
            <tr key={a.name}>
              <td>{a.name}</td>
              <td><code>{a.provider_type}</code></td>
              <td>{a.location || '—'}</td>
              <td><Badge ok={a.healthy && a.enabled}>{a.enabled ? (a.healthy ? 'Healthy' : 'Down') : 'Disabled'}</Badge></td>
              <td>{a.requests}</td>
              <td>{a.errors}</td>
              <td>{a.success_rate != null ? `${a.success_rate}%` : '—'}</td>
              <td>{usage?.tokens?.by_account?.[a.name]?.total ?? 0}</td>
              <td>{usage?.latency?.by_account?.[a.name]?.avg != null ? `${usage.latency.by_account[a.name].avg}s` : '—'}</td>
              <td>{a.last_used_ago != null ? `${a.last_used_ago}s ago` : 'never'}</td>
              <td>{a.models?.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY = { name: '', base_url: '', api_key: '', models: '', provider_type: 'openai', weight: 1, proxy_url: '', location: '', user_agent: '' };

function Providers() {
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { const r = await api.accounts(); setAccounts(r.accounts); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    const payload = {
      ...form,
      models: form.models.split(',').map(s => s.trim()).filter(Boolean),
      weight: Number(form.weight) || 1,
      proxy_url: form.proxy_url || null,
      location: form.location || null,
      user_agent: form.user_agent || null,
    };
    try {
      if (editing) await api.updateAccount(form.name, payload);
      else await api.addAccount(payload);
      setForm(EMPTY); setEditing(false); load();
    } catch (e) { setErr(e.message); }
  };

  const del = async (name) => { if (confirm(`Delete ${name}?`)) { await api.deleteAccount(name); load(); } };
  const edit = (a) => {
    setForm({ ...a, models: a.models.join(', '), proxy_url: a.proxy_url || '', location: a.location || '', user_agent: a.user_agent || '' });
    setEditing(true);
  };

  return (
    <div>
      <h2>{editing ? 'Edit Provider' : 'Add Provider'}</h2>
      <form className="form" onSubmit={submit}>
        <input placeholder="Name (e.g. my-openai)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required disabled={editing} />
        <select value={form.provider_type} onChange={e => setForm({ ...form, provider_type: e.target.value })}>
          <option value="openai">OpenAI-compatible</option>
          <option value="claude">Claude (Anthropic)</option>
          <option value="google">Google Gemini</option>
          <option value="custom">Custom</option>
        </select>
        <input placeholder="Base URL" value={form.base_url} onChange={e => setForm({ ...form, base_url: e.target.value })} required />
        <input placeholder="API Key" type="password" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} required />
        <input placeholder="Models (comma-separated)" value={form.models} onChange={e => setForm({ ...form, models: e.target.value })} />
        <input type="number" placeholder="Weight" value={form.weight} onChange={e => setForm({ ...form, weight: e.target.value })} />
        <input placeholder="Location label (e.g. US-East, EU-West)" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} />
        <input placeholder="Proxy URL (e.g. http://user:pass@ip:port or socks5://ip:port)" value={form.proxy_url} onChange={e => setForm({ ...form, proxy_url: e.target.value })} />
        <input placeholder="Custom User-Agent (optional)" value={form.user_agent} onChange={e => setForm({ ...form, user_agent: e.target.value })} />
        <div className="row">
          <button type="submit">{editing ? 'Update' : 'Add Provider'}</button>
          {editing && <button type="button" className="ghost" onClick={() => { setForm(EMPTY); setEditing(false); }}>Cancel</button>}
        </div>
      </form>
      {err && <p className="err">{err}</p>}

      <h2>Configured Providers</h2>
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Location</th><th>Proxy</th><th>Models</th><th>Weight</th><th>Enabled</th><th></th></tr></thead>
        <tbody>
          {accounts.map(a => (
            <tr key={a.name}>
              <td>{a.name}</td>
              <td><code>{a.provider_type}</code></td>
              <td>{a.location || '—'}</td>
              <td><code className="ellipsis">{a.proxy_url || 'direct'}</code></td>
              <td>{a.models?.join(', ')}</td>
              <td>{a.weight}</td>
              <td><Badge ok={a.enabled}>{a.enabled ? 'Yes' : 'No'}</Badge></td>
              <td>
                <button className="small" onClick={() => edit(a)}>Edit</button>{' '}
                <button className={a.enabled ? 'small danger' : 'small'} onClick={async () => { await api.updateAccount(a.name, { ...a, enabled: !a.enabled }); load(); }}>{a.enabled ? 'Disable' : 'Enable'}</button>{' '}
                <button className="small danger" onClick={() => del(a.name)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Playground() {
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.models().then(r => setModels(r.data.map(m => m.id))).catch(() => {});
  }, []);

  const send = async () => {
    if (!model || !message) return;
    setLoading(true); setErr(''); setResponse('');
    try {
      const r = await api.testChat(model, message);
      setResponse(r.choices?.[0]?.message?.content || JSON.stringify(r, null, 2));
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div>
      <h2>Playground</h2>
      <div className="form">
        <select value={model} onChange={e => setModel(e.target.value)}>
          <option value="">Select model</option>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <textarea placeholder="Enter message..." value={message} onChange={e => setMessage(e.target.value)} rows={4} />
        <button onClick={send} disabled={loading}>{loading ? 'Sending...' : 'Send'}</button>
      </div>
      {err && <p className="err">{err}</p>}
      {response && (
        <>
          <h3>Response</h3>
          <pre>{response}</pre>
        </>
      )}
      {err && err.includes('502') && <p className="muted">Tip: check which account is healthy in the Dashboard.</p>}
    </div>
  );
}

function Logs() {
  const [logs, setLogs] = useState([]);
  const load = useCallback(async () => { try { const r = await api.logs(200); setLogs(r.logs); } catch {} }, []);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  return (
    <div>
      <div className="row between">
        <h2>Request Logs</h2>
        <div className="row">
          <select onChange={async (e) => {
            const name = e.target.value;
            if (name) { const r = await api.logsByAccount(name); setLogs(r.logs); }
            else load();
          }} style={{width: 'auto', marginBottom: 0}}>
            <option value="">All accounts</option>
            {logs.map(l => l.account).filter((v,i,a) => a.indexOf(v) === i).map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <button className="small" onClick={async () => {
            const csv = await api.exportLogs();
            const blob = new Blob([csv], {type: 'text/csv'});
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'logs.csv'; a.click();
          }}>Export CSV</button>
          <button className="small danger" onClick={async () => { await api.clearLogs(); load(); }}>Clear</button>
        </div>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Model</th><th>Account</th><th>Location</th><th>Status</th><th>Latency</th><th>Stream</th></tr></thead>
        <tbody>
          {logs.map(l => (
            <tr key={l.id}>
              <td>{new Date(l.timestamp * 1000).toLocaleString()}</td>
              <td><code>{l.model}</code></td>
              <td>{l.account}</td>
              <td>{l.location || '—'}</td>
              <td><Badge ok={l.status < 400}>{l.status}</Badge></td>
              <td>{l.latency != null ? `${l.latency}s` : '—'}</td>
              <td>{l.stream ? 'Yes' : 'No'}</td>
            </tr>
          ))}
          {logs.length === 0 && <tr><td colSpan={7} className="muted">No requests yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Settings() {
  const [strategy, setStrategy] = useState('round_robin');
  const [key, setK] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [budget, setBudgetVal] = useState('');
  const [aliases, setAliases] = useState({});
  const [newAlias, setNewAlias] = useState('');
  const [newTargets, setNewTargets] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try { setStrategy((await api.stats()).strategy); } catch {}
    try { setK((await api.key()).api_key); } catch {}
    try { const b = await api.budget(); setBudgetVal(b.budget_usd ? String(b.budget_usd) : ''); } catch {}
    try { setAliases((await api.aliases()).aliases); } catch {}
  }, []);
  useEffect(() => { setBaseUrl(window.location.origin); load(); }, [load]);

  const saveStrategy = async () => { try { await api.strategy(strategy); setMsg('Strategy saved ✓'); } catch (e) { setMsg(e.message); } };
  const saveBudget = async () => { try { await api.setBudget(budget); setMsg('Budget saved ✓'); } catch (e) { setMsg(e.message); } };
  const addAlias = async () => { try { await api.addAlias(newAlias, newTargets.split(',').map(s => s.trim())); setNewAlias(''); setNewTargets(''); load(); setMsg('Alias added ✓'); } catch (e) { setMsg(e.message); } };

  return (
    <div>
      <h2>Routing Strategy</h2>
      <select value={strategy} onChange={e => setStrategy(e.target.value)}>
        <option value="round_robin">Round Robin</option>
        <option value="failover">Failover</option>
        <option value="weighted">Weighted</option>
        <option value="random">Random</option>
      </select>
      <button onClick={saveStrategy}>Save</button>

      <h2>Budget Limit</h2>
      <input type="number" placeholder="Max spend in USD" value={budget} onChange={e => setBudgetVal(e.target.value)} />
      <button onClick={saveBudget}>Save</button>

      <h2>Model Aliases</h2>
      <div className="form">
        <input placeholder="Alias name (e.g. smart)" value={newAlias} onChange={e => setNewAlias(e.target.value)} />
        <input placeholder="Targets (comma-separated)" value={newTargets} onChange={e => setNewTargets(e.target.value)} />
        <button onClick={addAlias}>Add Alias</button>
      </div>
      {Object.entries(aliases).map(([alias, targets]) => (
        <div key={alias} className="card" style={{marginBottom: 8}}>
          <h3 style={{fontSize: 14}}>{alias}</h3>
          <p>{targets.join(', ')}</p>
        </div>
      ))}

      <h2>Proxy Endpoint</h2>
      <p className="muted">Use this base URL + API key in your apps:</p>
      <pre>{`Base URL: ${baseUrl.replace(/:\d+$/, '')}:8000/v1\nAPI Key:  ${key}`}</pre>

      <h2>Account</h2>
      <button className="ghost" onClick={() => { localStorage.removeItem('proxy_key'); location.reload(); }}>Disconnect</button>

      {msg && <p className="ok-msg">{msg}</p>}
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getKey());
  const [tab, setTab] = useState('Dashboard');
  if (!authed) return <KeyGate onDone={() => setAuthed(true)} />;
  return (
    <div className="app">
      <aside>
        <h1>AI Proxy</h1>
        {TABS.map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </aside>
      <main>
        {tab === 'Dashboard' && <Dashboard />}
        {tab === 'Providers' && <Providers />}
        {tab === 'Playground' && <Playground />}
        {tab === 'Logs' && <Logs />}
        {tab === 'Settings' && <Settings />}
      </main>
    </div>
  );
}
