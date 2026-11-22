"""Tests du script des annonces (aucun acces reseau)."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import annonces as A

UTC = timezone.utc
NOW = datetime(2026, 11, 25, 14, 0, tzinfo=UTC)

FEED_JSON = json.dumps([
    {"title": "Core PCE Price Index m/m", "country": "USD", "date": "2026-11-25T08:30:00-05:00",
     "impact": "High", "forecast": "0.3%", "previous": "0.3%"},
    {"title": "Unemployment Claims", "country": "USD", "date": "2026-11-25T08:30:00-05:00",
     "impact": "Medium", "forecast": "201K", "previous": "203K"},
    {"title": "German Flash Services PMI", "country": "EUR", "date": "2026-11-26T03:30:00-05:00",
     "impact": "Medium", "forecast": "52.4", "previous": "51.7"},
    {"title": "Retail Sales", "country": "GBP", "date": "2026-11-26T07:00:00-05:00", "impact": "High"},
    {"title": "Bank Holiday", "country": "USD", "date": "2026-11-27T00:00:00-05:00", "impact": "Holiday"},
    {"title": "Speech", "country": "EUR", "date": "2026-11-27T05:00:00-05:00", "impact": "Low"},
    {"title": "Bad date", "country": "USD", "date": "demain", "impact": "High"},
]).encode("utf-8")

FEED_XML = """<?xml version="1.0" encoding="windows-1252"?>
<weeklyevents>
 <event><title>Core PCE Price Index m/m</title><country>USD</country><date><![CDATA[11-25-2026]]></date>
  <time><![CDATA[1:30pm]]></time><impact><![CDATA[High]]></impact><forecast><![CDATA[0.3%]]></forecast>
  <previous><![CDATA[0.3%]]></previous></event>
 <event><title>ECB President Lagarde Speaks</title><country>EUR</country><date><![CDATA[11-26-2026]]></date>
  <time><![CDATA[Tentative]]></time><impact><![CDATA[High]]></impact><forecast></forecast><previous></previous></event>
 <event><title>Caf\xe9 index</title><country>EUR</country><date><![CDATA[11-26-2026]]></date>
  <time><![CDATA[9:00am]]></time><impact><![CDATA[Medium]]></impact><forecast></forecast><previous></previous></event>
</weeklyevents>""".encode("cp1252")


def loader_for(json_raw=None, xml_raw=None):
    def load(url):
        raw = {A.FF_JSON_URL: json_raw, A.FF_XML_URL: xml_raw}[url]
        if raw is None:
            raise RuntimeError("HTTP 503")
        return raw
    return load


class ParseTests(unittest.TestCase):
    def test_json_filters_usd_eur_high_medium_in_utc(self):
        ev = A.parse_json(FEED_JSON)
        self.assertEqual([(e["currency"], e["impact"]) for e in ev], [("USD", "high"), ("USD", "medium"), ("EUR", "medium")])
        pce = ev[0]
        self.assertEqual(pce["time"], "2026-11-25T13:30:00Z")          # 08:30 heure de New York = 13:30 UTC
        self.assertEqual((pce["forecast"], pce["previous"], pce["actual"]), ("0.3%", "0.3%", ""))
        self.assertEqual(len(pce["id"]), 12)

    def test_xml_times_are_utc_and_untimed_events_skipped(self):
        ev = A.parse_xml(FEED_XML)
        self.assertEqual([e["title"] for e in ev], ["Core PCE Price Index m/m", "Café index"])
        self.assertEqual(ev[0]["time"], "2026-11-25T13:30:00Z")
        self.assertEqual(ev[0]["id"], A.parse_json(FEED_JSON)[0]["id"])  # meme annonce, meme identifiant

    def test_empty_or_bad_feeds_raise(self):
        for raw, parser in ((b"[]", A.parse_json), (b"<html>404</html>", A.parse_json),
                            (b"<weeklyevents></weeklyevents>", A.parse_xml), (b"<html>", A.parse_xml)):
            with self.assertRaises(Exception):
                parser(raw)


class RunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, name):
        return json.loads((self.out / name).read_text(encoding="utf-8"))

    def test_json_source_writes_week_and_history(self):
        r = A.run(self.out, NOW, loader_for(FEED_JSON, FEED_XML))
        self.assertTrue(r["ok"])
        self.assertEqual(r["source"], "forexfactory-json")
        week = self.read("annonces.json")
        self.assertEqual(len(week["events"]), 3)
        self.assertIsNone(week["error"])
        hist = self.read("historique-annonces.json")
        self.assertEqual([e["title"] for e in hist["events"]], ["Unemployment Claims", "Core PCE Price Index m/m"])

    def test_falls_back_to_xml(self):
        r = A.run(self.out, NOW, loader_for(None, FEED_XML))
        self.assertTrue(r["ok"])
        self.assertEqual(r["source"], "forexfactory-xml")
        self.assertIn("HTTP 503", self.read("annonces.json")["error"])

    def test_both_sources_fail_keeps_last_good_data(self):
        A.run(self.out, NOW, loader_for(FEED_JSON))
        r = A.run(self.out, NOW + timedelta(hours=3), loader_for(None, b"<html>"))
        self.assertFalse(r["ok"])
        week = self.read("annonces.json")
        self.assertFalse(week["ok"])
        self.assertEqual(len(week["events"]), 3)
        self.assertEqual(week["fetchedAt"], "2026-11-25T14:00:00Z")    # l'age des donnees reste visible

    def test_no_rewrite_when_nothing_changed_until_refresh(self):
        A.run(self.out, NOW, loader_for(FEED_JSON))
        r = A.run(self.out, NOW + timedelta(hours=3), loader_for(FEED_JSON))
        self.assertEqual(r["wrote"], [])                                # pas de commit inutile toutes les 3 h
        r = A.run(self.out, NOW + timedelta(hours=12), loader_for(FEED_JSON))
        self.assertIn("annonces.json", r["wrote"])

    def test_keeps_actual_and_comment_and_history_survives_new_week(self):
        A.run(self.out, NOW, loader_for(FEED_JSON))
        week = self.read("annonces.json")
        week["events"][0]["actual"] = "0.4%"
        week["events"][0]["comment"] = {"by": "regles", "text": "x"}
        (self.out / "annonces.json").write_text(json.dumps(week), encoding="utf-8")
        A.run(self.out, NOW + timedelta(hours=1), loader_for(FEED_JSON))
        self.assertEqual(self.read("annonces.json")["events"][0]["actual"], "0.4%")
        pce = [e for e in self.read("historique-annonces.json")["events"] if e["title"].startswith("Core PCE")][0]
        self.assertEqual(pce["actual"], "0.4%")
        # la semaine suivante, le flux ne contient plus ces annonces : l'historique les garde
        next_week = json.dumps([{"title": "NFP", "country": "USD", "date": "2026-12-04T08:30:00-05:00", "impact": "High"}]).encode()
        A.run(self.out, NOW + timedelta(days=10), loader_for(next_week))
        titles = [e["title"] for e in self.read("historique-annonces.json")["events"]]
        self.assertEqual(titles, ["NFP", "German Flash Services PMI", "Unemployment Claims", "Core PCE Price Index m/m"])
        self.assertEqual([e["title"] for e in self.read("annonces.json")["events"]], ["NFP"])

    def test_history_forgets_very_old_events(self):
        A.run(self.out, NOW, loader_for(FEED_JSON))
        later = NOW + timedelta(days=A.HISTORY_DAYS + 2)
        A.run(self.out, later, loader_for(b'[{"title":"X","country":"JPY","date":"2028-01-01T00:00:00Z","impact":"Low"}]'))
        self.assertEqual(self.read("historique-annonces.json")["events"], [])


if __name__ == "__main__":
    unittest.main()
