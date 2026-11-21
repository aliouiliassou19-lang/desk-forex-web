"""Tests du script d'export MT5 avec un faux module MetaTrader5 (aucun terminal necessaire).
Lancer : python -m unittest discover -s outils -p "test_*.py"
"""
import http.client
import json
import re
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mt5_export as X  # noqa: E402

NOW = 1_763_740_800.0          # 2025-11-21 16:00:00 UTC (valeur fixe)
OFF = 2                        # serveur en UTC+2


def deal(pos, entry, typ, vol, price, t, profit=0.0, commission=0.0, swap=0.0, sym="EURUSD", fee=0.0):
    return NS(position_id=pos, entry=entry, type=typ, volume=vol, price=price, time=t + OFF * 3600,
              profit=profit, commission=commission, swap=swap, fee=fee, symbol=sym, magic=0)


class FakeMT5:
    def __init__(self, tick_age_s=5):
        self.tick_age_s = tick_age_s
        self.calls = []

    def initialize(self, **kw): self.calls.append(("initialize", kw)); return True
    def shutdown(self): pass
    def last_error(self): return (0, "ok")
    def symbols_get(self): return [NS(name="EURUSDm", visible=True), NS(name="US30", visible=True)]
    def symbol_info_tick(self, name): return NS(time=int(NOW - self.tick_age_s) + OFF * 3600)

    def account_info(self):
        return NS(login=51234567, server="Broker-Demo", company="Broker", currency="USD", trade_mode=0, leverage=100,
                  balance=10019.3, equity=10025.0, margin=0, margin_free=10025.0, profit=5.7)

    def history_deals_get(self, a, b):
        return (
            NS(position_id=0, entry=0, type=2, volume=0, price=0, time=0, profit=10000, commission=0, swap=0, fee=0, symbol="", magic=0),
            deal(1001, 0, 0, 0.10, 1.0850, NOW - 7200, commission=-0.35),
            deal(1001, 1, 1, 0.10, 1.0870, NOW - 3600, profit=20.0, commission=-0.35),
            deal(1002, 0, 1, 0.20, 1.0900, NOW - 5000),                          # fermeture partielle
            deal(1002, 1, 0, 0.10, 1.0890, NOW - 4000, profit=10.0),
        )

    def history_orders_get(self, position=None):
        return [NS(time_setup=1, sl=1.0837, tp=1.0876)] if position == 1001 else []

    def positions_get(self):
        return [NS(identifier=1003, ticket=1003, symbol="XAUUSD", type=1, volume=0.01, time=int(NOW - 600) + OFF * 3600,
                   price_open=3530.0, sl=3533.0, tp=0.0, profit=5.7, swap=0.0)]


class ExportTests(unittest.TestCase):
    def test_offset_detection(self):
        self.assertEqual(X.detect_offset_hours(FakeMT5(), NOW), 2)
        self.assertIsNone(X.detect_offset_hours(FakeMT5(tick_age_s=2 * 86400 + 1800), NOW))   # marche ferme

    def test_closed_positions_from_deals(self):
        mt5 = FakeMT5()
        out = X.build_closed_positions(mt5.history_deals_get(0, 0), lambda pid: mt5.history_orders_get(position=pid), OFF)
        self.assertEqual(len(out), 1)                           # 1002 encore ouverte (partielle), depot ignore
        p = out[0]
        self.assertEqual((p["ticket"], p["side"], p["volume"], p["sl"], p["tp"]), (1001, "buy", 0.1, 1.0837, 1.0876))
        self.assertEqual(p["openTime"], int((NOW - 7200) * 1000))   # heure serveur convertie en UTC
        self.assertAlmostEqual(p["openPrice"], 1.085); self.assertAlmostEqual(p["closePrice"], 1.087)
        self.assertEqual((p["commission"], p["profit"], p["swap"]), (0.7, 20.0, 0.0))

    def test_snapshot_export_format(self):
        cfg = dict(X.DEFAULT_CONFIG)
        data = X.snapshot(FakeMT5(), cfg, X.datetime.fromtimestamp(NOW, X.UTC))
        self.assertEqual((data["app"], data["kind"], data["serverOffsetHours"]), ("desk-forex", "mt5", 2))
        self.assertEqual(data["account"]["mode"], "demo")
        self.assertEqual(len(data["positions"]), 1)
        self.assertEqual(data["open"][0]["ticket"], 1003)
        self.assertEqual(data["open"][0]["openTime"], int((NOW - 600) * 1000))
        self.assertEqual(data["warnings"], [])
        closed = X.snapshot(FakeMT5(tick_age_s=3 * 86400), dict(X.DEFAULT_CONFIG, serverOffsetHours=3), X.datetime.fromtimestamp(NOW, X.UTC))
        self.assertEqual(closed["serverOffsetHours"], 3)
        self.assertTrue(closed["warnings"])

    def test_connect_without_password_by_default(self):
        mt5 = FakeMT5()
        X.connect(mt5, dict(X.DEFAULT_CONFIG))
        self.assertEqual(mt5.calls[0], ("initialize", {}))      # terminal deja ouvert : aucun identifiant

    def test_config_creates_secret_token(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "cfg.json"
            cfg = X.load_config(path)
            self.assertGreaterEqual(len(cfg["token"]), 20)
            self.assertEqual(X.load_config(path)["token"], cfg["token"])

    def test_no_order_functions_in_script(self):
        src = (Path(X.__file__)).read_text(encoding="utf-8")
        code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
        for forbidden in ["order_send", "order_check", "symbol_select", "TRADE_ACTION", "positions_close", "order_calc"]:
            self.assertNotIn(forbidden, re.sub(r'""".*?"""', "", code, flags=re.S), forbidden)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = dict(X.DEFAULT_CONFIG, token="secret-de-test")
        cls.state = {"data": {"app": "desk-forex", "kind": "mt5"}, "at": 9e18, "error": None, "max_age": 300}
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), X.make_handler(cls.state, cls.cfg))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def req(self, method, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        return r.status, dict(r.getheaders()), body

    def test_token_required(self):
        st, _, _ = self.req("GET", "/mt5.json", {"Origin": "https://aliouiliassou19-lang.github.io"})
        self.assertEqual(st, 401)
        st, h, body = self.req("GET", "/mt5.json", {"Origin": "https://aliouiliassou19-lang.github.io", "X-Desk-Token": "secret-de-test"})
        self.assertEqual(st, 200)
        self.assertEqual(h["Access-Control-Allow-Origin"], "https://aliouiliassou19-lang.github.io")
        self.assertEqual(json.loads(body)["kind"], "mt5")

    def test_other_websites_refused(self):
        st, h, _ = self.req("GET", "/mt5.json", {"Origin": "https://site-malveillant.example", "X-Desk-Token": "secret-de-test"})
        self.assertEqual(st, 403)
        self.assertNotIn("Access-Control-Allow-Origin", h)

    def test_preflight_private_network(self):
        st, h, _ = self.req("OPTIONS", "/mt5.json", {"Origin": "https://aliouiliassou19-lang.github.io",
                                                     "Access-Control-Request-Method": "GET", "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(st, 204)
        self.assertEqual(h["Access-Control-Allow-Private-Network"], "true")
        self.assertIn("X-Desk-Token", h["Access-Control-Allow-Headers"])

    def test_ping_without_data(self):
        st, _, body = self.req("GET", "/ping", {"Origin": "http://127.0.0.1:8780"})
        self.assertEqual((st, json.loads(body)["ok"]), (200, True))


if __name__ == "__main__":
    unittest.main()
