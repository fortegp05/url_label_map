'use strict';

// Google Cloud で作成した OAuth クライアントID(公開してよい値)。空のときはローカル試用モードで動く。
const GOOGLE_CLIENT_ID = '521983241176-9hhi3ukhpma4le767rtehh4hgojmf5eq.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'url_label_map.json';
const LOCAL_KEY = 'url_label_map_local_trial';
const LIMIT = { url: 2000, label: 50, labelsPerUrl: 10, title: 200 };
const FONT = 'Consolas, "BIZ UDGothic", "Yu Gothic", Meiryo, monospace';
const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  data: { version: 1, urls: [] },
  userName: 'あなた',
  expanded: new Set(),
  query: '',
  token: null,
  tokenExpiresAt: 0,
  fileId: null,
  dirty: false,
  local: !GOOGLE_CLIENT_ID,
};

const $ = (id) => document.getElementById(id);
const svg = $('map');

class AuthError extends Error {}

// ---------- 表示ユーティリティ ----------

// 通知(画面中央上)。「…」で終わる読み込み中の表示は、次の表示で置き換わるまで残す。
let noticeTimer = null;
function setStatus(msg, isError = false) {
  const s = $('status');
  clearTimeout(noticeTimer);
  s.textContent = msg;
  s.hidden = !msg;
  s.className = 'notice' + (isError ? ' error' : '');
  if (msg && !/…$/.test(msg)) noticeTimer = setTimeout(() => setStatus(''), isError ? 9000 : 4500);
}

function svgEl(name, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function textWidth(s, size = 13) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? size : size * 0.55;
  return w;
}

// ---------- データ ----------

function parseHttpUrl(s) {
  try {
    const u = new URL(String(s).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.href.length > LIMIT.url) return null;
    return u.href;
  } catch {
    return null;
  }
}

function parseLabels(s) {
  const out = [];
  for (const raw of String(s).split(/[,、，\s]+/)) {
    const l = raw.trim().slice(0, LIMIT.label);
    if (l && !out.includes(l)) out.push(l);
  }
  return out.slice(0, LIMIT.labelsPerUrl);
}

function normalize(raw) {
  const urls = [];
  const seen = new Set();
  for (const e of (raw && Array.isArray(raw.urls)) ? raw.urls : []) {
    const url = parseHttpUrl(e && e.url);
    if (!url || seen.has(url)) continue;
    const labels = Array.isArray(e.labels)
      ? [...new Set(e.labels.filter((l) => typeof l === 'string').map((l) => l.trim().slice(0, LIMIT.label)).filter(Boolean))].slice(0, LIMIT.labelsPerUrl)
      : [];
    if (!labels.length) continue;
    seen.add(url);
    urls.push({ url, title: typeof e.title === 'string' ? e.title.slice(0, LIMIT.title) : '', labels });
  }
  return { version: 1, urls };
}

// ---------- 保存先(Google Drive appDataFolder / ローカル試用) ----------

async function drive(url, init = {}) {
  if (!state.token || Date.now() > state.tokenExpiresAt) throw new AuthError();
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + state.token } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error('Google Driveとの通信に失敗しました (' + res.status + ')');
  return res;
}

const store = {
  async load() {
    if (state.local) {
      try { return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY))); } catch { return normalize(null); }
    }
    const q = encodeURIComponent(`name='${FILE_NAME}'`);
    const list = await (await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json();
    if (!list.files.length) return normalize(null);
    state.fileId = list.files[0].id;
    const res = await drive(`https://www.googleapis.com/drive/v3/files/${state.fileId}?alt=media`);
    return normalize(await res.json());
  },

  async save(data) {
    if (state.local) { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); return; }
    const body = JSON.stringify(data);
    if (state.fileId) {
      await drive(`https://www.googleapis.com/upload/drive/v3/files/${state.fileId}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
      });
      return;
    }
    const b = 'b' + Math.random().toString(36).slice(2);
    const multipart =
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })}\r\n` +
      `--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    const res = await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: multipart,
    });
    state.fileId = (await res.json()).id;
  },

  async remove() {
    if (state.local) { localStorage.removeItem(LOCAL_KEY); return; }
    if (state.fileId) {
      await drive(`https://www.googleapis.com/drive/v3/files/${state.fileId}`, { method: 'DELETE' });
      state.fileId = null;
    }
  },
};

// 保存は直列化する(新規作成と更新が競合しないように)
let saveChain = Promise.resolve();
function persist() {
  state.dirty = true;
  saveChain = saveChain.then(async () => {
    if (!state.dirty) return;
    try {
      const snapshot = JSON.stringify(state.data);
      await store.save(JSON.parse(snapshot));
      if (JSON.stringify(state.data) === snapshot) state.dirty = false;
      $('reauth').hidden = true;
    } catch (e) {
      if (e instanceof AuthError) $('reauth').hidden = false;
      else setStatus(e.message, true);
    }
  });
  return saveChain;
}

// ---------- ログイン ----------

let tokenClient = null;
let authPending = null;

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    if (!window.google || !google.accounts) {
      reject(new Error('Googleのログイン機能を読み込めませんでした。ネットワークを確認してください。'));
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: (r) => {
          const p = authPending; authPending = null;
          if (!p) return;
          if (r.error || !r.access_token) p.reject(new Error('ログインに失敗しました'));
          else if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) p.reject(new Error('Google Driveのアプリ専用領域へのアクセスが許可されませんでした'));
          else {
            state.token = r.access_token;
            state.tokenExpiresAt = Date.now() + (Number(r.expires_in) - 60) * 1000;
            saveSession();
            p.resolve();
          }
        },
        error_callback: (e) => {
          const p = authPending; authPending = null;
          if (p) p.reject(new Error('ログインが中断されました' + (e && e.type ? ` (${e.type})` : '')));
        },
      });
    }
    authPending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt });
  });
}

// リロード後の復帰用。トークン(約1時間で失効)はそのタブのsessionStorageにだけ置き、ログイン済みの印(秘密情報ではない)だけlocalStorageに置く。
const SESSION_KEY = 'url_label_map_session';
const SIGNED_IN_KEY = 'url_label_map_signed_in';

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, expiresAt: state.tokenExpiresAt }));
    localStorage.setItem(SIGNED_IN_KEY, '1');
  } catch { /* 保存できなくても動作は続ける */ }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SIGNED_IN_KEY);
  } catch { /* 無視 */ }
}

function restoreSession() {
  try {
    const j = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (j && j.token && Date.now() < j.expiresAt) {
      state.token = j.token;
      state.tokenExpiresAt = j.expiresAt;
      return true;
    }
  } catch { /* 無視 */ }
  return false;
}

function wasSignedIn() {
  try { return localStorage.getItem(SIGNED_IN_KEY) === '1'; } catch { return false; }
}

function whenGoogleReady() {
  return new Promise((resolve) => {
    if (window.google && google.accounts) { resolve(true); return; }
    const el = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (!el) { resolve(false); return; }
    el.addEventListener('load', () => resolve(true));
    el.addEventListener('error', () => resolve(false));
  });
}

async function fetchUserName() {
  try {
    const j = await (await drive('https://www.googleapis.com/drive/v3/about?fields=user(displayName)')).json();
    if (j.user && j.user.displayName) return j.user.displayName;
  } catch { /* 取れなければ既定名のまま */ }
  return 'あなた';
}

async function start() {
  setStatus('データを読み込み中…');
  try {
    if (state.local) state.userName = 'ローカル試用';
    else state.userName = await fetchUserName();
    state.data = await store.load();
    $('loginPanel').hidden = true;
    $('app').hidden = false;
    setStatus('');
    renderAll(true);
  } catch (e) {
    setStatus(e.message, true);
  }
}

$('loginBtn').addEventListener('click', async () => {
  try { await requestToken(''); await start(); } catch (e) { setStatus(e.message, true); }
});

$('reauthBtn').addEventListener('click', async () => {
  try { await requestToken(''); await persist(); } catch (e) { setStatus(e.message, true); }
});

async function logout() {
  if (!state.local && state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
  clearSession();
  Object.assign(state, { token: null, tokenExpiresAt: 0, fileId: null, dirty: false, data: { version: 1, urls: [] }, expanded: new Set(), query: '' });
  closeAll();
  $('app').hidden = true;
  $('reauth').hidden = true;
  if (state.local) await start(); else $('loginPanel').hidden = false;
  setStatus(state.local ? '' : 'ログアウトしました');
}

async function deleteAll() {
  try {
    await saveChain;
    await store.remove();
    state.data = { version: 1, urls: [] };
    state.dirty = false;
    state.expanded.clear();
    renderAll(true);
    setStatus('すべてのデータを削除しました');
  } catch (e) {
    if (e instanceof AuthError) $('reauth').hidden = false;
    else setStatus(e.message, true);
  }
}

// ---------- タイトル取得(ブラウザから直接fetch。失敗したらURL表示のまま) ----------

async function fetchTitle(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return '';
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const t = doc.querySelector('title');
    return t ? t.textContent.replace(/\s+/g, ' ').trim().slice(0, LIMIT.title) : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 登録 ----------

$('addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = parseHttpUrl($('urlInput').value);
  const labels = parseLabels($('labelInput').value);
  if (!url) { setStatus('URLは http:// または https:// で始まる形式で入力してください', true); return; }
  if (!labels.length) { setStatus('ラベルを1つ以上入力してください', true); return; }

  let entry = state.data.urls.find((e) => e.url === url);
  if (entry) {
    entry.labels = [...new Set([...entry.labels, ...labels])].slice(0, LIMIT.labelsPerUrl);
  } else {
    entry = { url, title: '', labels };
    state.data.urls.push(entry);
  }
  $('urlInput').value = '';
  $('labelInput').value = '';
  setStatus('登録しました');
  renderAll(false);
  persist();

  if (!entry.title) {
    const title = await fetchTitle(url);
    if (title && state.data.urls.includes(entry)) {
      entry.title = title;
      renderAll(false);
      persist();
    }
  }
});

function deleteUrl(entry) {
  state.data.urls = state.data.urls.filter((e) => e !== entry);
  renderAll(false);
  persist();
}

// ---------- マインドマップのレイアウト ----------

function userRadius() {
  return Math.min(80, Math.max(40, textWidth(truncate(state.userName, 10), 15) / 2 + 16));
}

function layout(data, expanded) {
  const byLabel = new Map();
  for (const e of data.urls) {
    for (const l of e.labels) {
      if (!byLabel.has(l)) byLabel.set(l, []);
      byLabel.get(l).push(e);
    }
  }
  const names = [...byLabel.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  const n = names.length;
  const R = Math.max(190, (n * 150) / (2 * Math.PI));
  const labels = new Map();
  names.forEach((name, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    labels.set(name, { name, count: byLabel.get(name).length, angle: a, x: R * Math.cos(a), y: R * Math.sin(a) });
  });

  const placed = new Set();
  const urls = [];
  const span = Math.min((2 * Math.PI) / Math.max(n, 1), Math.PI / 2) * 0.9;
  for (const name of names) {
    if (!expanded.has(name)) continue;
    const mine = byLabel.get(name).filter((e) => !placed.has(e));
    mine.forEach((e) => placed.add(e));
    const k = mine.length;
    if (!k) continue;
    const base = labels.get(name).angle;
    const r = Math.max(R + 210, (28 * k) / span);
    mine.forEach((e, j) => {
      const a = k === 1 ? base : base + (j - (k - 1) / 2) * (span / k);
      urls.push({ entry: e, angle: a, x: r * Math.cos(a), y: r * Math.sin(a) });
    });
  }

  const ur = userRadius() + 18;
  let minX = -ur, maxX = ur, minY = -ur, maxY = ur;
  const grow = (x0, x1, y0, y1) => {
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
  };
  for (const l of labels.values()) {
    const w = textWidth(`${l.name} (${l.count})`, 16) + 12;
    grow(Math.min(l.x - w / 2, l.x - 30), Math.max(l.x + w / 2, l.x + 30), l.y - 32, l.y + 58);
  }
  for (const u of urls) {
    const w = textWidth(urlText(u.entry), 15) + 24;
    const right = Math.cos(u.angle) >= 0;
    grow(right ? u.x - 12 : u.x - w, right ? u.x + w : u.x + 12, u.y - 14, u.y + 14);
  }
  return { labels, urls, ur: userRadius(), bounds: { minX: minX - 30, minY: minY - 30, maxX: maxX + 30, maxY: maxY + 30 } };
}

function urlText(entry) {
  return truncate(entry.title || entry.url, 34);
}

// ---------- 描画 ----------

const drag = { moved: false };

// 同心円のリング(外側の細い輪、本体、展開中は破線の外輪、中心の点)
function ringNode(parent, x, y, r, color, { open = false, hit = false, spin = true } = {}) {
  parent.appendChild(svgEl('circle', { cx: x, cy: y, r: r + 7, fill: 'none', stroke: color, 'stroke-width': 1, 'stroke-opacity': 0.55 }));
  parent.appendChild(svgEl('circle', { cx: x, cy: y, r, fill: 'rgba(8,24,72,0.88)', stroke: color, 'stroke-width': open || hit ? 4 : 2.5 }));
  if (open) {
    const dash = svgEl('circle', { cx: x, cy: y, r: r + 13, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '18 10', 'stroke-opacity': 0.85 });
    if (spin) dash.setAttribute('class', 'spin');
    parent.appendChild(dash);
  }
  parent.appendChild(svgEl('circle', { cx: x, cy: y, r: 3.5, fill: color }));
}

function renderMap(target, expanded, { forExport = false } = {}) {
  target.replaceChildren();
  const L = layout(state.data, expanded);
  const q = state.query.trim().toLowerCase();
  const matches = (name) => q && name.toLowerCase().includes(q);
  const textStroke = { 'paint-order': 'stroke', stroke: '#0f2a64', 'stroke-width': 4 };

  if (forExport) {
    const b = L.bounds;
    const defs = svgEl('defs');
    const grad = svgEl('radialGradient', { id: 'bgGrad', cx: '50%', cy: '45%', r: '75%' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#2a62c4' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#0d2554' }));
    defs.appendChild(grad);
    target.appendChild(defs);
    target.appendChild(svgEl('rect', { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, fill: 'url(#bgGrad)' }));
  }
  const g = svgEl('g', { 'font-family': FONT, 'font-size': 16 });
  target.appendChild(g);

  // 線(ユーザー→ラベル、ラベル→URL。ラベル同士は結ばない)
  const edges = svgEl('g', { stroke: '#e4f8ff', 'stroke-opacity': 0.55, 'stroke-width': 1.2, fill: 'none' });
  g.appendChild(edges);
  for (const l of L.labels.values()) edges.appendChild(svgEl('line', { x1: 0, y1: 0, x2: l.x, y2: l.y }));
  for (const u of L.urls) {
    for (const name of u.entry.labels) {
      const l = L.labels.get(name);
      if (l) edges.appendChild(svgEl('line', { x1: l.x, y1: l.y, x2: u.x, y2: u.y }));
    }
  }

  // ユーザー(中心の三重リング)
  const ur = L.ur;
  const user = svgEl('g');
  user.appendChild(svgEl('circle', { cx: 0, cy: 0, r: ur + 18, fill: 'none', stroke: '#e4f8ff', 'stroke-width': 1, 'stroke-opacity': 0.5 }));
  const arc = svgEl('circle', { cx: 0, cy: 0, r: ur + 10, fill: 'none', stroke: '#8aeaff', 'stroke-width': 6, 'stroke-dasharray': `${(ur + 10) * 1.6} ${(ur + 10) * 0.35}`, 'stroke-opacity': 0.9 });
  if (!forExport) arc.setAttribute('class', 'spin');
  user.appendChild(arc);
  user.appendChild(svgEl('circle', { cx: 0, cy: 0, r: ur, fill: 'rgba(8,24,72,0.92)', stroke: '#e4f8ff', 'stroke-width': 2.5 }));
  user.appendChild(svgEl('text', { x: 0, y: 5, 'text-anchor': 'middle', fill: '#eaf6ff', 'font-size': 15, 'font-weight': 'bold' }, truncate(state.userName, 10)));
  g.appendChild(user);

  // ラベル
  for (const l of L.labels.values()) {
    const open = expanded.has(l.name);
    const hit = matches(l.name);
    const color = hit ? '#ff6b86' : '#e4f8ff';
    const node = svgEl('g', { opacity: q && !hit ? 0.35 : 1 });
    ringNode(node, l.x, l.y, 15, color, { open, hit, spin: !forExport });
    node.appendChild(svgEl('text', { x: l.x, y: l.y + 46, 'text-anchor': 'middle', fill: hit ? '#ffa3b4' : '#eaf6ff', ...textStroke }, `${l.name} (${l.count})`));
    if (!forExport) {
      node.setAttribute('class', 'node');
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', `ラベル ${l.name}${open ? '(展開中)' : ''}`);
      const toggle = () => {
        if (drag.moved) return;
        if (state.expanded.has(l.name)) state.expanded.delete(l.name); else state.expanded.add(l.name);
        renderAll(false);
      };
      node.addEventListener('click', toggle);
      node.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
    }
    g.appendChild(node);
  }

  // URL(文字だけ。下線なし)
  for (const u of L.urls) {
    const right = Math.cos(u.angle) >= 0;
    const dim = q && !u.entry.labels.some(matches);
    const a = svgEl('a', { href: u.entry.url, target: '_blank', rel: 'noopener noreferrer', opacity: dim ? 0.35 : 1 });
    a.appendChild(svgEl('title', {}, `${u.entry.title ? u.entry.title + '\n' : ''}${u.entry.url}`));
    a.appendChild(svgEl('circle', { cx: u.x, cy: u.y, r: 9, fill: 'none', stroke: '#8aeaff', 'stroke-width': 1, 'stroke-opacity': 0.6 }));
    a.appendChild(svgEl('circle', { cx: u.x, cy: u.y, r: 4.5, fill: '#8aeaff' }));
    a.appendChild(svgEl('text', {
      x: u.x + (right ? 15 : -15), y: u.y + 5, 'text-anchor': right ? 'start' : 'end',
      fill: '#a8f2ff', 'font-size': 15, ...textStroke,
    }, urlText(u.entry)));
    if (!forExport) a.addEventListener('click', (ev) => { if (drag.moved) ev.preventDefault(); });
    g.appendChild(a);
  }
  return L.bounds;
}

// ---------- 表示範囲(パン・ズーム) ----------
// view は「画面の中心にあるマップ上の座標(cx, cy)」と「拡大率 k(1マップ単位あたりのピクセル数)」。

let view = null;
let lastBounds = { minX: -200, minY: -200, maxX: 200, maxY: 200 };

// 背景(bg.js)が視差をつけるために使う
window.urlMapView = () => view;

function applyView() {
  const w = window.innerWidth / view.k;
  const h = window.innerHeight / view.k;
  svg.setAttribute('viewBox', `${view.cx - w / 2} ${view.cy - h / 2} ${w} ${h}`);
  window.dispatchEvent(new Event('urlmap:view'));
}

function fitView() {
  const b = lastBounds;
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  view = {
    cx: (b.minX + b.maxX) / 2,
    cy: (b.minY + b.maxY) / 2,
    k: Math.min(1.5, Math.max(0.15, Math.min(window.innerWidth / bw, window.innerHeight / bh) * 0.92)),
  };
  applyView();
}

// 画面上の点(sx, sy)を動かさずに拡大縮小する
function zoomAt(sx, sy, f) {
  if (!view) return;
  const k = Math.min(4, Math.max(0.08, view.k * f));
  const dx = sx - window.innerWidth / 2;
  const dy = sy - window.innerHeight / 2;
  view = { cx: view.cx + dx / view.k - dx / k, cy: view.cy + dy / view.k - dy / k, k };
  applyView();
}

function labelNames() {
  const set = new Set();
  state.data.urls.forEach((e) => e.labels.forEach((l) => set.add(l)));
  return [...set];
}

function renderAll(refit) {
  lastBounds = renderMap(svg, state.expanded);
  if (refit || !view) fitView();
  $('emptyMsg').hidden = state.data.urls.length > 0;
  $('stat').textContent = `NODES ${state.data.urls.length} / LABELS ${labelNames().length}`;
  if (activeKey === 'list') renderList();
  if (activeKey === 'add') renderSugg();
  if (menu.classList.contains('open')) { placePanel(); drawLinks(); }
  updateSearchStatus();
}

function updateSearchStatus() {
  const q = state.query.trim().toLowerCase();
  if (!q) return;
  const hits = labelNames().filter((l) => l.toLowerCase().includes(q)).length;
  setStatus(hits ? `${hits}件のラベルがヒットしました` : '一致するラベルはありません');
}

const ptrs = new Map();
let lastDist = 0;
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.0015));
}, { passive: false });
svg.addEventListener('pointerdown', (ev) => {
  ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  drag.moved = false;
  lastDist = 0;
  svg.classList.add('drag');
});
window.addEventListener('pointermove', (ev) => {
  const p = ptrs.get(ev.pointerId);
  if (!p || !view) return;
  if (ptrs.size === 2) {
    ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (lastDist) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / lastDist);
    lastDist = d;
    drag.moved = true;
    return;
  }
  const dx = ev.clientX - p.x;
  const dy = ev.clientY - p.y;
  if (drag.moved || Math.hypot(dx, dy) > 4) {
    drag.moved = true;
    view = { ...view, cx: view.cx - dx / view.k, cy: view.cy - dy / view.k };
    applyView();
    ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  }
});
function endPointer(ev) {
  ptrs.delete(ev.pointerId);
  lastDist = 0;
  if (!ptrs.size) {
    svg.classList.remove('drag');
    setTimeout(() => { drag.moved = false; }, 0);
  }
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
window.addEventListener('resize', () => {
  if (view) applyView();
  if (menu.classList.contains('open')) { layoutSub(); placePanel(); drawLinks(); }
});

// ---------- 呼び出し式のメニュー(スマホ=右下固定 / PC=画面端にカーソルを寄せると画面外から入ってくる) ----------

const menu = $('menu');
const panel = $('panel');
const dim = $('dim');
if (window.visualViewport) {
  const onVV = () => { if (menu.classList.contains('open')) placePanel(); };
  window.visualViewport.addEventListener('resize', onVV);
  window.visualViewport.addEventListener('scroll', onVV);
}
panel.addEventListener('focusin', () => { placePanel(); });
panel.addEventListener('focusout', () => { setTimeout(placePanel, 50); });
const linksSvg = $('links');
const subBox = $('sub');
const desktop = !!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches);
const KIDS = ['add', 'search', 'list', 'data', 'fit'];
const FANS = {
  corner: [180, 202.5, 225, 247.5, 270],
  bottom: [190, 230, 270, 310, 350],
  top: [10, 50, 90, 130, 170],
  left: [-80, -40, 0, 40, 80],
  right: [100, 140, 180, 220, 260],
};
const HIDE = { corner: [0, 90], bottom: [0, 90], top: [0, -90], left: [-90, 0], right: [90, 0] };
const TITLES = { add: '登録', list: '一覧' };

let activeKey = null;
let anchor = { edge: 'corner', x: 0, y: 0 };
let offs = [];
let subPos = [];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rad = (d) => (d * Math.PI) / 180;

function menuCenter() {
  return anchor.edge === 'corner' ? { x: menu.offsetLeft + 28, y: menu.offsetTop + 28 } : { x: anchor.x, y: anchor.y };
}

function placeMenu(a) {
  anchor = a;
  menu.classList.toggle('corner', a.edge === 'corner');
  if (a.edge === 'corner') { menu.style.left = ''; menu.style.top = ''; } else { menu.style.left = a.x + 'px'; menu.style.top = a.y + 'px'; }
  menu.style.setProperty('--ox', HIDE[a.edge][0] + 'px');
  menu.style.setProperty('--oy', HIDE[a.edge][1] + 'px');
  const r = a.edge === 'corner' ? 96 : 100;
  const angs = FANS[a.edge];
  offs = [];
  menu.querySelectorAll('.mbtn').forEach((b, i) => {
    const x = r * Math.cos(rad(angs[i]));
    const y = r * Math.sin(rad(angs[i]));
    offs.push({ x, y });
    b.style.setProperty('--tx', x.toFixed(1) + 'px');
    b.style.setProperty('--ty', y.toFixed(1) + 'px');
  });
}

// スマホでソフトキーボードが出ている間は、見えている領域(visualViewport)の上端寄せに収める(#38)
// フォーカスが外れた直後もキーボードが閉じ切るまでは、位置を保つ(閉じ切る前に戻すとパネルが切れる)
let kbFit = false;
let baseVVH = 0;
function fitPanelToKeyboard() {
  const vv = window.visualViewport;
  if (!vv || panel.hidden || !window.matchMedia('(pointer: coarse)').matches) return;
  const inPanel = panel.contains(document.activeElement);
  // キーボードが出ているか(見えている高さが、キーボードなしの高さより大きく縮んでいるか)で判断する。
  // キーボードを閉じてもフォーカスは入力欄に残るため、フォーカスの有無では判断しない
  if (!kbFit) baseVVH = inPanel ? Math.max(baseVVH, vv.height) : vv.height;
  if (!(inPanel || kbFit) || vv.height >= baseVVH - 80) { kbFit = false; return; }
  kbFit = true;
  panel.style.top = Math.round(vv.offsetTop + 8) + 'px';
  panel.style.bottom = 'auto';
  panel.style.maxHeight = Math.max(120, Math.round(vv.height - 16)) + 'px';
}

function placePanel() {
  placePanelBase();
  fitPanelToKeyboard();
}

function placePanelBase() {
  panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = panel.style.maxHeight = '';
  if (anchor.edge === 'corner' || panel.hidden) return;
  panel.style.maxHeight = (window.innerHeight - 90) + 'px';
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const o = 134;
  let x;
  let y;
  if (anchor.edge === 'bottom') { x = anchor.x - w / 2; y = anchor.y - o - h; }
  else if (anchor.edge === 'top') { x = anchor.x - w / 2; y = anchor.y + o; }
  else if (anchor.edge === 'left') { x = anchor.x + o; y = anchor.y - h / 2; }
  else { x = anchor.x - o - w; y = anchor.y - h / 2; }
  panel.style.left = clamp(x, 16, Math.max(16, window.innerWidth - w - 16)) + 'px';
  panel.style.top = clamp(y, 56, Math.max(56, window.innerHeight - h - 16)) + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

// MENU→子→(パネル/子メニュー)を、マップと同じ見た目の線でつなぐ
function drawLinks() {
  linksSvg.replaceChildren();
  if (!menu.classList.contains('open')) { linksSvg.classList.remove('on'); return; }
  const M = menuCenter();
  offs.forEach((o, i) => {
    linksSvg.appendChild(svgEl('line', { x1: M.x, y1: M.y, x2: M.x + o.x, y2: M.y + o.y, 'stroke-opacity': KIDS[i] === activeKey ? 0.9 : 0.5 }));
  });
  const i = KIDS.indexOf(activeKey);
  if (i >= 0) {
    const P = { x: M.x + offs[i].x, y: M.y + offs[i].y };
    if (!panel.hidden) {
      const r = panel.getBoundingClientRect();
      const nx = clamp(P.x, r.left, r.right);
      const ny = clamp(P.y, r.top, r.bottom);
      linksSvg.appendChild(svgEl('line', { x1: P.x, y1: P.y, x2: nx, y2: ny, 'stroke-opacity': 0.9 }));
      linksSvg.appendChild(svgEl('circle', { cx: nx, cy: ny, r: 3, fill: '#e4f8ff' }));
    }
    for (const s of subPos) linksSvg.appendChild(svgEl('line', { x1: P.x, y1: P.y, x2: s.x, y2: s.y, 'stroke-opacity': 0.9 }));
  }
  linksSvg.classList.add('on');
}

// ----- 子メニュー(保存・全体=円ボタンの円弧、検索=入力欄) -----

function subItems(key) {
  if (key === 'data') {
    return [
      { text: 'JSON\n保存', act: 'json' },
      { text: '画像\nPNG', act: 'png' },
      { text: 'ログ\nアウト', act: 'logout', confirmText: 'もう一度\n押す', needConfirm: () => state.dirty },
      { text: '全データ\n削除', act: 'wipe', danger: true, confirmText: '本当に\n削除', needConfirm: () => true },
    ];
  }
  if (key === 'fit') {
    return [
      { text: '全体\n表示', act: 'fit' },
      { text: 'すべて\n開く', act: 'openAll' },
      { text: 'すべて\n閉じる', act: 'closeAll' },
    ];
  }
  if (key === 'search') return [{ field: true }];
  return null;
}

async function runAction(act) {
  if (act === 'json') exportJson();
  else if (act === 'png') await exportPng();
  else if (act === 'logout') await logout();
  else if (act === 'wipe') { await deleteAll(); setMenu(false); }
  else if (act === 'fit') fitView();
  else if (act === 'openAll') { state.data.urls.forEach((e) => e.labels.forEach((l) => state.expanded.add(l))); renderAll(true); }
  else if (act === 'closeAll') { state.expanded.clear(); renderAll(true); }
}

function makePill(s) {
  if (s.field) {
    const n = document.createElement('label');
    n.className = 'pill field';
    n.style.width = Math.min(240, window.innerWidth - 32) + 'px';
    const mark = document.createElement('i');
    mark.textContent = '>';
    const inp = document.createElement('input');
    inp.type = 'search';
    inp.placeholder = 'ラベルを検索';
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', 'ラベル検索');
    inp.value = state.query;
    inp.addEventListener('input', (ev) => {
      state.query = ev.target.value;
      if (!state.query.trim()) setStatus('');
      renderAll(false);
    });
    n.append(mark, inp);
    return n;
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pill round' + (s.danger ? ' danger' : '');
  b.textContent = s.text;
  b.setAttribute('aria-label', s.text.replace('\n', ''));
  let armed = false;
  let timer = null;
  b.addEventListener('click', () => {
    if (s.needConfirm && s.needConfirm() && !armed) {
      armed = true;
      b.textContent = s.confirmText;
      b.classList.add('armed');
      timer = setTimeout(() => { armed = false; b.textContent = s.text; b.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    b.textContent = s.text;
    b.classList.remove('armed');
    runAction(s.act);
  });
  return b;
}

// 子ボタンの周りに、MENUと反対向きの円弧で並べる。画面からはみ出すときは扇の向きを少しずらす
function layoutSub() {
  subPos = [];
  const items = [...subBox.children];
  const i = KIDS.indexOf(activeKey);
  if (i < 0 || !items.length) return;
  const M = menuCenter();
  const P = { x: M.x + offs[i].x, y: M.y + offs[i].y };
  const base = Math.atan2(offs[i].y, offs[i].x);
  const n = items.length;
  const step = n > 1 ? rad(40) : 0;
  const R = 100;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const pts = (b) => items.map((it, j) => {
    const w = it.offsetWidth;
    const h = it.offsetHeight;
    const a = b + (j - (n - 1) / 2) * step;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const d = n > 1 ? R : 40 + (w / 2) * Math.abs(dx) + (h / 2) * Math.abs(dy);
    return { x: P.x + dx * d, y: P.y + dy * d, w, h };
  });
  const inside = (p) => p.x >= p.w / 2 + 8 && p.x <= W - p.w / 2 - 8 && p.y >= p.h / 2 + 8 && p.y <= H - p.h / 2 - 8;
  let best = null;
  for (const t of [0, 10, -10, 20, -20, 30, -30, 45, -45, 60, -60, 80, -80]) {
    const c = pts(base + rad(t));
    if (c.every(inside)) { best = c; break; }
  }
  best = best || pts(base);
  best.forEach((p, j) => {
    const cx = clamp(p.x, p.w / 2 + 8, W - p.w / 2 - 8);
    const cy = clamp(p.y, p.h / 2 + 8, H - p.h / 2 - 8);
    items[j].style.left = (cx - p.w / 2) + 'px';
    items[j].style.top = (cy - p.h / 2) + 'px';
    subPos.push({ x: cx, y: cy });
  });
}

function renderSub(key) {
  subBox.replaceChildren();
  subPos = [];
  const list = subItems(key);
  if (!list) return;
  list.forEach((s) => subBox.appendChild(makePill(s)));
  layoutSub();
  requestAnimationFrame(() => [...subBox.children].forEach((n, j) => setTimeout(() => n.classList.add('in'), j * 50)));
  const f = subBox.querySelector('input');
  if (f) setTimeout(() => f.focus(), 80);
}

// ----- パネル(登録・一覧) -----

function showPanel(name) {
  panel.hidden = !name;
  $('addForm').hidden = name !== 'add';
  $('listBox').hidden = name !== 'list';
  if (!name) return;
  $('ptitle').textContent = TITLES[name];
  if (name === 'list') renderList();
  if (name === 'add') { renderSugg(); setTimeout(() => $('urlInput').focus(), 0); }
  placePanel();
}

function setActive(key) {
  activeKey = activeKey === key ? null : key;
  showPanel(activeKey === 'add' || activeKey === 'list' ? activeKey : null);
  renderSub(activeKey);
  menu.querySelectorAll('.mbtn').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === activeKey));
  drawLinks();
}

function setMenu(open) {
  menu.classList.toggle('open', open);
  dim.classList.toggle('on', open);
  $('hud').classList.toggle('on', open);
  $('mainBtn').setAttribute('aria-expanded', open);
  $('mainBtn').textContent = open ? 'CLOSE' : 'MENU';
  if (open) {
    requestAnimationFrame(drawLinks);
  } else {
    activeKey = null;
    showPanel(null);
    renderSub(null);
    menu.querySelectorAll('.mbtn').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    drawLinks();
    if (desktop) menu.classList.remove('show');
  }
}

function closeAll() { setMenu(false); }

$('mainBtn').addEventListener('click', () => setMenu(!menu.classList.contains('open')));
$('pclose').addEventListener('click', () => setActive(activeKey));
menu.querySelectorAll('.mbtn').forEach((b) => b.addEventListener('click', () => setActive(b.dataset.k)));

// メニュー・子メニュー・パネル以外を押したら閉じる(マップ操作はそのまま続けられる)
window.addEventListener('pointerdown', (ev) => {
  if (menu.classList.contains('open') && !menu.contains(ev.target) && !panel.contains(ev.target) && !subBox.contains(ev.target)) setMenu(false);
}, true);

function showMenuAt(a) {
  menu.style.transition = 'none';
  placeMenu(a);
  void menu.offsetWidth;
  menu.style.transition = '';
  menu.classList.add('show');
}

window.addEventListener('keydown', (ev) => {
  if ($('app').hidden) return;
  if (ev.key === 'Escape') { if (activeKey) setActive(activeKey); else setMenu(false); return; }
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  if (!typing && (ev.key === '/' || ev.key === 'm')) {
    ev.preventDefault();
    if (!menu.classList.contains('show')) showMenuAt({ edge: 'corner', x: 0, y: 0 });
    if (!menu.classList.contains('open')) setMenu(true);
    if (ev.key === '/' && activeKey !== 'search') setActive('search');
  }
});

// PC: 画面端への接近を検知し、その辺の外側からMENUがスライドして入ってくる
let edgeTimer = null;
let lastPointer = { x: 0, y: 0 };
window.addEventListener('pointermove', (ev) => {
  if (!desktop || $('app').hidden || ev.pointerType !== 'mouse' || ptrs.size || menu.classList.contains('open')) return;
  lastPointer = { x: ev.clientX, y: ev.clientY };
  const W = window.innerWidth;
  const H = window.innerHeight;
  const d = { left: ev.clientX, right: W - ev.clientX, top: ev.clientY, bottom: H - ev.clientY };
  let edge = 'left';
  for (const k of Object.keys(d)) if (d[k] < d[edge]) edge = k;
  if (menu.classList.contains('show')) {
    if (anchor.edge !== 'corner' && Math.hypot(ev.clientX - anchor.x, ev.clientY - anchor.y) > 140) menu.classList.remove('show');
    return;
  }
  if (d[edge] < 18) {
    if (!edgeTimer) {
      edgeTimer = setTimeout(() => {
        edgeTimer = null;
        const a = { edge };
        if (edge === 'bottom' || edge === 'top') { a.x = clamp(lastPointer.x, 150, W - 150); a.y = edge === 'bottom' ? H - 42 : 42; }
        else { a.y = clamp(lastPointer.y, 150, H - 150); a.x = edge === 'right' ? W - 42 : 42; }
        showMenuAt(a);
      }, 220);
    }
  } else if (edgeTimer) {
    clearTimeout(edgeTimer);
    edgeTimer = null;
  }
});

// ---------- ラベル入力の補助(空のときは最近登録した5つ、入力中は前方一致の候補) ----------

const labelInput = $('labelInput');
let sug = { head: '', list: [] };

function recentLabels(n) {
  const out = [];
  for (let i = state.data.urls.length - 1; i >= 0 && out.length < n; i--) {
    for (const l of state.data.urls[i].labels) if (!out.includes(l) && out.length < n) out.push(l);
  }
  return out;
}

function pickSugg(l) {
  labelInput.value = sug.head + l + ', ';
  renderSugg();
  labelInput.focus();
}

function renderSugg() {
  const v = labelInput.value;
  const m = v.match(/^([\s\S]*?)([^,、，\s]*)$/);
  const head = m[1];
  const tok = m[2];
  const done = parseLabels(head);
  const all = parseLabels(v);
  const box = $('sugg');
  const cap = $('suggCap');
  box.replaceChildren();
  sug = { head, list: [] };
  const chip = (l, on, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (on ? ' on' : '');
    b.textContent = l;
    b.addEventListener('click', fn);
    box.appendChild(b);
  };
  if (tok) {
    const q = tok.toLowerCase();
    const lab = recentLabels(Infinity).filter((l) => !done.includes(l));
    sug.list = lab.filter((l) => l.toLowerCase().startsWith(q))
      .concat(lab.filter((l) => l.toLowerCase().indexOf(q) > 0))
      .slice(0, 5);
    cap.textContent = sug.list.length ? '候補(Tabキーで先頭を選択)' : '一致するラベルはありません。新しいラベルとして登録されます。';
    sug.list.forEach((l) => chip(l, false, () => pickSugg(l)));
  } else {
    cap.textContent = recentLabels(1).length ? '最近登録したラベルから選ぶ' : '';
    recentLabels(5).forEach((l) => chip(l, all.includes(l), () => {
      labelInput.value = (all.includes(l) ? all.filter((x) => x !== l) : [...all, l]).join(', ');
      renderSugg();
    }));
  }
}

labelInput.addEventListener('input', renderSugg);
labelInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Tab' && !ev.shiftKey && sug.list.length) { ev.preventDefault(); pickSugg(sug.list[0]); }
});

// ---------- 一覧 ----------

function renderList() {
  const box = $('listBox');
  box.replaceChildren();
  if (!state.data.urls.length) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = '登録済みのURLはありません。';
    box.appendChild(p);
    return;
  }
  for (const e of state.data.urls) {
    const row = document.createElement('div');
    row.className = 'item';
    const dot = document.createElement('i');
    dot.className = 'dot';
    const info = document.createElement('div');
    info.className = 'info';
    const a = document.createElement('a');
    a.href = e.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = e.title || e.url;
    info.appendChild(a);
    if (e.title) {
      const sm = document.createElement('small');
      sm.textContent = e.url;
      info.appendChild(sm);
    }
    const chips = document.createElement('span');
    chips.className = 'chips';
    for (const l of e.labels) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = l;
      chips.appendChild(c);
    }
    info.appendChild(chips);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger mini';
    del.textContent = '削除';
    del.addEventListener('click', () => deleteUrl(e));
    row.append(dot, info, del);
    box.appendChild(row);
  }
}

// ---------- ダウンロード ----------

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function exportJson() {
  const labels = {};
  state.data.urls.forEach((e) => e.labels.forEach((l) => { (labels[l] = labels[l] || []).push({ url: e.url, title: e.title }); }));
  const out = { user: state.userName, exportedAt: new Date().toISOString(), labels, urls: state.data.urls };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `url_label_map_${stamp()}.json`);
}

async function exportPng() {
  if (!state.data.urls.length) { setStatus('登録がないため画像を作れません', true); return; }
  // マップ全体(すべてのラベルを開いた状態)を画面外のSVGに描く
  const all = new Set();
  state.data.urls.forEach((e) => e.labels.forEach((l) => all.add(l)));
  const off = svgEl('svg', { xmlns: SVG_NS });
  const b = renderMap(off, all, { forExport: true });
  const w = Math.ceil(b.maxX - b.minX);
  const h = Math.ceil(b.maxY - b.minY);
  off.setAttribute('viewBox', `${b.minX} ${b.minY} ${w} ${h}`);
  off.setAttribute('width', w);
  off.setAttribute('height', h);
  const scale = Math.min(2, 8000 / Math.max(w, h));
  try {
    const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(off));
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('画像の生成に失敗しました')); img.src = src; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d2554';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('画像の生成に失敗しました(大きすぎる可能性があります)');
    download(blob, `url_label_map_${stamp()}.png`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

// ---------- 起動 ----------

placeMenu({ edge: 'corner', x: 0, y: 0 });
if (!desktop) menu.classList.add('show');

if (state.local) {
  $('localBanner').hidden = false;
  start();
} else if (restoreSession()) {
  start();
} else if (wasSignedIn()) {
  // 画面なしの再ログインを試す。ブラウザにポップアップを止められたり同意が必要な場合は、ログインボタンを出す。
  setStatus('ログインを確認中…');
  whenGoogleReady()
    .then((ok) => (ok ? requestToken('none') : Promise.reject(new Error(''))))
    .then(() => start())
    .catch(() => { setStatus(''); $('loginPanel').hidden = false; });
} else {
  $('loginPanel').hidden = false;
}
