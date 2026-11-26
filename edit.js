'use strict';

// 登録・削除・一括登録(データを変える操作)。閲覧版ではこのファイルを差し替える。

// ---------- タイトル取得(ブラウザから直接fetch。失敗したらURL表示のまま) ----------

async function fetchTitle(url) {
  const endTitle = dbg.span('タイトル取得');
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
    endTitle();
  }
}

// ---------- 登録 ----------

$('addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (editLocked()) return;
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
  dbg.stats();
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
  if (editLocked()) return;
  state.data.urls = state.data.urls.filter((e) => e !== entry);
  renderAll(false);
  persist();
}

// ---------- 一括登録(CSV / JSON。PCのみ。ファイルはブラウザ内で読むだけで、送信しない) ----------

const IMPORT = { maxBytes: 1024 * 1024, maxRecords: 1000, titleWorkers: 3 };

// UTF-8を先に試し、読めなければShift_JIS(ExcelのCSV(コンマ区切り)対応)
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

// CSV → [{ line, cells }]。ダブルクォート("" でエスケープ、項目内の改行・カンマ)に対応。空行は除く
function parseCsv(text) {
  const rows = [];
  let cells = [];
  let cur = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const endCell = () => { cells.push(cur.trim()); cur = ''; };
  const endRow = () => {
    endCell();
    if (cells.some((c) => c)) rows.push({ line: start, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cur += ch;
      }
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === ',') endCell();
    else if (ch === '\r') continue;
    else if (ch === '\n') { endRow(); line++; start = line; }
    else cur += ch;
  }
  endRow();
  return rows;
}

// 取り込み候補 { url, title, labels } を作り、不正な行の理由を bad に積む
function entriesFromCsv(text, bad) {
  const rows = parseCsv(text);
  // 1行目の先頭の列がURL(://を含む)でなければ、ヘッダー行として読み飛ばす
  if (rows.length && !rows[0].cells[0].includes('://')) rows.shift();
  if (rows.length > IMPORT.maxRecords) throw new Error(`${IMPORT.maxRecords}件を超えています(${rows.length}件)。ファイルを分けてください`);
  const out = [];
  for (const r of rows) {
    const url = parseHttpUrl(r.cells[0]);
    if (!url) { bad.push(`${r.line}行目: URLが http:// または https:// で始まる形式ではありません`); continue; }
    const labels = parseLabels(r.cells.slice(1).join(','));
    if (!labels.length) { bad.push(`${r.line}行目: ラベルがありません`); continue; }
    out.push({ url, title: '', labels });
  }
  return out;
}

function entriesFromJson(text, bad) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('JSONとして読めません'); }
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.urls) ? raw.urls : null);
  if (!arr) throw new Error('「urls」の配列が見つかりません(このアプリが出力するJSON、または [{url, title, labels}] の配列が対象です)');
  if (arr.length > IMPORT.maxRecords) throw new Error(`${IMPORT.maxRecords}件を超えています(${arr.length}件)。ファイルを分けてください`);
  const out = [];
  arr.forEach((e, i) => {
    const one = normalize({ urls: [e] }).urls[0];
    if (one) out.push({ url: one.url, title: one.title, labels: one.labels });
    else bad.push(`${i + 1}件目: ${parseHttpUrl(e && e.url) ? 'ラベルがありません' : 'URLが http:// または https:// で始まる形式ではありません'}`);
  });
  return out;
}

// 手入力の登録と同じ扱い: 既存URLはラベルを足し合わせる(上書き・削除なし)。既存のタイトルは残す
function mergeImported(list) {
  const byUrl = new Map(state.data.urls.map((e) => [e.url, e]));
  const kind = new Map();
  for (const it of list) {
    const cur = byUrl.get(it.url);
    if (!cur) {
      const e = { url: it.url, title: it.title || '', labels: [...it.labels] };
      state.data.urls.push(e);
      byUrl.set(it.url, e);
      kind.set(e, 'add');
      continue;
    }
    const merged = [...new Set([...cur.labels, ...it.labels])].slice(0, LIMIT.labelsPerUrl);
    let changed = merged.length !== cur.labels.length;
    if (changed) cur.labels = merged;
    if (!cur.title && it.title) { cur.title = it.title; changed = true; }
    if (changed && !kind.has(cur)) kind.set(cur, 'label');
  }
  const uniq = new Set(list.map((it) => it.url));
  const added = [...kind.values()].filter((k) => k === 'add').length;
  const labeled = [...kind.values()].filter((k) => k === 'label').length;
  return { added, labeled, same: uniq.size - added - labeled, entries: [...uniq].map((u) => byUrl.get(u)) };
}

// タイトル取得: 取り込み後に背景で、同時に最大3件ずつ。取れたものだけ保存する
const titleJob = { queue: [], active: 0, total: 0, done: 0, found: 0, timer: null };

function flushTitles() {
  clearTimeout(titleJob.timer);
  titleJob.timer = null;
  renderAll(false);
  persist();
}

function pumpTitles() {
  const j = titleJob;
  while (j.active < IMPORT.titleWorkers && j.queue.length) {
    const e = j.queue.shift();
    if (e.title || !state.data.urls.includes(e)) { j.done++; continue; }
    j.active++;
    fetchTitle(e.url).then((t) => {
      if (t && !e.title && state.data.urls.includes(e)) {
        e.title = t;
        j.found++;
        if (!j.timer) j.timer = setTimeout(flushTitles, 2500);
      }
    }).finally(() => {
      j.active--;
      j.done++;
      setStatus(`タイトル取得中 ${j.done}/${j.total}…`);
      pumpTitles();
    });
  }
  if (!j.active && !j.queue.length && j.total) {
    if (j.timer) flushTitles();
    setStatus(`タイトル取得が終わりました(${j.found}件取得。取れなかったURLはURL表示のままです)`);
    Object.assign(j, { total: 0, done: 0, found: 0 });
  }
}

function enqueueTitles(entries) {
  const j = titleJob;
  for (const e of entries) {
    if (e.title || j.queue.includes(e)) continue;
    j.queue.push(e);
    j.total++;
  }
  pumpTitles();
}

async function importFile(file) {
  if (editLocked()) return;
  const out = $('importResult');
  const show = (msg) => { out.textContent = msg; placePanel(); drawLinks(); };
  if (file.size > IMPORT.maxBytes) { show('ファイルが大きすぎます(1MBまで)。ファイルを分けてください'); return; }
  const bad = [];
  let list;
  try {
    const text = decodeText(await file.arrayBuffer());
    list = /\.json$/i.test(file.name) ? entriesFromJson(text, bad) : entriesFromCsv(text, bad);
  } catch (e) {
    show('取り込めませんでした: ' + e.message);
    return;
  }
  if (!list.length && !bad.length) { show('取り込めるデータがありません'); return; }
  const r = mergeImported(list);
  if (r.added || r.labeled) { renderAll(true); persist(); }
  const lines = [`追加${r.added}件 / ラベルを追加${r.labeled}件 / 変更なし${r.same}件 / 不正な行${bad.length}件`];
  bad.slice(0, 5).forEach((b) => lines.push(b));
  if (bad.length > 5) lines.push(`ほか${bad.length - 5}件`);
  show(lines.join('\n'));
  setStatus(lines[0]);
  enqueueTitles(r.entries);
}

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (f) importFile(f);
});
