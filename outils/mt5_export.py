#!/usr/bin/env python3
"""Desk Forex - export MT5 en LECTURE SEULE.

Lit le terminal MetaTrader 5 ouvert sur ce PC (historique des positions, positions ouvertes,
solde, equite) avec la librairie officielle "MetaTrader5", puis :
  - ecrit un fichier JSON a importer dans le site (onglet Comptes > Import MT5) ;
  - ou, avec --serve, sert ces donnees sur http://127.0.0.1 pour que le site les recupere seul.

CE SCRIPT NE PASSE JAMAIS D'ORDRE : il n'appelle que des fonctions de lecture
(account_info, positions_get, history_deals_get, history_orders_get, symbols_get, symbol_info_tick).

Utilisation :
  python mt5_export.py            export unique dans un fichier JSON
  python mt5_export.py --check    diagnostic (connexion, compte, nombre de positions)
  python mt5_export.py --serve    mini-serveur local, rafraichi toutes les 5 minutes
Options : --interval MINUTES  --port PORT  --days JOURS
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "mt5_config.json"
UTC = timezone.utc
DEFAULT_CONFIG = {
    "_aide": "Fichier local, ignore par Git. Ne le partage pas. Laisse login/serveur/mot de passe vides : "
             "le script lit le terminal MT5 deja ouvert et connecte. Si tu les remplis, utilise uniquement "
             "le mot de passe INVESTISSEUR (lecture seule), jamais le mot de passe principal.",
    "port": 8790,
    "token": "",
    "allowedOrigins": ["https://aliouiliassou19-lang.github.io", "http://127.0.0.1:8780", "http://localhost:8780"],
    "outputFile": "desk-forex-mt5.json",
    "daysOfHistory": 365,
    "serverOffsetHours": None,
    "terminalPath": "",
    "login": "",
    "server": "",
    "investorPassword": "",
}
MODES = {0: "demo", 1: "contest", 2: "real"}
LOCK = threading.Lock()          # la librairie MetaTrader5 n'aime pas les appels simultanes


# ----------------------------------------------------------------------------- configuration
def load_config(path: Path = CONFIG_PATH) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if path.exists():
        try:
            cfg.update(json.loads(path.read_text(encoding="utf-8")))
        except ValueError:
            print(f"ERREUR : {path.name} est illisible (JSON invalide). Corrige-le ou supprime-le.")
            sys.exit(2)
    created = False
    if not cfg.get("token"):
        cfg["token"] = secrets.token_urlsafe(18)       # code secret local partage avec le site
        created = True
    if created or not path.exists():
        path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    return cfg


def save_config(cfg: dict, path: Path = CONFIG_PATH) -> None:
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


# ----------------------------------------------------------------------------- connexion MT5
def connect(mt5, cfg: dict) -> None:
    kwargs = {}
    if cfg.get("terminalPath"):
        kwargs["path"] = cfg["terminalPath"]
    if cfg.get("login") and cfg.get("investorPassword") and cfg.get("server"):
        kwargs.update(login=int(cfg["login"]), password=str(cfg["investorPassword"]), server=str(cfg["server"]))
    if not mt5.initialize(**kwargs):
        raise RuntimeError(f"MetaTrader 5 inaccessible ({mt5.last_error()}). Ouvre MT5, connecte-toi a ton compte, puis relance.")


def detect_offset_hours(mt5, now_s: float | None = None):
    """Decalage (heures) de l'heure du serveur MT5 par rapport a UTC, ou None si le marche est ferme.

    MT5 donne ses heures en heure du serveur. Avec une cotation recente, l'ecart avec l'heure
    UTC reelle est un nombre entier d'heures (a quelques secondes pres).
    """
    now_s = time.time() if now_s is None else now_s
    names = [s.name for s in (mt5.symbols_get() or []) if getattr(s, "visible", True)]
    preferred = [n for n in names if n.upper().startswith(("EURUSD", "GBPUSD", "USDJPY", "XAUUSD"))] or names[:20]
    for name in preferred[:10]:
        tick = mt5.symbol_info_tick(name)
        if not tick or not getattr(tick, "time", 0):
            continue
        diff_h = (tick.time - now_s) / 3600.0
        rounded = round(diff_h)
        if -12 <= rounded <= 14 and abs(diff_h - rounded) * 3600 < 300:   # cotation de moins de 5 min
            return int(rounded)
    return None


def _side(t: int) -> str | None:
    return "buy" if t == 0 else "sell" if t == 1 else None


def build_closed_positions(deals, orders_for_position, offset_h: int):
    """Regroupe les transactions (deals) par position et garde les positions entierement fermees."""
    by_pos: dict[int, list] = {}
    for d in deals or []:
        if getattr(d, "type", None) not in (0, 1) or not getattr(d, "position_id", 0):
            continue                                      # depots, retraits, credits : ignores
        by_pos.setdefault(d.position_id, []).append(d)
    out = []
    to_ms = lambda s: int((s - offset_h * 3600) * 1000)
    for pid, ds in by_pos.items():
        ins = [d for d in ds if d.entry == 0]
        outs = [d for d in ds if d.entry in (1, 2, 3)]
        if not ins or not outs:
            continue
        vin, vout = sum(d.volume for d in ins), sum(d.volume for d in outs)
        if vout + 1e-9 < vin:
            continue                                      # fermeture partielle : encore ouverte
        sl = tp = None
        for o in sorted(orders_for_position(pid) or [], key=lambda o: getattr(o, "time_setup", 0)):
            if getattr(o, "sl", 0) and sl is None:
                sl = o.sl
            if getattr(o, "tp", 0) and tp is None:
                tp = o.tp
        out.append({
            "ticket": pid, "symbol": ins[0].symbol, "side": _side(ins[0].type), "volume": round(vin, 2),
            "openTime": to_ms(min(d.time for d in ins)), "openPrice": sum(d.price * d.volume for d in ins) / vin,
            "closeTime": to_ms(max(d.time for d in outs)), "closePrice": sum(d.price * d.volume for d in outs) / vout,
            "sl": sl, "tp": tp,
            "commission": round(-sum((d.commission or 0) + (getattr(d, "fee", 0) or 0) for d in ds), 2),   # cout positif
            "swap": round(sum(d.swap or 0 for d in ds), 2),
            "profit": round(sum(d.profit or 0 for d in ds), 2),
            "magic": getattr(ins[0], "magic", 0),
        })
    out.sort(key=lambda p: p["closeTime"])
    return out


def build_open_positions(positions, offset_h: int):
    return [{
        "ticket": p.identifier if getattr(p, "identifier", 0) else p.ticket, "symbol": p.symbol, "side": _side(p.type),
        "volume": p.volume, "openTime": int((p.time - offset_h * 3600) * 1000), "openPrice": p.price_open,
        "sl": p.sl or None, "tp": p.tp or None, "profit": round(p.profit, 2), "swap": round(p.swap or 0, 2),
    } for p in positions or []]


def snapshot(mt5, cfg: dict, now: datetime | None = None) -> dict:
    """Lit le terminal (lecture seule) et retourne l'export complet."""
    now = now or datetime.now(UTC)
    warnings = []
    with LOCK:
        acc = mt5.account_info()
        if acc is None:
            raise RuntimeError("MT5 est ouvert mais aucun compte n'est connecte.")
        offset = detect_offset_hours(mt5, now.timestamp())
        if offset is None:
            saved = cfg.get("serverOffsetHours")
            offset = int(saved) if saved is not None else int(cfg.get("lastDetectedOffset", 2))
            warnings.append(f"Marche ferme : decalage du serveur non detecte, {offset} h utilise (reglable dans mt5_config.json).")
        else:
            cfg["lastDetectedOffset"] = offset
        start = now - timedelta(days=int(cfg.get("daysOfHistory", 365)))
        # MT5 attend des dates en heure du serveur : on elargit d'un jour de chaque cote
        deals = mt5.history_deals_get(start - timedelta(days=1), now + timedelta(days=1)) or ()
        closed = build_closed_positions(deals, lambda pid: mt5.history_orders_get(position=pid), offset)
        opened = build_open_positions(mt5.positions_get() or (), offset)
    return {
        "app": "desk-forex", "kind": "mt5", "version": 1,
        "exportedAt": now.isoformat().replace("+00:00", "Z"), "serverOffsetHours": offset,
        "account": {"login": acc.login, "server": acc.server, "company": getattr(acc, "company", ""),
                    "currency": acc.currency, "mode": MODES.get(acc.trade_mode, "?"), "leverage": acc.leverage,
                    "balance": acc.balance, "equity": acc.equity, "margin": acc.margin,
                    "freeMargin": acc.margin_free, "floatingProfit": acc.profit},
        "positions": closed, "open": opened, "warnings": warnings,
    }


# ----------------------------------------------------------------------------- mini-serveur local
def make_handler(state: dict, cfg: dict):
    allowed = set(cfg.get("allowedOrigins") or [])
    token = cfg["token"]

    class Handler(BaseHTTPRequestHandler):
        server_version = "DeskForexMT5/1.0"

        def log_message(self, fmt, *args):   # journal minimal, sans donnees
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

        def _cors(self):
            origin = self.headers.get("Origin")
            if origin and origin in allowed:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "X-Desk-Token")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Private-Network", "true")   # Private Network Access (Chrome)
                self.send_header("Access-Control-Max-Age", "600")

        def _send(self, code, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _origin_ok(self):
            origin = self.headers.get("Origin")
            return origin is None or origin in allowed

        def do_OPTIONS(self):
            if not self._origin_ok():
                return self._send(403, {"error": "origine non autorisee"})
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            if not self._origin_ok():
                return self._send(403, {"error": "origine non autorisee"})
            if self.path.split("?")[0] == "/ping":
                return self._send(200, {"app": "desk-forex", "kind": "mt5-server", "ok": True})
            if self.path.split("?")[0] != "/mt5.json":
                return self._send(404, {"error": "introuvable"})
            if not hmac.compare_digest(self.headers.get("X-Desk-Token", ""), token):
                return self._send(401, {"error": "code secret manquant ou faux"})
            refresh = state.get("refresh")
            if refresh and time.time() - state.get("at", 0) > state.get("max_age", 300):
                refresh()
            if state.get("error"):
                return self._send(503, {"error": state["error"]})
            return self._send(200, state.get("data") or {})

    return Handler


def serve(mt5, cfg: dict, interval_min: float, port: int) -> None:
    state = {"data": None, "at": 0, "error": None, "max_age": interval_min * 60}

    def refresh():
        try:
            state["data"] = snapshot(mt5, cfg)
            state["error"] = None
            save_config(cfg)
        except Exception as exc:                      # le serveur reste en marche, le site affiche l'erreur
            state["error"] = str(exc)
        state["at"] = time.time()
    state["refresh"] = refresh
    refresh()

    def loop():
        while True:
            time.sleep(interval_min * 60)
            refresh()
    threading.Thread(target=loop, daemon=True).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state, cfg))   # ce PC uniquement, pas le Wi-Fi
    print("=" * 70)
    print(" Desk Forex - serveur MT5 local, LECTURE SEULE (aucun ordre)")
    print(f" Adresse : http://127.0.0.1:{port}/mt5.json  (rafraichi toutes les {interval_min:g} min)")
    print(f" Code secret a coller dans le site (onglet Comptes > Import MT5) : {cfg['token']}")
    print(" Arret : Ctrl + C")
    print("=" * 70)
    if state["error"]:
        print("ATTENTION :", state["error"])
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("Arret demande.")


# ----------------------------------------------------------------------------- programme
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Export MT5 en lecture seule pour Desk Forex (aucun ordre).")
    p.add_argument("--serve", action="store_true", help="mini-serveur local pour le site")
    p.add_argument("--check", action="store_true", help="diagnostic de connexion")
    p.add_argument("--interval", type=float, default=5, help="minutes entre deux lectures (--serve)")
    p.add_argument("--port", type=int, default=None, help="port local (defaut : config, 8790)")
    p.add_argument("--days", type=int, default=None, help="jours d'historique (defaut : config, 365)")
    args = p.parse_args(argv)
    cfg = load_config()
    if args.days:
        cfg["daysOfHistory"] = args.days
    try:
        import MetaTrader5 as mt5
    except ImportError:
        print("ERREUR : la librairie MetaTrader5 n'est pas installee. Tape : python -m pip install MetaTrader5")
        return 2
    try:
        connect(mt5, cfg)
    except RuntimeError as exc:
        print("ERREUR :", exc)
        return 3
    try:
        if args.serve:
            serve(mt5, cfg, max(1.0, args.interval), args.port or int(cfg.get("port", 8790)))
            return 0
        data = snapshot(mt5, cfg)
        save_config(cfg)
        acc = data["account"]
        login = str(acc["login"])
        masked = "*" * max(0, len(login) - 3) + login[-3:]
        if args.check:
            print(f"Connexion OK - compte {masked} ({acc['mode']}, {acc['currency']}), decalage serveur {data['serverOffsetHours']} h")
            print(f"Positions fermees lues : {len(data['positions'])} ; positions ouvertes : {len(data['open'])}")
            for w in data["warnings"]:
                print("ATTENTION :", w)
            return 0
        out = HERE / cfg.get("outputFile", "desk-forex-mt5.json")
        out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"Export ecrit : {out}")
        print(f"Compte {masked} ({acc['mode']}) : {len(data['positions'])} positions fermees, {len(data['open'])} ouvertes.")
        for w in data["warnings"]:
            print("ATTENTION :", w)
        print("Importe ce fichier dans le site : onglet Comptes > Import MT5 > Fichier du script.")
        return 0
    except RuntimeError as exc:
        print("ERREUR :", exc)
        return 4
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    sys.exit(main())
