"""fill_titles.py のテスト(標準ライブラリのみ)。実行: python -m unittest discover -s tools"""

import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import fill_titles as ft

JA = 'ネットワークの基礎知識'
PAGES = {
    '/utf8': ('text/html; charset=utf-8', f'<html><head><title>{JA}</title></head></html>'.encode('utf-8')),
    '/utf8-nodecl': ('text/html', f'<html><head><title>{JA}</title></head></html>'.encode('utf-8')),
    '/sjis-header': ('text/html; charset=Shift_JIS', f'<title>{JA}</title>'.encode('cp932')),
    '/sjis-meta': ('text/html', f'<meta charset="shift_jis"><title>{JA}</title>'.encode('cp932')),
    '/sjis-nodecl': ('text/html', f'<title>{JA}</title>'.encode('cp932')),
    '/euc-meta': ('text/html', (f'<meta http-equiv="Content-Type" content="text/html; charset=EUC-JP">'
                                f'<title>{JA}</title>').encode('euc_jp')),
    '/og': ('text/html; charset=utf-8', '<head><title> </title><meta property="og:title" content="OGのタイトル"></head>'.encode('utf-8')),
    '/entities': ('text/html; charset=utf-8', '<title>A &amp; B\n   &lt;C&gt;</title>'.encode('utf-8')),
    '/long': ('text/html; charset=utf-8', ('<title>' + 'あ' * 300 + '</title>').encode('utf-8')),
    '/notitle': ('text/html; charset=utf-8', b'<html><body>no title</body></html>'),
    '/png': ('image/png', b'\x89PNG\r\n'),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/utf8')
            self.end_headers()
        elif self.path == '/redirect-ftp':
            self.send_response(302)
            self.send_header('Location', 'ftp://example.com/x')
            self.end_headers()
        elif self.path == '/slow':
            time.sleep(1.5)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<title>slow</title>')
        elif self.path in PAGES:
            ctype, body = PAGES[self.path]
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()


class FetchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.base = f'http://127.0.0.1:{cls.srv.server_address[1]}'
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def get(self, path):
        return ft.fetch_title(self.base + path)

    def test_charsets(self):
        for p in ('/utf8', '/utf8-nodecl', '/sjis-header', '/sjis-meta', '/sjis-nodecl', '/euc-meta'):
            with self.subTest(p):
                self.assertEqual(self.get(p), (JA, ''))

    def test_og_fallback(self):
        self.assertEqual(self.get('/og'), ('OGのタイトル', ''))

    def test_entities_and_whitespace(self):
        self.assertEqual(self.get('/entities'), ('A & B <C>', ''))

    def test_title_truncated(self):
        title, why = self.get('/long')
        self.assertEqual(len(title), ft.TITLE_MAX)
        self.assertEqual(why, '')

    def test_redirect(self):
        self.assertEqual(self.get('/redirect'), (JA, ''))

    def test_redirect_to_non_http_is_refused(self):
        title, why = self.get('/redirect-ftp')
        self.assertEqual(title, '')
        self.assertTrue(why)

    def test_failures_do_not_raise(self):
        self.assertEqual(self.get('/missing'), ('', 'HTTP 404'))
        self.assertEqual(self.get('/png')[0], '')
        self.assertIn('HTMLではありません', self.get('/png')[1])
        self.assertEqual(self.get('/notitle'), ('', 'タイトルが見つかりません'))
        title, why = ft.fetch_title('http://127.0.0.1:1/')  # 接続できないポート
        self.assertEqual(title, '')
        self.assertIn('接続できません', why)

    def test_timeout(self):
        old = ft.TIMEOUT
        ft.TIMEOUT = 0.5
        try:
            self.assertEqual(self.get('/slow'), ('', 'タイムアウト'))
        finally:
            ft.TIMEOUT = old


class FillTest(unittest.TestCase):
    def test_existing_titles_are_kept_and_not_fetched(self):
        calls = []

        def fake(url):
            calls.append(url)
            return ('取得', '')

        entries = [
            {'url': 'https://a.com/', 'title': '既存', 'labels': ['x']},
            {'url': 'https://b.com/', 'title': '', 'labels': ['x']},
            {'url': 'https://b.com/', 'title': '', 'labels': ['y']},  # 同じURLは1回だけ取る
        ]
        got, failed, existing = ft.fill(entries, fetch=fake)
        self.assertEqual(calls, ['https://b.com/'])
        self.assertEqual([e['title'] for e in entries], ['既存', '取得', '取得'])
        self.assertEqual((got, failed, existing), (1, [], 1))

    def test_failure_leaves_title_empty(self):
        entries = [{'url': 'https://a.com/', 'title': '', 'labels': ['x']}]
        got, failed, _ = ft.fill(entries, fetch=lambda u: ('', 'HTTP 403'))
        self.assertEqual(entries[0]['title'], '')
        self.assertEqual((got, failed), (0, [('https://a.com/', 'HTTP 403')]))


class InputTest(unittest.TestCase):
    def load(self, name, data: bytes):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / name
            p.write_bytes(data)
            bad = []
            return ft.load_entries(p, bad), bad

    def test_app_json(self):
        data = {'version': 1, 'urls': [
            {'url': 'https://a.com/', 'title': 'T', 'labels': ['x', 'x', 'y']},
            {'url': 'ftp://bad', 'labels': ['x']},
            {'url': 'https://c.com/', 'labels': []},
        ]}
        entries, bad = self.load('d.json', json.dumps(data).encode('utf-8'))
        self.assertEqual(entries, [{'url': 'https://a.com/', 'title': 'T', 'labels': ['x', 'y']}])
        self.assertEqual(len(bad), 2)

    def test_json_array(self):
        entries, bad = self.load('d.json', b'[{"url":"https://a.com/","labels":["x"]}]')
        self.assertEqual(entries, [{'url': 'https://a.com/', 'title': '', 'labels': ['x']}])
        self.assertEqual(bad, [])

    def test_csv_with_header_and_quotes_utf8_bom(self):
        text = '﻿url,label\r\n"https://a.com/?a=1,2","ラベル1, ラベル2"\r\nhttps://b.com/,"x"\r\nftp://bad,x\r\n'
        entries, bad = self.load('d.csv', text.encode('utf-8'))
        self.assertEqual([e['url'] for e in entries], ['https://a.com/?a=1,2', 'https://b.com/'])
        self.assertEqual(entries[0]['labels'], ['ラベル1', 'ラベル2'])
        self.assertEqual(len(bad), 1)

    def test_csv_shift_jis(self):
        text = 'URL,ラベル\r\nhttps://a.com/,日本語\r\n'
        entries, bad = self.load('d.csv', text.encode('cp932'))
        self.assertEqual(entries[0]['labels'], ['日本語'])


class MainTest(unittest.TestCase):
    def test_end_to_end_and_no_overwrite_of_input(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / 'in.json'
            src.write_text(json.dumps({'version': 1, 'urls': [{'url': 'http://127.0.0.1:1/', 'title': 'そのまま', 'labels': ['x']}]}),
                           encoding='utf-8')
            self.assertEqual(ft.main([str(src)]), 0)
            out = json.loads((Path(d) / 'in.titled.json').read_text(encoding='utf-8'))
            self.assertEqual(out['urls'][0]['title'], 'そのまま')
            self.assertEqual(ft.main([str(src), '-o', str(src)]), 1)  # 入力を上書きしない

    def test_missing_file(self):
        self.assertEqual(ft.main(['no_such_file.json']), 1)


if __name__ == '__main__':
    unittest.main()
