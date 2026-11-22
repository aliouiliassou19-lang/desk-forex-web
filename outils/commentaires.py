"""Commentaires educatifs des annonces fortes (Desk Forex).

Pour chaque annonce a fort impact : ce que l'annonce mesure, l'effet probable sur
l'or et l'EUR/USD si le chiffre sort au-dessus ou en dessous de la prevision, et
la prudence (pas de trade 15 min avant et apres).

- Avec la cle ANTHROPIC_API_KEY (secret GitHub, jamais dans le code) : Claude
  ecrit le commentaire, une seule fois par annonce (il est garde ensuite).
- Sans cle, ou si l'appel echoue : un commentaire simple par regles.

Educatif uniquement : jamais de conseil d'achat ou de vente.
Chaque annonce recoit aussi "sens" (+1 : un chiffre plus haut est plutot bon pour
la devise ; -1 : plutot mauvais ; 0 : pas de chiffre a comparer), que le site
utilise pour lire « chiffre reel vs prevision ».
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
BENIN = timezone(timedelta(hours=1))
MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_CALLS = 8                 # au plus 8 appels par passage (cout maitrise)
FIELDS = ("mesure", "si_superieur", "si_inferieur", "prudence")

# mot-cle (minuscules) -> (ce que l'annonce mesure, sens). Le premier qui correspond gagne.
INDICATORS = (
    (("non-farm", "nonfarm", "nfp"), "le nombre d'emplois créés le mois dernier (hors agriculture)", 1),
    (("unemployment claims", "jobless claims"), "les nouvelles inscriptions au chômage de la semaine", -1),
    (("unemployment rate",), "le taux de chômage", -1),
    (("average hourly earnings", "wage"), "la hausse des salaires", 1),
    (("adp",), "les créations d'emplois dans le privé (estimation ADP)", 1),
    (("jolts", "job openings"), "le nombre d'offres d'emploi", 1),
    (("gdp price",), "la hausse des prix dans l'ensemble de l'économie (déflateur du PIB)", 1),
    (("pce",), "l'inflation des dépenses des ménages (l'indice préféré de la Fed)", 1),
    (("cpi", "inflation"), "l'inflation des prix à la consommation", 1),
    (("ppi",), "l'inflation des prix à la production", 1),
    (("gdp",), "la croissance de l'économie (produit intérieur brut)", 1),
    (("retail sales",), "les ventes au détail, donc les dépenses des ménages", 1),
    (("pmi", "ism"), "l'activité des entreprises (au-dessus de 50 : l'activité progresse)", 1),
    (("consumer confidence", "sentiment"), "le moral des consommateurs", 1),
    (("ifo", "zew"), "le moral des entreprises et des investisseurs allemands", 1),
    (("durable goods",), "les commandes de biens durables (machines, voitures...)", 1),
    (("industrial production",), "la production de l'industrie", 1),
    (("building permits", "housing starts", "home sales"), "l'activité du marché immobilier", 1),
    (("funds rate", "refinancing rate", "deposit facility", "rate decision", "interest rate"),
     "la décision sur le taux directeur de la banque centrale", 1),
    (("speaks", "testifies", "press conference", "minutes", "statement", "fomc", "monetary policy"),
     "un discours ou un compte rendu de banque centrale (pas de chiffre : le marché réagit au ton)", 0),
)

BANNED = re.compile(r"\b(ach[eè]te[rz]?|achetez|vends|vendez|vendre|prends? (une )?position|ouvre (un|une) (achat|vente)|buy|sell)\b"
                    r"|(?<!pas )(?<!n'est )(?<!jamais )(?<!rien de )garanti|(?<!n'est )(?<!jamais )(?<!pas )sans risque|gain assur", re.I)
# « rien n'est garanti », « aucun trade n'est sans risque »... restent permis (phrases de prudence)


def classify(title: str):
    t = title.lower()
    for keys, measure, sens in INDICATORS:
        if any(k in t for k in keys):
            if "core" in t and sens:
                measure += " — version « de base », sans l'alimentation ni l'énergie"
            return measure, sens
    return "un indicateur économique", 0


def benin_time(time_iso: str) -> str:
    dt = datetime.fromisoformat(time_iso.replace("Z", "+00:00")).astimezone(BENIN)
    return f"{dt.hour:02d}h{dt.minute:02d}"


def prudence_text(ev) -> str:
    return (f"Évite d'ouvrir un trade de 15 min avant à 15 min après l'annonce ({benin_time(ev['time'])}, heure du Bénin) : "
            "les prix peuvent bouger très vite et le spread s'élargir. Ces effets sont des tendances fréquentes, pas des certitudes.")


def rules_comment(ev, now: datetime) -> dict:
    measure, sens = classify(ev["title"])
    usd = ev["currency"] == "USD"
    who = "le dollar" if usd else "l'euro"
    good = (f"plutôt bon pour {who}. " + ("L'EUR/USD a tendance à baisser et l'or est souvent sous pression."
                                         if usd else "L'EUR/USD a tendance à monter ; l'effet sur l'or est en général faible."))
    bad = (f"plutôt mauvais pour {who}. " + ("L'EUR/USD a tendance à monter et l'or est souvent soutenu."
                                            if usd else "L'EUR/USD a tendance à baisser ; l'effet sur l'or est en général faible."))
    if sens == 0:
        sup = inf = ("Pas de chiffre à comparer : le marché réagit au ton (plus ferme ou plus prudent sur les taux). "
                     "Les mouvements peuvent être brusques dans les deux sens.")
    else:
        sup = "Chiffre plus haut que prévu : " + (good if sens > 0 else bad)
        inf = "Chiffre plus bas que prévu : " + (bad if sens > 0 else good)
    return {"by": "regles", "at": now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "mesure": f"Cette annonce mesure {measure}.", "si_superieur": sup, "si_inferieur": inf,
            "prudence": prudence_text(ev)}


# ------------------------------------------------------------------ Claude
SYSTEM = (
    "Tu écris pour un site éducatif de forex destiné à un trader débutant francophone (Bénin). "
    "Pour une annonce économique, tu écris quatre champs très courts, en français simple, en tutoyant, sans jargon "
    "(si un mot technique est inévitable, explique-le en quelques mots) :\n"
    "- mesure : ce que l'annonce mesure, en une phrase ;\n"
    "- si_superieur : l'effet probable si le chiffre sort au-dessus de la prévision, sur la devise de l'annonce, "
    "sur l'EUR/USD et sur l'or (XAU/USD), en une ou deux phrases ;\n"
    "- si_inferieur : la même chose si le chiffre sort en dessous de la prévision ;\n"
    "- prudence : rappelle de ne pas trader de 15 min avant à 15 min après l'annonce (cite l'heure du Bénin donnée) "
    "et que ces effets sont des tendances fréquentes, pas des certitudes.\n"
    "Règles : contenu éducatif uniquement. Ne dis jamais d'acheter, de vendre ou de prendre position, "
    "ne promets aucun gain, reste prudent (« a tendance à », « souvent »). Pour un discours sans chiffre, "
    "explique que le marché réagit au ton. Chaque champ fait au plus 300 caractères."
)

SCHEMA = {
    "type": "object",
    "properties": {k: {"type": "string"} for k in FIELDS},
    "required": list(FIELDS),
    "additionalProperties": False,
}


def user_prompt(ev) -> str:
    measure, sens = classify(ev["title"])
    hint = {1: "un chiffre plus haut est en général plutôt bon pour la devise",
            -1: "un chiffre plus haut est en général plutôt mauvais pour la devise (ex. chômage)",
            0: "pas de chiffre à comparer ou sens incertain"}[sens]
    return (f"Annonce : {ev['title']}\nDevise : {ev['currency']}\nImpact : fort\n"
            f"Heure du Bénin : {benin_time(ev['time'])}\n"
            f"Prévision : {ev.get('forecast') or 'non communiquée'}\nPrécédent : {ev.get('previous') or 'non communiqué'}\n"
            f"Repère (indicatif) : {hint}.")


def validate(data) -> dict | None:
    if not isinstance(data, dict):
        return None
    out = {}
    for k in FIELDS:
        v = " ".join(str(data.get(k, "")).split())
        if not (10 <= len(v) <= 400) or BANNED.search(v):
            return None
        out[k] = v
    return out


def ask_claude(client, ev):
    """Renvoie (champs valides ou None, message d'erreur ou None)."""
    kwargs = dict(
        model=MODEL, max_tokens=4000, system=SYSTEM,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": user_prompt(ev)}],
    )
    try:
        try:   # repli cote serveur sur un autre modele en cas de refus (beta)
            resp = client.beta.messages.create(betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
        except TypeError:       # version du SDK sans ce parametre : appel normal
            resp = client.messages.create(**kwargs)
    except Exception as exc:  # noqa: BLE001 (reseau, quota, cle invalide... : on passe aux regles)
        return None, f"{type(exc).__name__} : {str(exc)[:160]}"
    if getattr(resp, "stop_reason", None) == "refusal":
        return None, "refus du modèle"
    text = next((b.text for b in getattr(resp, "content", []) if getattr(b, "type", "") == "text"), "")
    try:
        fields = validate(json.loads(text))
    except ValueError:
        fields = None
    if not fields:
        return None, "réponse invalide ou contraire aux règles éducatives"
    if "15" not in fields["prudence"]:
        fields["prudence"] = prudence_text(ev)
    return fields, None


def make_client():
    """Client Claude si la cle est presente (secret GitHub), sinon None."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None, "pas de clé ANTHROPIC_API_KEY : commentaires par règles"
    try:
        import anthropic  # import ici : le script marche aussi sans le SDK
    except ImportError:
        return None, "SDK anthropic absent : commentaires par règles"
    return anthropic.Anthropic(timeout=60.0, max_retries=2), None


def annotate(events: list[dict], now: datetime, client=None) -> dict:
    """Ajoute "sens" a chaque annonce et un commentaire aux annonces fortes.
    Un commentaire Claude deja present est garde ; un commentaire par regles est
    remplace par Claude quand la cle est disponible."""
    stats = {"claude": 0, "regles": 0, "gardes": 0, "erreurs": []}
    calls = 0
    for ev in events:
        ev["sens"] = classify(ev["title"])[1]
        if ev.get("impact") != "high":
            continue
        cur = ev.get("comment") if isinstance(ev.get("comment"), dict) else None
        if cur and (cur.get("by") == "claude" or client is None):
            stats["gardes"] += 1
            continue
        if client is not None and calls < MAX_CALLS:
            calls += 1
            fields, err = ask_claude(client, ev)
            if fields:
                ev["comment"] = {"by": "claude", "model": MODEL, "at": now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), **fields}
                stats["claude"] += 1
                continue
            stats["erreurs"].append(f"{ev['title']} : {err}")
        if cur:
            stats["gardes"] += 1
        else:
            ev["comment"] = rules_comment(ev, now)
            stats["regles"] += 1
    return stats
