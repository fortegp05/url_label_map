'use strict';

// 保存先(Google Drive / ローカル試用)とログイン。閲覧版ではこのファイルを差し替える。

// Google Cloud で作成した OAuth クライアントID(公開してよい値)。空のときはローカル試用モードで動く。
const GOOGLE_CLIENT_ID = '521983241176-9hhi3ukhpma4le767rtehh4hgojmf5eq.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'url_label_map.json';
const LOCAL_KEY = 'url_label_map_local_trial';

// ログイン・保存に使う状態(main.js の state に足す)
Object.assign(state, { token: null, tokenExpiresAt: 0, fileId: null, dirty: false, local: !GOOGLE_CLIENT_ID });

class AuthError extends Error {}

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
  setStatus('ログインを確認中…');
  whenGoogleReady()
    .then((ok) => (ok ? requestToken('none') : Promise.reject(new Error(''))))
    .then(() => start())
    .catch(() => { setStatus(''); $('loginPanel').hidden = false; });
} else {
  $('loginPanel').hidden = false;
}
