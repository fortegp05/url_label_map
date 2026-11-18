#!/usr/bin/env python3
"""URLラベルマップのファイルに、ページのタイトルを付ける(PC用)。

ブラウザからの取得はCORSで拒否されるサイトが多いので、PCのローカルで取りに行く。
結果のJSONを、アプリの「ファイルから一括登録」で取り込むと、タイトルが空のURLにだけ入る。

  python tools/fill_titles.py 入力ファイル [-o 出力ファイル]

入力: アプリの「JSON保存」のファイル、[{url, title, labels}] の配列、CSV(URL,ラベル1,ラベル2,…)。
出力: {"version":1,"urls":[{url,title,labels}]} のJSON。既定は「入力ファイル名.titled.json」。
タイトルが空のURLだけを取得する(CSVはすべて)。取れなかったURLは、タイトル空のまま残す。
Pythonの標準ライブラリだけで動く。
"""

import argparse
import codecs
import csv
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path

WORKERS = 3          # 同時に取りに行く数
TIMEOUT = 10         # 1件あたりの秒数(接続と読み込みの合計)
MAX_BYTES = 512 * 1024
TITLE_MAX = 200      # アプリの上限(LIMIT.title)と同じ
LABEL_MAX = 50       # アプリの LIMIT.label
LABELS_PER_URL = 10  # アプリの LIMIT.labelsPerUrl
URL_MAX = 2000       # アプリの LIMIT.url
UA = 'Mozilla/5.0 (compatible; url_label_map-fill-titles)'


# ---------- 入力 ----------

def decode_file(raw: bytes) -> str:
    """UTF-8(BOMあり・なし)を先に試し、読めなければShift_JIS(ExcelのCSV対応)。"""
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return raw.decode('cp932', errors='replace')


def valid_http_url(s) -> bool:
    if not isinstance(s, str):
        return False
    s = s.strip()
    return bool(re.match(r'^https?://[^\s/?#]+', s, re.IGNORECASE)) and len(s) <= URL_MAX


def parse_labels(s: str):
    out = []
    for raw in re.split(r'[,、，\s]+', s):
        label = raw.strip()[:LABEL_MAX]
        if label and label not in out:
            out.append(label)
    return out[:LABELS_PER_URL]


def entries_from_csv(text: str, bad: list):
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if rows and '://' not in rows[0][0]:
        rows.pop(0)  # ヘッダー行
    out = []
    for i, r in enumerate(rows, 1):
        url = r[0].strip()
        if not valid_http_url(url):
            bad.append(f'{i}件目: URLが http:// または https:// で始まる形式ではありません ({url[:60]})')
            continue
        labels = parse_labels(','.join(r[1:]))
        if not labels:
            bad.append(f'{i}件目: ラベルがありません ({url[:60]})')
            continue
        out.append({'url': url, 'title': '', 'labels': labels})
    return out


def entries_from_json(text: str, bad: list):
    raw = json.loads(text)
    arr = raw if isinstance(raw, list) else (raw.get('urls') if isinstance(raw, dict) else None)
    if not isinstance(arr, list):
        raise ValueError('「urls」の配列が見つかりません')
    out = []
    for i, e in enumerate(arr, 1):
        url = e.get('url') if isinstance(e, dict) else None
        if not valid_http_url(url):
            bad.append(f'{i}件目: URLが http:// または https:// で始まる形式ではありません')
            continue
        labels = [x.strip()[:LABEL_MAX] for x in e.get('labels', []) if isinstance(x, str) and x.strip()] \
            if isinstance(e.get('labels'), list) else []
        labels = list(dict.fromkeys(labels))[:LABELS_PER_URL]
        if not labels:
            bad.append(f'{i}件目: ラベルがありません ({url[:60]})')
            continue
        title = e.get('title') if isinstance(e.get('title'), str) else ''
        out.append({'url': url.strip(), 'title': title[:TITLE_MAX], 'labels': labels})
    return out


def load_entries(path: Path, bad: list):
    text = decode_file(path.read_bytes())
    if path.suffix.lower() == '.json' or text.lstrip().startswith(('{', '[')):
        return entries_from_json(text, bad)
    return entries_from_csv(text, bad)


# ---------- タイトル取得 ----------

class _TitleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = None
        self.og = None
        self._in_title = False
        self._buf = []

    def handle_starttag(self, tag, attrs):
        if tag == 'title' and self.title is None:
            self._in_title = True
            self._buf = []
        elif tag == 'meta' and self.og is None:
            a = {k.lower(): (v or '') for k, v in attrs}
            if a.get('property', '').lower() == 'og:title' and a.get('content', '').strip():
                self.og = a['content']

    def handle_data(self, data):
        if self._in_title:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag == 'title' and self._in_title:
            self._in_title = False
            self.title = ''.join(self._buf)


def tidy(s: str) -> str:
    return re.sub(r'\s+', ' ', s).strip()[:TITLE_MAX]


def extract_title(text: str) -> str:
    """<title> を優先し、空なら og:title。"""
    p = _TitleParser()
    try:
        p.feed(text)
        p.close()
    except Exception:  # 壊れたHTMLでも、ここまでに取れた分を使う
        pass
    return tidy(p.title or '') or tidy(p.og or '')


def _norm_charset(name: str):
    name = (name or '').strip().strip('"\'').lower()
    if not name:
        return None
    if name in ('shift_jis', 'shift-jis', 'sjis', 'x-sjis', 'ms932', 'windows-31j'):
        name = 'cp932'  # Shift_JISの拡張(機種依存文字)も読めるように
    if name in ('euc-jp', 'eucjp', 'x-euc-jp'):
        name = 'euc_jp'
    try:
        return codecs.lookup(name).name
    except LookupError:
        return None


def decode_html(raw: bytes, header_charset: str = None) -> str:
    """文字コードを、ヘッダー、<meta>、UTF-8、Shift_JIS、EUC-JP の順に試す。"""
    cands = []
    h = _norm_charset(header_charset)
    if h:
        cands.append(h)
    head = raw[:4096].decode('ascii', errors='ignore')
    m = re.search(r'<meta[^>]+charset\s*=\s*["\']?\s*([\w\-]+)', head, re.IGNORECASE)
    if m:
        c = _norm_charset(m.group(1))
        if c:
            cands.append(c)
    cands += ['utf-8', 'cp932', 'euc_jp']
    seen = set()
    for c in cands:
        if c in seen:
            continue
        seen.add(c)
        try:
            return raw.decode(c)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', errors='replace')


class _HttpOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not re.match(r'^https?://', newurl, re.IGNORECASE):
            raise urllib.error.URLError('http/https以外へのリダイレクトです')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_HttpOnlyRedirect)


def fetch_title(url: str):
    """(タイトル, エラーの理由)。取れたときは理由が空、取れなかったときはタイトルが空。"""
    deadline = time.monotonic() + TIMEOUT
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'ja,en;q=0.8',
    })
    try:
        with _opener.open(req, timeout=TIMEOUT) as resp:
            ctype = resp.headers.get('Content-Type', '')
            mime = ctype.split(';')[0].strip().lower()
            if mime and mime not in ('text/html', 'application/xhtml+xml', 'application/xml', 'text/xml'):
                return '', f'HTMLではありません ({mime})'
            charset = resp.headers.get_content_charset()
            chunks, size = [], 0
            while size < MAX_BYTES:
                if time.monotonic() > deadline:
                    return '', 'タイムアウト'
                chunk = resp.read(min(16384, MAX_BYTES - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
    except urllib.error.HTTPError as e:
        return '', f'HTTP {e.code}'
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, TimeoutError) or 'timed out' in str(reason):
            return '', 'タイムアウト'
        return '', f'接続できません ({reason})'
    except TimeoutError:
        return '', 'タイムアウト'
    except Exception as e:  # noqa: BLE001 - 1件の失敗で全体を止めない
        return '', f'{type(e).__name__}: {e}'
    title = extract_title(decode_html(b''.join(chunks), charset))
    return (title, '') if title else ('', 'タイトルが見つかりません')


# ---------- 本体 ----------

def fill(entries, fetch=fetch_title, workers=WORKERS, log=None):
    """タイトルが空のエントリにだけ取りに行く。(取得数, 失敗[(url, 理由)], 既存数)を返す。"""
    todo = list(dict.fromkeys(e['url'] for e in entries if not e['title']))
    existing = sum(1 for e in entries if e['title'])
    results = {}
    failed = []
    if todo:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for n, (url, (title, why)) in enumerate(zip(todo, ex.map(fetch, todo)), 1):
                results[url] = title
                if not title:
                    failed.append((url, why))
                if log:
                    log(f'[{n}/{len(todo)}] {"OK  " if title else "失敗"} {url}' + (f'  {title}' if title else f'  ({why})'))
    for e in entries:
        if not e['title'] and results.get(e['url']):
            e['title'] = results[e['url']]
    got = sum(1 for u in todo if results.get(u))
    return got, failed, existing


def main(argv=None):
    ap = argparse.ArgumentParser(description='URLラベルマップのファイルに、ページのタイトルを付ける。')
    ap.add_argument('input', type=Path, help='アプリのJSON、[{url,title,labels}]の配列、またはCSV')
    ap.add_argument('-o', '--output', type=Path, help='出力先(既定: 入力ファイル名.titled.json)')
    args = ap.parse_args(argv)
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8', errors='replace')  # パイプや記録でも文字化けしないように(Windowsの画面は別経路で正しく出る)
        except Exception:  # noqa: BLE001
            pass

    out_path = args.output or args.input.with_name(args.input.stem + '.titled.json')
    if out_path.resolve() == args.input.resolve():
        print('出力先が入力ファイルと同じです。別のファイル名を指定してください', file=sys.stderr)
        return 1
    bad = []
    try:
        entries = load_entries(args.input, bad)
    except (OSError, ValueError) as e:
        print(f'読み込めませんでした: {e}', file=sys.stderr)
        return 1
    if not entries:
        print('取り込めるデータがありません', file=sys.stderr)
        for b in bad[:5]:
            print('  ' + b, file=sys.stderr)
        return 1

    got, failed, existing = fill(entries, log=lambda m: print(m, file=sys.stderr))
    out_path.write_text(json.dumps({'version': 1, 'urls': entries}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print(f'\n{len(entries)}件: タイトル取得 {got}件 / 取得できず {len(failed)}件 / 既にタイトルあり {existing}件 / 読み飛ばし {len(bad)}件')
    for url, why in failed:
        print(f'  取得できず: {url}  ({why})')
    for b in bad[:5]:
        print('  読み飛ばし: ' + b)
    if len(bad) > 5:
        print(f'  ほか{len(bad) - 5}件')
    print(f'出力: {out_path}')
    print('アプリの「ファイルから一括登録」で取り込むと、タイトルが空のURLにだけ入ります。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
