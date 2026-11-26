'use strict';

// この端末へのローカル保存(キャッシュ)(#51)。既定はOFF。
// ONのときだけ、データ(URL・ラベル・タイトル)・ユーザー名・DriveのファイルIDを、この端末のlocalStorageに保存する。
// OFFにする・ログアウト・全データ削除のときは、保存したデータを消す。外部へは送信しない。

const CACHE_ON_KEY = 'url_label_map_cache_on';
const CACHE_DATA_KEY = 'url_label_map_cache';
const CACHE_NUDGE_KEY = 'url_label_map_cache_nudge_done';

const cache = {
  on: false,

  init() {
    try { this.on = localStorage.getItem(CACHE_ON_KEY) === '1'; } catch { this.on = false; }
  },

  set(v) {
    this.on = !!v;
    try { localStorage.setItem(CACHE_ON_KEY, this.on ? '1' : '0'); } catch { /* 記憶できなくても動作は続ける */ }
    if (this.on) this.write(); else this.clear();
  },

  // 保存データを返す。OFFのときと、読めない・形が違うときは null
  read() {
    if (!this.on) return null;
    try {
      const j = JSON.parse(localStorage.getItem(CACHE_DATA_KEY));
      if (!j || typeof j.userName !== 'string') return null;
      return { data: normalize(j.data), userName: j.userName, fileId: typeof j.fileId === 'string' ? j.fileId : null };
    } catch {
      return null;
    }
  },

  // 現在の画面のデータを保存する(ONのときだけ。ローカル試用モードはもともとlocalStorageなので対象外)
  write() {
    if (!this.on || state.local) return;
    try {
      localStorage.setItem(CACHE_DATA_KEY, JSON.stringify({ data: state.data, userName: state.userName, fileId: state.fileId }));
    } catch { /* 容量不足などで保存できなくても動作は続ける */ }
  },

  clear() {
    try { localStorage.removeItem(CACHE_DATA_KEY); } catch { /* 無視 */ }
  },

  // 案内(「この端末に保存すると速くなります」)を、すでに閉じた/対応済みか
  nudgeDone() {
    try { return localStorage.getItem(CACHE_NUDGE_KEY) === '1'; } catch { return true; }
  },

  finishNudge() {
    try { localStorage.setItem(CACHE_NUDGE_KEY, '1'); } catch { /* 無視 */ }
  },
};

cache.init();
