'use strict';

// 保存先(Google Drive / ローカル試用)とログイン。閲覧版ではこのファイルを差し替える。

// Google Cloud で作成した OAuth クライアントID(公開してよい値)。空のときはローカル試用モードで動く。
const GOOGLE_CLIENT_ID = '521983241176-9hhi3ukhpma4le767rtehh4hgojmf5eq.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'url_label_map.json';
const LOCAL_KEY = 'url_label_map_local_trial';

// ログイン・保存に使う状態(main.js の state に足す)
// syncing: 保存データ(キャッシュ)を表示中で、Driveとの同期が終わっていない間は true(この間は編集を待たせる)。
// cacheShown: 保存データをすでに画面に出したか(再ログインを待つ間に先に出す場合がある)。
Object.assign(state, { token: null, tokenExpiresAt: 0, fileId: null, dirty: false, local: !GOOGLE_CLIENT_ID, syncing: false, cacheShown: false });

class AuthError extends Error {}

// ---------- 保存先(Google Drive appDataFolder / ローカル試用) ----------

async function drive(url, init = {}) {
  if (!state.token || Date.now() > state.tokenExpiresAt) throw new AuthError();
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + state.token } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw Object.assign(new Error('Google Driveとの通信に失敗しました (' + res.status + ')'), { status: res.status });
  return res;
}

const store = {
  async load() {
    if (state.local) {
      try { return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY))); } catch { return normalize(null); }
    }
    // ファイルIDが分かっていれば(保存データから復元した場合)、検索を省いて本体を直接取る。消えていたら検索へ戻る
    if (state.fileId) {
      try {
        const endGet = dbg.span('Drive本体取得(ID指定)');
        const body = await (await drive(`https://www.googleapis.com/drive/v3/files/${state.fileId}?alt=media`)).json();
        endGet();
        return normalize(body);
      } catch (e) {
        if (e.status !== 404) throw e;
        state.fileId = null;
      }
    }
    const q = encodeURIComponent(`name='${FILE_NAME}'`);
    const endSearch = dbg.span('Drive検索');
    const list = await (await drive(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json();
    endSearch();
    if (!list.files.length) return normalize(null);
    state.fileId = list.files[0].id;
    const endGet = dbg.span('Drive本体取得');
    const res = await drive(`https://www.googleapis.com/drive/v3/files/${state.fileId}?alt=media`);
    const body = await res.json();
    endGet();
    return normalize(body);
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
      const endSave = dbg.span('保存');
      await store.save(JSON.parse(snapshot));
      endSave(state.local ? 'ローカル' : 'Drive');
      cache.write();
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

// 保存データ(キャッシュ)を先に画面へ出す。Driveとの同期が終わるまでは編集を待たせる(古いデータでDriveを上書きしないため)
function showCache(c) {
  Object.assign(state, { data: c.data, userName: c.userName, fileId: c.fileId, syncing: true, cacheShown: true });
  $('loginPanel').hidden = true;
  $('app').hidden = false;
  setStatus('');
  renderAll(true);
}

// 同期や再ログインに失敗したとき、先に出した保存データを引っ込めてログイン画面へ戻す
function backToLogin() {
  Object.assign(state, { data: { version: 1, urls: [] }, userName: 'あなた', fileId: null, syncing: false, cacheShown: false });
  $('app').hidden = true;
  $('loginPanel').hidden = false;
}

// 編集(登録・削除・一括登録)の入口で呼ぶ。同期中なら待たせる
function editLocked() {
  if (!state.syncing) return false;
  setStatus('Driveと同期中です。終わってから操作してください');
  return true;
}

async function start() {
  const t0 = performance.now();
  dbg.log(`ページ読込〜起動開始: ${Math.round(t0)}ms`);
  const endAll = dbg.span('起動合計');
  const cached = !state.local && !state.cacheShown ? cache.read() : null;
  if (cached) showCache(cached);
  else if (!state.cacheShown) setStatus('データを読み込み中…');
  try {
    // ユーザー名取得とデータ取得は同時に走らせる(往復の待ち時間を重ねる)
    const endLoad = dbg.span('ユーザー名+データ取得');
    const [name, data] = await Promise.all([state.local ? 'ローカル試用' : fetchUserName(), store.load()]);
    endLoad();
    const changed = !state.cacheShown || name !== state.userName || JSON.stringify(data) !== JSON.stringify(state.data);
    state.userName = name;
    state.data = data;
    state.syncing = false;
    state.cacheShown = false;
    dbg.stats();
    $('loginPanel').hidden = true;
    $('app').hidden = false;
    setStatus('');
    if (changed) renderAll(true);
    cache.write();
    endAll();
    maybeNudge(performance.now() - t0, !cached);
  } catch (e) {
    if (state.cacheShown && e instanceof AuthError) { backToLogin(); return; }
    // 保存データを出している間に同期できなかったときは、編集を待たせたまま閲覧だけできる状態にする
    setStatus(state.cacheShown ? '同期できませんでした。閲覧のみです。再読み込みしてください(' + e.message + ')' : e.message, true);
  }
}

// ---------- 「この端末に保存する」の案内(#51) ----------
// 起動表示に1秒以上かかり、保存がOFFで、案内を一度も閉じていないときだけ出す。

const NUDGE_MS = 1000;

function maybeNudge(elapsedMs, measured) {
  if (!measured || state.local || cache.on || cache.nudgeDone() || elapsedMs < NUDGE_MS) return;
  $('cacheNudgeText').textContent =
    `表示に${(elapsedMs / 1000).toFixed(1)}秒かかりました。この端末にデータを保存すると、次回から速く表示できます(共有のパソコンでは、使い終わったらログアウトしてください)。`;
  $('cacheNudge').hidden = false;
}

$('cacheNudgeOn').addEventListener('click', () => {
  cache.finishNudge(); // 後でOFFにしても、案内をもう一度出さない
  cache.set(true);
  $('cacheNudge').hidden = true;
  setStatus('この端末に保存します。次回から速く表示されます');
});

$('cacheNudgeClose').addEventListener('click', () => {
  cache.finishNudge();
  $('cacheNudge').hidden = true;
});

// 「保存」メニューの端末保存の切替
function toggleCache() {
  cache.set(!cache.on);
  if (cache.on) { cache.finishNudge(); $('cacheNudge').hidden = true; }
  setStatus(cache.on ? 'この端末に保存します。次回から速く表示されます' : 'この端末の保存データを消しました');
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
  cache.clear();
  $('cacheNudge').hidden = true;
  Object.assign(state, { token: null, tokenExpiresAt: 0, fileId: null, dirty: false, syncing: false, cacheShown: false, data: { version: 1, urls: [] }, expanded: new Set(), query: '' });
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
    cache.clear();
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

// 「保存」メニューのうち、ログインに関わる項目(閲覧版では空にする)
function sessionMenuItems() {
  return [{ text: 'ログ\nアウト', act: 'logout', confirmText: 'もう一度\n押す', needConfirm: () => state.dirty }];
}

// ---------- 起動(ログインの状態に応じた最初の画面) ----------

if (state.local) {
  $('localBanner').hidden = false;
  start();
} else if (restoreSession()) {
  start();
} else if (wasSignedIn()) {
  // 画面なしの再ログインを試す。ブラウザにポップアップを止められたり同意が必要な場合は、ログインボタンを出す。
  // 再ログインを待つ間に、保存データがあれば先に表示する(同期と編集は再ログイン後)
  const early = cache.read();
  if (early) showCache(early); else setStatus('ログインを確認中…');
  whenGoogleReady()
    .then((ok) => (ok ? requestToken('none') : Promise.reject(new Error(''))))
    .then(() => start())
    .catch(() => { setStatus(''); backToLogin(); });
} else {
  $('loginPanel').hidden = false;
}
