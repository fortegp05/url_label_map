'use strict';

// デバッグモード(#50)。ONの間だけ、所要時間・件数・データサイズを画面の隅とコンソールに出す。
// URLやラベルの文字列は出さない。外部へは送信しない。ON/OFFはこの端末のlocalStorageに記憶する。

const DEBUG_KEY = 'url_label_map_debug';

const dbg = {
  on: false,
  lines: [],
  max: 30,   // メモリに持つ行数
  shown: 10, // 画面に出す行数
  panel: null,

  init() {
    try { this.on = localStorage.getItem(DEBUG_KEY) === '1'; } catch { this.on = false; }
    this.render();
  },

  set(v) {
    this.on = !!v;
    try { localStorage.setItem(DEBUG_KEY, this.on ? '1' : '0'); } catch { /* 記憶できなくても動作は続ける */ }
    if (this.on) this.log('デバッグON');
    this.render();
  },

  toggle() { this.set(!this.on); },

  log(msg) {
    if (!this.on) return;
    this.lines.push(msg);
    if (this.lines.length > this.max) this.lines.shift();
    console.log('[debug] ' + msg);
    this.render();
  },

  // 区間の計測。終了時に呼ぶ関数を返す: const end = dbg.span('名前'); … end('補足');
  span(name) {
    if (!this.on) return () => {};
    const t0 = performance.now();
    return (extra) => this.log(`${name}: ${Math.round(performance.now() - t0)}ms` + (extra ? ` (${extra})` : ''));
  },

  // 件数とデータサイズ(文字列は含めない)
  stats() {
    if (!this.on) return;
    const bytes = new TextEncoder().encode(JSON.stringify(state.data)).length;
    this.log(`URL ${state.data.urls.length}件 / ラベル ${labelNames().length}件 / ${(bytes / 1024).toFixed(1)}KB`);
  },

  render() {
    if (!this.on) {
      if (this.panel) this.panel.hidden = true;
      return;
    }
    if (!this.panel) {
      this.panel = document.createElement('pre');
      this.panel.id = 'dbgPanel';
      this.panel.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.panel);
    }
    this.panel.hidden = false;
    this.panel.textContent = 'DEBUG\n' + this.lines.slice(-this.shown).join('\n');
  },
};

dbg.init();
