"""Annonces economiques automatiques pour Desk Forex (lecture seule, educatif).

Telecharge le calendrier de la semaine (ForexFactory, flux public gratuit), garde
USD et EUR a impact fort ou moyen, et ecrit :
  - data/annonces.json             : les annonces de la semaine ;
  - data/historique-annonces.json  : les annonces passees (prevision, precedent, reel).

Source principale : le flux JSON. Secours : le flux XML du meme fournisseur.
Si les deux echouent, les dernieres bonnes donnees sont gardees et le fichier
indique l'erreur (le site affiche alors l'age des donnees).

Chaque annonce forte recoit un commentaire educatif (outils/commentaires.py) :
Claude si la cle ANTHROPIC_API_KEY est presente (secret GitHub), sinon par regles.

Le flux ne donne pas le chiffre reel : le champ "actual" reste vide ici ; il
est garde s'il a ete rempli par ailleurs.

Ce script ne passe aucun ordre et ne contient aucune cle.
Usage : python outils/annonces.py --out data
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

import commentaires

UTC = timezone.utc
FF_JSON_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
FF_XML_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml"
USER_AGENT = "desk-forex-annonces/1.0"
CURRENCIES = ("USD", "EUR")
IMPACTS = {"High": "high", "Medium": "medium"}
MAX_BYTES = 2_000_000          # un flux normal fait ~25 Ko
HISTORY_DAYS = 400             # on garde un peu plus d'un an d'historique
REFRESH_HOURS = 12             # sans changement, on reecrit au plus toutes les 12 h
SCHEMA = 1


# ------------------------------------------------------------------ lecture des flux
def fetch(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (URL fixe en https)
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        raw = r.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise RuntimeError("reponse trop grande")
    return raw


def iso_z(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(UTC)


def clean(v, n: int) -> str:
    return " ".join(str(v if v is not None else "").split())[:n]


def event_id(currency: str, title: str, time_iso: str) -> str:
    return hashlib.sha1(f"{currency}|{title.lower()}|{time_iso}".encode("utf-8")).hexdigest()[:12]


def normalize(title, country, when: datetime, impact, forecast, previous):
    """Un evenement au format du site, ou None s'il est hors filtre."""
    cur = clean(country, 3).upper()
    imp = IMPACTS.get(clean(impact, 10))
    t = clean(title, 100)
    if cur not in CURRENCIES or not imp or not t:
        return None
    time_iso = iso_z(when)
    return {"id": event_id(cur, t, time_iso), "time": time_iso, "currency": cur, "title": t,
            "impact": imp, "forecast": clean(forecast, 20), "previous": clean(previous, 20), "actual": ""}


def parse_json(raw: bytes) -> list[dict]:
    data = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(data, list) or not data:
        raise ValueError("flux JSON vide ou inattendu")
    out = []
    for ev in data:
        if not isinstance(ev, dict):
            continue
        try:
            when = parse_iso(ev["date"])
        except (KeyError, ValueError, TypeError):
            continue
        n = normalize(ev.get("title"), ev.get("country"), when, ev.get("impact"), ev.get("forecast"), ev.get("previous"))
        if n:
            out.append(n)
    return sorted(out, key=lambda e: (e["time"], e["currency"], e["title"]))


def parse_xml_time(date_s: str, time_s: str):
    """Le flux XML donne la date MM-JJ-AAAA et l'heure en UTC (ex. 1:30pm).
    Les annonces sans heure precise (All Day, Tentative...) sont ignorees."""
    try:
        d = datetime.strptime(date_s.strip(), "%m-%d-%Y")
        t = datetime.strptime(time_s.strip().lower(), "%I:%M%p")
    except ValueError:
        return None
    return d.replace(hour=t.hour, minute=t.minute, tzinfo=UTC)


def parse_xml(raw: bytes) -> list[dict]:
    root = ET.fromstring(raw)
    events = root.findall("event")
    if not events:
        raise ValueError("flux XML vide ou inattendu")
    out = []
    for ev in events:
        g = lambda k: (ev.findtext(k) or "").strip()  # noqa: E731
        when = parse_xml_time(g("date"), g("time"))
        if when is None:
            continue
        n = normalize(g("title"), g("country"), when, g("impact"), g("forecast"), g("previous"))
        if n:
            out.append(n)
    return sorted(out, key=lambda e: (e["time"], e["currency"], e["title"]))


SOURCES = (
    ("forexfactory-json", FF_JSON_URL, parse_json),
    ("forexfactory-xml", FF_XML_URL, parse_xml),
)


def read_sources(loader=fetch, sources=SOURCES):
    """Essaie chaque source dans l'ordre. Renvoie (nom, evenements, erreurs)."""
    errors = []
    for name, url, parser in sources:
        try:
            return name, parser(loader(url)), errors
        except Exception as exc:  # noqa: BLE001 (on garde le message, on passe a la source suivante)
            errors.append(f"{name} : {clean(exc, 160) or type(exc).__name__}")
    return None, None, errors


# ------------------------------------------------------------------ fusion et historique
KEEP_FIELDS = ("actual", "comment")   # renseignes par ailleurs : on ne les perd pas


def carry_over(new_events: list[dict], old_events: list[dict]) -> list[dict]:
    old = {e.get("id"): e for e in old_events if isinstance(e, dict)}
    out = []
    for e in new_events:
        e = dict(e)
        prev = old.get(e["id"])
        if prev:
            for k in KEEP_FIELDS:
                if prev.get(k) and not e.get(k):
                    e[k] = prev[k]
        out.append(e)
    return out


def update_history(history: list[dict], events: list[dict], now: datetime) -> list[dict]:
    """Ajoute les annonces deja passees ; met a jour prevision/precedent ; oublie au-dela d'HISTORY_DAYS."""
    by_id = {e["id"]: dict(e) for e in history if isinstance(e, dict) and e.get("id") and e.get("time")}
    for e in events:
        if parse_iso(e["time"]) > now:
            continue
        cur = by_id.get(e["id"])
        if cur is None:
            by_id[e["id"]] = dict(e)
        else:
            for k in ("forecast", "previous", "impact", "title"):
                if e.get(k):
                    cur[k] = e[k]
            for k in KEEP_FIELDS:
                if e.get(k) and not cur.get(k):
                    cur[k] = e[k]
    limit = now - timedelta(days=HISTORY_DAYS)
    out = [e for e in by_id.values() if parse_iso(e["time"]) >= limit]
    return sorted(out, key=lambda e: (e["time"], e["currency"], e["title"]), reverse=True)


# ------------------------------------------------------------------ fichiers
def load_doc(path: Path) -> dict:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def dump(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def needs_write(old: dict, new: dict, now: datetime, keys: tuple) -> bool:
    if any(old.get(k) != new.get(k) for k in keys):
        return True
    try:
        return now - parse_iso(old.get("checkedAt", "")) >= timedelta(hours=REFRESH_HOURS)
    except ValueError:
        return True


def run(out_dir: Path, now: datetime, loader=fetch, sources=SOURCES, client=None) -> dict:
    """Met a jour les deux fichiers. Renvoie un resume (pour le journal du workflow)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    week_path, hist_path = out_dir / "annonces.json", out_dir / "historique-annonces.json"
    old_week, old_hist = load_doc(week_path), load_doc(hist_path)
    old_events = old_week.get("events") if isinstance(old_week.get("events"), list) else []
    old_history = old_hist.get("events") if isinstance(old_hist.get("events"), list) else []

    source, events, errors = read_sources(loader, sources)
    ok = events is not None
    if ok:
        events = carry_over(events, old_events)
        fetched_at = iso_z(now)
    else:                                   # les deux sources ont echoue : on garde l'existant
        events = old_events
        source = old_week.get("source")
        fetched_at = old_week.get("fetchedAt")
    notes = commentaires.annotate(events, now, client)

    week = {"schema": SCHEMA, "ok": ok, "source": source, "fetchedAt": fetched_at, "checkedAt": iso_z(now),
            "error": " ; ".join(errors) or None,
            "currencies": list(CURRENCIES), "impacts": sorted(IMPACTS.values()), "events": events}
    # les anciennes annonces d'abord (une semaine qui change ne perd rien), puis les nouvelles (plus a jour)
    history = update_history(update_history(old_history, old_events, now), events, now)
    hist = {"schema": SCHEMA, "checkedAt": iso_z(now), "events": history}

    wrote = []
    if needs_write(old_week, week, now, ("ok", "source", "error", "events", "schema")):
        week_path.write_text(dump(week), encoding="utf-8", newline="\n")
        wrote.append(week_path.name)
    if needs_write(old_hist, hist, now, ("events", "schema")):
        hist_path.write_text(dump(hist), encoding="utf-8", newline="\n")
        wrote.append(hist_path.name)
    return {"ok": ok, "source": source, "events": len(events), "high": sum(e["impact"] == "high" for e in events),
            "history": len(history), "errors": errors, "wrote": wrote, "comments": notes}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Annonces economiques USD/EUR (lecture seule).")
    p.add_argument("--out", default="data", help="dossier de sortie (defaut : data)")
    p.add_argument("--json-file", help="lire le flux JSON depuis un fichier (test hors ligne)")
    p.add_argument("--xml-file", help="lire le flux XML depuis un fichier (test hors ligne)")
    p.add_argument("--now", help="heure de reference UTC, ex. 2026-11-25T14:00:00Z (test)")
    a = p.parse_args(argv)
    now = parse_iso(a.now) if a.now else datetime.now(UTC)
    loader, sources = fetch, SOURCES
    if a.json_file or a.xml_file:
        files = {FF_JSON_URL: a.json_file, FF_XML_URL: a.xml_file}

        def loader(url):  # noqa: F811
            if not files.get(url):
                raise RuntimeError("pas de fichier fourni")
            return Path(files[url]).read_bytes()
    client, why = commentaires.make_client()
    if why:
        print("Commentaires :", why)
    r = run(Path(a.out), now, loader, sources, client)
    print(f"Source : {r['source'] or 'aucune'} | annonces USD/EUR : {r['events']} (dont {r['high']} fortes) | "
          f"historique : {r['history']} | fichiers ecrits : {', '.join(r['wrote']) or 'aucun (rien de neuf)'}")
    c = r["comments"]
    print(f"Commentaires : {c['claude']} par Claude, {c['regles']} par regles, {c['gardes']} deja faits")
    for e in c["erreurs"]:
        print("Commentaire IA non obtenu (regles utilisees) :", e)
    for e in r["errors"]:
        print("Avertissement :", e)
    if not r["ok"]:
        print("Les deux sources ont echoue : les dernieres donnees sont gardees.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
