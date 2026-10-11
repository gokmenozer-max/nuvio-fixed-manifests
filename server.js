'use strict';
/**
 * Nuvio -> Stremio kopru sunucusu.
 * Nuvio scraper depolarini (manifest.json icinde "scrapers" dizisi olan) okur,
 * scraper JS dosyalarini calistirir ve Stremio addon protokolu ile sunar.
 * Her depo ayri bir addon olarak yayinlanir:  /repo/<key>/manifest.json
 * Hepsi birlikte:                             /manifest.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 7000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const SCRAPER_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS) || 15000;
const OVERALL_TIMEOUT_MS = Number(process.env.OVERALL_TIMEOUT_MS) || 25000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 8;
const DISABLED = new Set((process.env.DISABLE_SCRAPERS || '').split(',').map(s => s.trim()).filter(Boolean));
const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'repos.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- yardimcilar ----------
function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label || 'islem'} ${ms}ms zaman asimi`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}
function lenientJson(text) {
  text = text.replace(/^\uFEFF/, '');
  try { return JSON.parse(text); } catch (e) {
    return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')); // sondaki virgulleri temizle
  }
}
async function getText(url) {
  const r = await withTimeout(fetch(url, { headers: { 'User-Agent': UA } }), 20000, 'indirme');
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}
async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx], idx); }
  });
  await Promise.all(runners);
}

// ---------- depo / scraper yukleme ----------
const repoCache = new Map();
async function loadRepo(repo) {
  const c = repoCache.get(repo.key);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c;
  const manifest = lenientJson(await getText(repo.url));
  const scrapers = (manifest.scrapers || []).filter(s => s && s.id && s.filename && s.enabled !== false && !DISABLED.has(s.id) && !(repo.exclude || []).includes(s.id));
  const entry = { at: Date.now(), base: repo.url.replace(/[^/]*$/, ''), manifest, scrapers };
  repoCache.set(repo.key, entry);
  return entry;
}

function shimRequire(name) {
  const map = {
    'cheerio': 'cheerio', 'cheerio-without-node-html-parser': 'cheerio',
    'crypto-js': 'crypto-js', 'axios': 'axios'
  };
  if (name === 'node-fetch') return Object.assign(fetch, { default: fetch });
  if (/^cheerio/.test(name)) return require('cheerio'); // cheerio-without-node-native vb. varyantlar
  if (map[name]) return require(map[name]);
  return require(name); // node yerlesik modulleri (crypto, url, zlib...)
}

const moduleCache = new Map();
async function getScraperModule(repo, entry, sc) {
  const key = `${repo.key}|${sc.id}|${sc.version || ''}`;
  if (moduleCache.has(key)) return moduleCache.get(key);
  const code = await getText(new URL(sc.filename, entry.base).toString());
  const sandboxGlobal = Object.create(globalThis);
  const module = { exports: {} };
  const wrapped = code + '\n;try{if(typeof getStreams==="function"&&!module.exports.getStreams){module.exports.getStreams=getStreams;}}catch(e){}';
  const fn = new Function('module', 'exports', 'require', 'global', wrapped);
  fn(module, module.exports, shimRequire, sandboxGlobal);
  let mod = module.exports;
  if (!mod || typeof mod.getStreams !== 'function') {
    if (typeof sandboxGlobal.getStreams === 'function') mod = { getStreams: sandboxGlobal.getStreams };
    else throw new Error('getStreams export edilmemis');
  }
  moduleCache.set(key, mod);
  return mod;
}

// ---------- IMDb -> TMDB ----------
const tmdbCache = new Map();
async function imdbToTmdb(imdbId, stremioType) {
  const ck = `${imdbId}|${stremioType}`;
  if (tmdbCache.has(ck)) return tmdbCache.get(ck);
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY ayarlanmamis');
  const bearer = TMDB_API_KEY.startsWith('eyJ');
  const url = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id` + (bearer ? '' : `&api_key=${TMDB_API_KEY}`);
  const r = await withTimeout(fetch(url, { headers: bearer ? { Authorization: `Bearer ${TMDB_API_KEY}` } : {} }), 10000, 'TMDB');
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
  const j = await r.json();
  let id = null;
  if (stremioType === 'movie') id = j.movie_results && j.movie_results[0] && j.movie_results[0].id;
  else id = (j.tv_results && j.tv_results[0] && j.tv_results[0].id) ||
            (j.tv_episode_results && j.tv_episode_results[0] && j.tv_episode_results[0].show_id);
  if (!id) throw new Error(`TMDB eslesmesi yok: ${imdbId}`);
  tmdbCache.set(ck, id);
  return id;
}

// ---------- stream donusumu ----------
function toStremio(s, sc) {
  if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) return null;
  const title = [s.title || s.name, s.quality, s.size].filter(Boolean).join('\n');
  const out = { name: sc.name || sc.id, title: title || sc.name, url: s.url };
  const hints = { bingeGroup: `nuvio-${sc.id}` };
  if (s.headers && typeof s.headers === 'object' && Object.keys(s.headers).length) {
    hints.notWebReady = true;
    hints.proxyHeaders = { request: s.headers };
  }
  out.behaviorHints = hints;
  if (Array.isArray(s.subtitles)) {
    out.subtitles = s.subtitles.filter(x => x && x.url).map((x, i) => ({ id: String(x.id || i), url: x.url, lang: x.lang || x.language || 'und' }));
  }
  return out;
}

const streamCache = new Map();
async function getStreamsFor(repos, stremioType, rawId) {
  const ck = `${repos.map(r => r.key).join(',')}|${stremioType}|${rawId}`;
  const hit = streamCache.get(ck);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.streams;

  const [imdb, s, e] = decodeURIComponent(rawId).split(':');
  if (!/^tt\d+$/.test(imdb)) return [];
  const mediaType = stremioType === 'movie' ? 'movie' : 'tv';
  const tmdbId = await imdbToTmdb(imdb, stremioType === 'movie' ? 'movie' : 'series');
  const season = mediaType === 'tv' ? Number(s) || 1 : undefined;
  const episode = mediaType === 'tv' ? Number(e) || 1 : undefined;

  const jobs = [];
  for (const repo of repos) {
    let entry;
    try { entry = await loadRepo(repo); } catch (err) { log(`[${repo.key}] manifest yuklenemedi:`, err.message); continue; }
    for (const sc of entry.scrapers) {
      const types = (sc.supportedTypes || ['movie', 'tv']).map(t => (t === 'series' ? 'tv' : t));
      if (!types.includes(mediaType)) continue;
      jobs.push({ repo, entry, sc });
    }
  }

  const collected = [];
  const work = pool(jobs, CONCURRENCY, async ({ repo, entry, sc }) => {
    try {
      const mod = await getScraperModule(repo, entry, sc);
      const res = await withTimeout(Promise.resolve(mod.getStreams(String(tmdbId), mediaType, season, episode)), SCRAPER_TIMEOUT_MS, sc.id);
      for (const st of Array.isArray(res) ? res : []) {
        const m = toStremio(st, sc);
        if (m) collected.push(m);
      }
    } catch (err) {
      log(`[${repo.key}/${sc.id}] hata:`, err.message);
    }
  });
  await Promise.race([work, new Promise(r => setTimeout(r, OVERALL_TIMEOUT_MS))]);

  const seen = new Set();
  const streams = collected.filter(x => !seen.has(x.url) && seen.add(x.url));
  streamCache.set(ck, { at: Date.now(), streams: streams.slice() });
  return streams;
}

// ---------- Stremio manifest ----------
function buildManifest(repos, idSuffix, name) {
  return {
    id: `community.nuvio.bridge.${idSuffix}`,
    version: '1.0.0',
    name,
    description: `Nuvio scraper kopru addon'u: ${repos.map(r => r.name).join(', ')}`,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false }
  };
}

// ---------- HTTP ----------
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const origin = process.env.PUBLIC_URL || `${proto}://${req.headers.host}`;

    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/') {
      const rows = [{ key: null, name: 'Hepsi birlikte' }, ...REPOS].map(r => {
        const u = `${origin}${r.key ? '/repo/' + r.key : ''}/manifest.json`;
        return `<tr><td>${r.name}</td><td><code>${u}</code></td></tr>`;
      }).join('');
      return send(res, 200, `<!doctype html><meta charset=utf-8><title>Nuvio Bridge</title><body style="font-family:sans-serif;padding:20px"><h2>Nuvio Bridge</h2><p>AIOStreams &gt; Addons &gt; Custom: asagidaki manifest linklerinden birini yapistir.</p>${TMDB_API_KEY ? '' : '<p style="color:red"><b>TMDB_API_KEY ayarlanmamis!</b></p>'}<table border=1 cellpadding=6>${rows}</table>`, 'text/html; charset=utf-8');
    }

    let m;
    let repos = REPOS, suffix = 'all', title = 'Nuvio Bridge (Hepsi)', rest = p;
    if ((m = p.match(/^\/repo\/([^/]+)(\/.*)$/))) {
      const repo = REPOS.find(r => r.key === m[1]);
      if (!repo) return send(res, 404, { error: 'depo yok' });
      repos = [repo]; suffix = repo.key; title = `Nuvio: ${repo.name}`; rest = m[2];
    }
    if (rest === '/manifest.json') return send(res, 200, buildManifest(repos, suffix, title));
    if ((m = rest.match(/^\/stream\/(movie|series)\/(.+)\.json$/))) {
      try {
        const streams = await getStreamsFor(repos, m[1], m[2]);
        return send(res, 200, { streams });
      } catch (err) {
        log('stream hatasi:', err.message);
        return send(res, 200, { streams: [] });
      }
    }
    return send(res, 404, { error: 'bulunamadi' });
  } catch (err) {
    log('sunucu hatasi:', err);
    send(res, 500, { error: String(err.message || err) });
  }
});

// ---------- selftest ----------
async function selftest() {
  let ok = 0, bad = 0;
  for (const repo of REPOS) {
    let entry;
    try { entry = await loadRepo(repo); } catch (e) { console.log(`X  [${repo.key}] manifest: ${e.message}`); bad++; continue; }
    console.log(`\n[${repo.key}] ${entry.scrapers.length} scraper`);
    for (const sc of entry.scrapers) {
      try { await getScraperModule(repo, entry, sc); console.log(`  OK  ${sc.id}`); ok++; }
      catch (e) { console.log(`  X   ${sc.id}: ${e.message}`); bad++; }
    }
  }
  console.log(`\nSonuc: ${ok} yuklendi, ${bad} hatali`);
}

if (process.argv.includes('--selftest')) selftest().then(() => process.exit(0));
else server.listen(PORT, () => log(`Nuvio Bridge ${PORT} portunda. TMDB_API_KEY: ${TMDB_API_KEY ? 'var' : 'YOK'}`));
