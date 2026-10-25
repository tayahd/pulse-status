// Pulse uptime checker. Runs every few minutes (GitHub Actions cron), probes each
// service, updates status.json, and sends a push via ntfy when something goes
// down or comes back up.
//
// Env:
//   STATE_FILE         path to status.json (default ./status.json)
//   SITE_URL           website to check (default https://pulse-finance-two.vercel.app/)
//   SUPABASE_URL       Supabase project URL (enables Auth / Database / Functions checks)
//   SUPABASE_ANON_KEY  public anon key (needed for Auth + Database checks)
//   NTFY_TOPIC         ntfy topic to push to (no topic = no pushes)
//   NTFY_SERVER        default https://ntfy.sh
//   DASHBOARD_URL      link opened when you tap a notification
//
// `node monitor.mjs --test-notify` sends a test push and exits.

import { readFile, writeFile } from 'node:fs/promises';

const env = process.env;
const STATE_FILE = env.STATE_FILE || './status.json';
const SITE_URL = env.SITE_URL || 'https://pulse-finance-two.vercel.app/';
const SB = (env.SUPABASE_URL || 'https://jbmypojwigjzzelcgsnm.supabase.co').replace(/\/$/, '');
const ANON = env.SUPABASE_ANON_KEY || '';
const NTFY_SERVER = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC = env.NTFY_TOPIC || '';
const DASHBOARD_URL = env.DASHBOARD_URL || '';

const TIMEOUT_MS = 15000;
const SLOW_MS = 4000;        // ok but slower than this = degraded
const RETRY_DELAY_MS = 15000; // confirm a failure before calling it down
const RECENT_MAX = 288;       // 24h of 5-minute checks
const DAILY_DAYS = 90;
const INCIDENTS_MAX = 100;

const sbHeaders = ANON ? { apikey: ANON, Authorization: `Bearer ${ANON}` } : {};

const SERVICES = [
  {
    id: 'web', name: 'Website', group: 'Vercel', url: SITE_URL,
    validate: (res, body) => res.ok && body.includes('id="root"') ? null : `HTTP ${res.status}${res.ok ? ' (app shell missing)' : ''}`,
  },
  {
    id: 'auth', name: 'Sign-in', group: 'Supabase Auth', url: `${SB}/auth/v1/health`, headers: sbHeaders, needsKey: true,
  },
  {
    id: 'db', name: 'Database', group: 'Supabase REST', url: `${SB}/rest/v1/accounts?select=id&limit=1`, headers: sbHeaders, needsKey: true,
  },
  {
    // A CORS preflight proves the Edge runtime is serving without invoking Plaid.
    id: 'functions', name: 'Bank sync', group: 'Supabase Edge Functions', url: `${SB}/functions/v1/plaid-create-link-token`, method: 'OPTIONS',
  },
].filter(s => !s.needsKey || ANON);

const UP = 0, DEGRADED = 1, DOWN = 2;
const LABEL = ['up', 'degraded', 'down'];

async function probe(svc) {
  const started = performance.now();
  try {
    const res = await fetch(svc.url, {
      method: svc.method || 'GET',
      headers: { 'User-Agent': 'pulse-status-monitor', ...svc.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    const body = await res.text();
    const ms = Math.round(performance.now() - started);
    const error = svc.validate ? svc.validate(res, body) : (res.ok ? null : `HTTP ${res.status}`);
    if (error) return { s: DOWN, ms, code: res.status, error };
    return { s: ms > SLOW_MS ? DEGRADED : UP, ms, code: res.status, error: null };
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    const error = e.name === 'TimeoutError' ? `Timed out after ${TIMEOUT_MS / 1000}s` : (e.cause?.code || e.message);
    return { s: DOWN, ms, code: 0, error };
  }
}

async function check(svc) {
  const first = await probe(svc);
  if (first.s !== DOWN) return first;
  await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  return probe(svc);
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function notify({ title, message, priority = 3, tags = [] }) {
  if (!NTFY_TOPIC) {
    console.log(`[no NTFY_TOPIC] would push: ${title} — ${message}`);
    return;
  }
  const res = await fetch(NTFY_SERVER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: NTFY_TOPIC, title, message, priority, tags,
      ...(DASHBOARD_URL ? { click: DASHBOARD_URL } : {}),
    }),
  });
  if (!res.ok) console.error(`ntfy push failed: HTTP ${res.status} ${await res.text()}`);
  else console.log(`pushed: ${title}`);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { services: {}, incidents: [] };
  }
}

async function main() {
  if (process.argv.includes('--test-notify')) {
    await notify({ title: 'Pulse Status test', message: 'Push notifications are working.', tags: ['bell'] });
    return;
  }

  const state = await loadState();
  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const results = await Promise.all(SERVICES.map(check));
  const alerts = [];

  SERVICES.forEach((svc, i) => {
    const r = results[i];
    const prev = state.services[svc.id] || { status: 'up', since: nowIso, recent: [], daily: {} };
    const prevDown = prev.status === 'down';
    const isDown = r.s === DOWN;
    const status = LABEL[r.s];

    if (isDown && !prevDown) {
      state.incidents.unshift({ service: svc.id, name: svc.name, start: nowIso, end: null, error: r.error });
      alerts.push({ kind: 'down', svc, r });
    } else if (!isDown && prevDown) {
      const open = state.incidents.find(x => x.service === svc.id && !x.end);
      if (open) open.end = nowIso;
      alerts.push({ kind: 'up', svc, r, downFor: now - new Date(prev.since) });
    }

    const recent = [...(prev.recent || []), [Math.floor(now / 1000), r.ms, r.s]].slice(-RECENT_MAX);
    const daily = { ...prev.daily };
    const d = daily[today] || { n: 0, up: 0, deg: 0, ms: 0 };
    d.n++; d.ms += r.ms;
    if (r.s === UP) d.up++;
    if (r.s === DEGRADED) d.deg++;
    daily[today] = d;
    const cutoff = new Date(now - DAILY_DAYS * 864e5).toISOString().slice(0, 10);
    for (const k of Object.keys(daily)) if (k < cutoff) delete daily[k];

    state.services[svc.id] = {
      name: svc.name, group: svc.group, status,
      since: prev.status === status ? prev.since : nowIso,
      lastMs: r.ms, lastCode: r.code, lastError: r.error,
      recent, daily,
    };
    console.log(`${svc.name.padEnd(10)} ${status.padEnd(9)} ${String(r.ms).padStart(5)}ms ${r.error || ''}`);
  });

  // Drop services that were removed from the list.
  for (const id of Object.keys(state.services)) if (!SERVICES.some(s => s.id === id)) delete state.services[id];
  state.incidents = state.incidents.slice(0, INCIDENTS_MAX);
  state.updatedAt = nowIso;
  state.intervalMinutes = 5;
  await writeFile(STATE_FILE, JSON.stringify(state));

  const downs = alerts.filter(a => a.kind === 'down');
  const ups = alerts.filter(a => a.kind === 'up');
  if (downs.length) {
    await notify({
      title: downs.length === 1 ? `${downs[0].svc.name} is down` : `${downs.length} Pulse services are down`,
      message: downs.map(a => `${a.svc.name}: ${a.r.error}`).join('\n'),
      priority: 5, tags: ['rotating_light'],
    });
  }
  if (ups.length) {
    await notify({
      title: ups.length === 1 ? `${ups[0].svc.name} is back up` : `${ups.length} Pulse services recovered`,
      message: ups.map(a => `${a.svc.name} recovered after ${fmtDuration(a.downFor)} (${a.r.ms}ms)`).join('\n'),
      priority: 3, tags: ['white_check_mark'],
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
