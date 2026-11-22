"""Tests des commentaires (faux client : aucun appel reel a l'API, aucune cle)."""
import json
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace as NS
from unittest import mock

import commentaires as C

NOW = datetime(2026, 11, 22, 19, 0, tzinfo=timezone.utc)


def ev(title, cur="USD", impact="high", time="2026-11-25T13:30:00Z", **kw):
    return {"id": title[:12], "time": time, "currency": cur, "title": title, "impact": impact,
            "forecast": "0.3%", "previous": "0.3%", "actual": "", **kw}


GOOD = {"mesure": "Cet indice mesure la hausse des prix payés par les ménages.",
        "si_superieur": "Au-dessus de la prévision : le dollar a tendance à monter, l'EUR/USD à baisser et l'or souvent à reculer.",
        "si_inferieur": "En dessous : le dollar a tendance à baisser, l'EUR/USD à monter et l'or est souvent soutenu.",
        "prudence": "Ne trade pas de 15 min avant à 15 min après 14h30 (heure du Bénin) : ce sont des tendances, pas des certitudes."}


class FakeClient:
    """Imite client.beta.messages.create ; enregistre les appels."""
    def __init__(self, payload=GOOD, stop="end_turn", fail=None):
        self.calls = []
        self.payload, self.stop, self.fail = payload, stop, fail
        self.beta = NS(messages=NS(create=self._create))

    def _create(self, **kw):
        self.calls.append(kw)
        if self.fail:
            raise self.fail
        text = self.payload if isinstance(self.payload, str) else json.dumps(self.payload, ensure_ascii=False)
        return NS(stop_reason=self.stop, content=[NS(type="thinking", thinking=""), NS(type="text", text=text)])


class RulesTests(unittest.TestCase):
    def test_classify_direction(self):
        self.assertEqual(C.classify("Core PCE Price Index m/m")[1], 1)
        self.assertIn("de base", C.classify("Core PCE Price Index m/m")[0])
        self.assertEqual(C.classify("Unemployment Claims")[1], -1)
        self.assertEqual(C.classify("Prelim GDP Price Index q/q")[0][:22], "la hausse des prix dan")
        self.assertEqual(C.classify("ECB President Lagarde Speaks")[1], 0)
        self.assertEqual(C.classify("Mystery Index"), ("un indicateur économique", 0))

    def test_rules_comment_usd_eur_and_inverted(self):
        c = C.rules_comment(ev("Prelim GDP q/q"), NOW)
        self.assertEqual(c["by"], "regles")
        self.assertIn("plutôt bon pour le dollar", c["si_superieur"])
        self.assertIn("or est souvent sous pression", c["si_superieur"])
        self.assertIn("15 min", c["prudence"])
        self.assertIn("14h30", c["prudence"])                          # 13:30 UTC = 14h30 au Bénin
        self.assertIn("plutôt mauvais pour le dollar", C.rules_comment(ev("Unemployment Claims"), NOW)["si_superieur"])
        self.assertIn("L'EUR/USD a tendance à monter", C.rules_comment(ev("German ifo Business Climate", "EUR"), NOW)["si_superieur"])
        self.assertIn("ton", C.rules_comment(ev("Fed Chair Speaks"), NOW)["si_superieur"])

    def test_no_trading_advice_in_rules(self):
        for t in ("Non-Farm Employment Change", "Unemployment Rate", "CPI y/y", "Fed Chair Speaks"):
            for cur in ("USD", "EUR"):
                c = C.rules_comment(ev(t, cur), NOW)
                for k in C.FIELDS:
                    self.assertIsNone(C.BANNED.search(c[k]), (t, k, c[k]))


class AnnotateTests(unittest.TestCase):
    def test_without_client_uses_rules_and_only_high(self):
        evs = [ev("Core PCE Price Index m/m"), ev("Flash Services PMI", impact="medium")]
        s = C.annotate(evs, NOW, None)
        self.assertEqual((s["claude"], s["regles"]), (0, 1))
        self.assertEqual(evs[0]["comment"]["by"], "regles")
        self.assertNotIn("comment", evs[1])
        self.assertEqual([e["sens"] for e in evs], [1, 1])

    def test_claude_comment_and_request_shape(self):
        cl = FakeClient()
        evs = [ev("Core PCE Price Index m/m")]
        s = C.annotate(evs, NOW, cl)
        self.assertEqual(s["claude"], 1)
        c = evs[0]["comment"]
        self.assertEqual((c["by"], c["model"]), ("claude", "claude-opus-5-5"))
        self.assertEqual(c["mesure"], GOOD["mesure"])
        kw = cl.calls[0]
        self.assertEqual(kw["model"], "claude-opus-5-5")
        self.assertEqual(kw["output_config"]["format"]["type"], "json_schema")
        self.assertEqual(kw["fallbacks"], "default")
        self.assertIn("14h30", kw["messages"][0]["content"])
        self.assertNotIn("api_key", json.dumps(kw, default=str).lower())

    def test_claude_comment_kept_and_rules_upgraded(self):
        cl = FakeClient()
        evs = [ev("A CPI m/m", comment={"by": "claude", "mesure": "x"}), ev("B GDP q/q", comment=C.rules_comment(ev("B GDP q/q"), NOW))]
        s = C.annotate(evs, NOW, cl)
        self.assertEqual(len(cl.calls), 1)                              # pas de second paiement pour A
        self.assertEqual((s["gardes"], s["claude"]), (1, 1))
        self.assertEqual(evs[1]["comment"]["by"], "claude")
        evs2 = [ev("B GDP q/q", comment=C.rules_comment(ev("B GDP q/q"), NOW))]
        C.annotate(evs2, NOW, None)                                     # sans cle : on garde les regles
        self.assertEqual(evs2[0]["comment"]["by"], "regles")

    def test_bad_answers_fall_back_to_rules(self):
        cases = [FakeClient(stop="refusal"), FakeClient(payload="pas du json"),
                 FakeClient(payload={**GOOD, "si_superieur": "Achète l'or tout de suite, c'est garanti."}),
                 FakeClient(payload={"mesure": "trop court"}), FakeClient(fail=RuntimeError("401 cle invalide"))]
        for cl in cases:
            evs = [ev("Core PCE Price Index m/m")]
            s = C.annotate(evs, NOW, cl)
            self.assertEqual(evs[0]["comment"]["by"], "regles")
            self.assertEqual(len(s["erreurs"]), 1)

    def test_prudence_without_15_minutes_is_replaced(self):
        cl = FakeClient(payload={**GOOD, "prudence": "Sois prudent autour de cette annonce importante."})
        evs = [ev("Core PCE Price Index m/m")]
        C.annotate(evs, NOW, cl)
        self.assertIn("15 min avant à 15 min après", evs[0]["comment"]["prudence"])

    def test_call_limit_per_run(self):
        cl = FakeClient()
        evs = [ev(f"CPI {i}", time=f"2026-11-2{i % 7}T13:30:00Z") for i in range(12)]
        s = C.annotate(evs, NOW, cl)
        self.assertEqual(len(cl.calls), C.MAX_CALLS)
        self.assertEqual((s["claude"], s["regles"]), (C.MAX_CALLS, 12 - C.MAX_CALLS))

    def test_old_sdk_without_fallbacks_param(self):
        cl = FakeClient()
        def old_beta(**kw):
            if "fallbacks" in kw:
                raise TypeError("unexpected keyword argument 'fallbacks'")
        cl.beta = NS(messages=NS(create=old_beta))
        cl.messages = NS(create=lambda **kw: NS(stop_reason="end_turn", content=[NS(type="text", text=json.dumps(GOOD))]))
        evs = [ev("Core PCE Price Index m/m")]
        C.annotate(evs, NOW, cl)
        self.assertEqual(evs[0]["comment"]["by"], "claude")

    def test_make_client_without_key(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": ""}):
            client, why = C.make_client()
        self.assertIsNone(client)
        self.assertIn("règles", why)


if __name__ == "__main__":
    unittest.main()
