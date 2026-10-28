'use strict';

// Google Cloud で作成した OAuth クライアントID(公開してよい値)。空のときはローカル試用モードで動く。
const GOOGLE_CLIENT_ID = '521983241176-9hhi3ukhpma4le767rtehh4hgojmf5eq.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'url_label_map.json';
const LOCAL_KEY = 'url_label_map_local_trial';
const LIMIT = { url: 2000, label: 50, labelsPerUrl: 10, title: 200 };
const FONT = 'Meiryo, "Yu Gothic", "Hiragino Sans", sans-serif';
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

function setStatus(msg, isError = false) {
  const s = $('status');
  s.textContent = msg;
  s.className = isError ? 'error' : '';
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
      ? [...new Set(e.labels.filter((l) => typeof l === 'string').map((l) => l.trim()).filter(Boolean))].slice(0, LIMIT.labelsPerUrl)
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

$('logoutBtn').addEventListener('click', async () => {
  if (state.dirty && !confirm('未保存の変更があります。ログアウトしますか?')) return;
  if (!state.local && state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
  clearSession();
  Object.assign(state, { token: null, tokenExpiresAt: 0, fileId: null, dirty: false, data: { version: 1, urls: [] }, expanded: new Set() });
  $('app').hidden = true;
  $('reauth').hidden = true;
  if (state.local) await start(); else $('loginPanel').hidden = false;
  setStatus(state.local ? '' : 'ログアウトしました');
});

$('deleteAllBtn').addEventListener('click', async () => {
  if (!confirm('登録したURLとラベルをすべて削除します(Google Drive上のデータファイルも削除されます)。元に戻せません。よろしいですか?')) return;
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
});

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
  const R = Math.max(180, (n * 130) / (2 * Math.PI));
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
    const r = Math.max(R + 200, (26 * k) / span);
    mine.forEach((e, j) => {
      const a = k === 1 ? base : base + (j - (k - 1) / 2) * (span / k);
      urls.push({ entry: e, angle: a, x: r * Math.cos(a), y: r * Math.sin(a) });
    });
  }

  const cw = Math.max(80, textWidth(truncate(state.userName, 12), 15) + 28);
  let minX = -cw / 2, maxX = cw / 2, minY = -26, maxY = 26;
  const grow = (x0, x1, y0, y1) => {
    minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
  };
  for (const l of labels.values()) {
    const w = textWidth(`${l.name} (${l.count})`) + 24;
    grow(l.x - w / 2, l.x + w / 2, l.y - 15, l.y + 15);
  }
  for (const u of urls) {
    const w = textWidth(urlText(u.entry)) + 14;
    const right = Math.cos(u.angle) >= 0;
    grow(right ? u.x - 6 : u.x - w, right ? u.x + w : u.x + 6, u.y - 10, u.y + 10);
  }
  return { labels, urls, cw, bounds: { minX: minX - 30, minY: minY - 30, maxX: maxX + 30, maxY: maxY + 30 } };
}

function urlText(entry) {
  return truncate(entry.title || entry.url, 34);
}

// ---------- 描画 ----------

const drag = { moved: false };

function renderMap(target, expanded, { forExport = false } = {}) {
  target.replaceChildren();
  const L = layout(state.data, expanded);
  const q = state.query.trim().toLowerCase();
  const matches = (name) => q && name.toLowerCase().includes(q);

  if (forExport) {
    const b = L.bounds;
    target.appendChild(svgEl('rect', { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY, fill: '#ffffff' }));
  }
  const g = svgEl('g', { 'font-family': FONT, 'font-size': 13 });
  target.appendChild(g);

  // 線(ユーザー→ラベル、ラベル→URL。ラベル同士は結ばない)
  const edges = svgEl('g', { stroke: '#9aa5b1', 'stroke-width': 1.3, fill: 'none' });
  g.appendChild(edges);
  for (const l of L.labels.values()) edges.appendChild(svgEl('line', { x1: 0, y1: 0, x2: l.x, y2: l.y }));
  for (const u of L.urls) {
    for (const name of u.entry.labels) {
      const l = L.labels.get(name);
      if (l) edges.appendChild(svgEl('line', { x1: l.x, y1: l.y, x2: u.x, y2: u.y }));
    }
  }

  // ユーザー
  g.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: L.cw / 2, ry: 24, fill: '#2b6cb0' }));
  g.appendChild(svgEl('text', { x: 0, y: 5, 'text-anchor': 'middle', fill: '#fff', 'font-size': 15, 'font-weight': 'bold' }, truncate(state.userName, 12)));

  // ラベル
  for (const l of L.labels.values()) {
    const open = expanded.has(l.name);
    const hit = matches(l.name);
    const text = `${l.name} (${l.count})`;
    const w = textWidth(text) + 24;
    const node = svgEl('g', { opacity: q && !hit ? 0.3 : 1 });
    node.appendChild(svgEl('rect', {
      x: l.x - w / 2, y: l.y - 15, width: w, height: 30, rx: 15,
      fill: hit ? '#fff3bf' : open ? '#2f855a' : '#e6f4ea',
      stroke: hit ? '#f59e0b' : '#2f855a',
      'stroke-width': hit ? 4 : 1.5,
    }));
    node.appendChild(svgEl('text', { x: l.x, y: l.y + 4.5, 'text-anchor': 'middle', fill: open && !hit ? '#fff' : '#1f2933' }, text));
    if (!forExport) {
      node.setAttribute('style', 'cursor:pointer');
      node.setAttribute('role', 'button');
      node.setAttribute('tabindex', '0');
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

  // URL
  for (const u of L.urls) {
    const right = Math.cos(u.angle) >= 0;
    const dim = q && !u.entry.labels.some(matches);
    const a = svgEl('a', { href: u.entry.url, target: '_blank', rel: 'noopener noreferrer', opacity: dim ? 0.3 : 1 });
    a.appendChild(svgEl('title', {}, `${u.entry.title ? u.entry.title + '\n' : ''}${u.entry.url}`));
    a.appendChild(svgEl('circle', { cx: u.x, cy: u.y, r: 4.5, fill: '#2b6cb0' }));
    a.appendChild(svgEl('text', {
      x: u.x + (right ? 9 : -9), y: u.y + 4.5, 'text-anchor': right ? 'start' : 'end',
      fill: '#2b6cb0', 'text-decoration': 'underline',
    }, urlText(u.entry)));
    g.appendChild(a);
  }
  return L.bounds;
}

// ---------- 表示範囲(パン・ズーム) ----------

let view = null;

function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function fitView() {
  const b = lastBounds;
  view = { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
  applyView();
}

let lastBounds = { minX: -200, minY: -200, maxX: 200, maxY: 200 };

function renderAll(refit) {
  lastBounds = renderMap(svg, state.expanded);
  if (refit || !view) fitView();
  $('emptyMsg').hidden = state.data.urls.length > 0;
  $('count').textContent = state.data.urls.length;
  renderList();
  updateSearchStatus();
}

// ---------- ラベル入力のプルダウン(登録済みラベルから選ぶ) ----------

const labelInput = $('labelInput');
const labelMenu = $('labelMenu');
let menuItems = [];
let menuIdx = -1;

function allLabels() {
  const set = new Set();
  state.data.urls.forEach((e) => e.labels.forEach((l) => set.add(l)));
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

// 入力欄のうち、いま打っている最後のラベルとそれより前の部分に分ける
function splitInput() {
  const v = labelInput.value;
  const m = v.match(/^([\s\S]*[,、，\s])([^,、，\s]*)$/);
  return m ? { head: m[1], part: m[2] } : { head: '', part: v };
}

function closeMenu() {
  labelMenu.hidden = true;
  labelInput.setAttribute('aria-expanded', 'false');
  menuIdx = -1;
}

function openMenu(showAll) {
  const { head, part } = splitInput();
  const used = new Set(parseLabels(head));
  const q = showAll ? '' : part.trim().toLowerCase();
  menuItems = allLabels().filter((l) => !used.has(l) && l.toLowerCase().includes(q));
  menuIdx = -1;
  if (!menuItems.length) { closeMenu(); return; }
  labelMenu.replaceChildren(...menuItems.map((l, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.textContent = l;
    li.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickLabel(l); });
    li.addEventListener('mouseenter', () => highlightItem(i));
    return li;
  }));
  labelMenu.hidden = false;
  labelInput.setAttribute('aria-expanded', 'true');
}

function highlightItem(i) {
  menuIdx = i;
  [...labelMenu.children].forEach((li, k) => {
    li.classList.toggle('active', k === i);
    if (k === i) li.scrollIntoView({ block: 'nearest' });
  });
}

function pickLabel(l) {
  labelInput.value = splitInput().head + l + ', ';
  labelInput.focus();
  openMenu(false);
}

labelInput.addEventListener('focus', () => openMenu(false));
labelInput.addEventListener('input', () => openMenu(false));
labelInput.addEventListener('blur', closeMenu);
labelInput.addEventListener('keydown', (ev) => {
  if (labelMenu.hidden) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); openMenu(true); }
    return;
  }
  if (ev.key === 'ArrowDown') { ev.preventDefault(); highlightItem((menuIdx + 1) % menuItems.length); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlightItem((menuIdx - 1 + menuItems.length) % menuItems.length); }
  else if (ev.key === 'Enter' && menuIdx >= 0) { ev.preventDefault(); pickLabel(menuItems[menuIdx]); }
  else if (ev.key === 'Escape') closeMenu();
});
$('labelToggle').addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  if (labelMenu.hidden) { labelInput.focus(); openMenu(true); } else closeMenu();
});

function renderList() {
  const ul = $('list');
  ul.replaceChildren();
  for (const e of state.data.urls) {
    const li = document.createElement('li');
    const item = document.createElement('div');
    item.className = 'item';
    const a = document.createElement('a');
    a.href = e.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = e.title || e.url;
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.textContent = e.labels.join(' / ');
    item.append(a, chips);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '削除';
    del.addEventListener('click', () => deleteUrl(e));
    li.append(item, del);
    ul.appendChild(li);
  }
}

function updateSearchStatus() {
  const q = state.query.trim().toLowerCase();
  if (!q) return;
  const names = new Set();
  state.data.urls.forEach((e) => e.labels.forEach((l) => names.add(l)));
  const hits = [...names].filter((l) => l.toLowerCase().includes(q)).length;
  setStatus(hits ? `${hits}件のラベルがヒットしました` : '一致するラベルはありません');
}

svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const ctm = svg.getScreenCTM();
  if (!ctm) return;
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
  const f = ev.deltaY < 0 ? 0.85 : 1 / 0.85;
  view = { x: p.x - (p.x - view.x) * f, y: p.y - (p.y - view.y) * f, w: view.w * f, h: view.h * f };
  applyView();
}, { passive: false });

let panStart = null;
svg.addEventListener('pointerdown', (ev) => {
  panStart = { cx: ev.clientX, cy: ev.clientY, view: { ...view }, ctm: svg.getScreenCTM() };
  drag.moved = false;
});
window.addEventListener('pointermove', (ev) => {
  if (!panStart || !panStart.ctm) return;
  const dx = ev.clientX - panStart.cx;
  const dy = ev.clientY - panStart.cy;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  drag.moved = true;
  const k = 1 / panStart.ctm.a;
  view = { ...panStart.view, x: panStart.view.x - dx * k, y: panStart.view.y - dy * k };
  applyView();
});
window.addEventListener('pointerup', () => {
  panStart = null;
  setTimeout(() => { drag.moved = false; }, 0);
});

// ---------- 操作ボタン ----------

$('searchInput').addEventListener('input', (ev) => {
  state.query = ev.target.value;
  if (!state.query.trim()) setStatus('');
  renderAll(false);
});
$('fitBtn').addEventListener('click', () => fitView());
$('expandAllBtn').addEventListener('click', () => {
  state.data.urls.forEach((e) => e.labels.forEach((l) => state.expanded.add(l)));
  renderAll(true);
});
$('collapseAllBtn').addEventListener('click', () => {
  state.expanded.clear();
  renderAll(true);
});

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

$('jsonBtn').addEventListener('click', () => {
  const labels = {};
  state.data.urls.forEach((e) => e.labels.forEach((l) => { (labels[l] = labels[l] || []).push({ url: e.url, title: e.title }); }));
  const out = { user: state.userName, exportedAt: new Date().toISOString(), labels, urls: state.data.urls };
  download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `url_label_map_${stamp()}.json`);
});

$('pngBtn').addEventListener('click', async () => {
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
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('画像の生成に失敗しました(大きすぎる可能性があります)');
    download(blob, `url_label_map_${stamp()}.png`);
  } catch (e) {
    setStatus(e.message, true);
  }
});

// ---------- 起動 ----------

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
