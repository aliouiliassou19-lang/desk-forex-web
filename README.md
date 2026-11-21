# Desk Forex (web) : lecture seule, aucun ordre

Site statique et éducatif qui surveille **EUR/USD** et **XAU/USD (or)** avec **ta propre clé gratuite
Twelve Data**. Il ne passe aucun ordre, ne se connecte à aucun courtier et ne donne aucun conseil.

## Principe : chacun utilise sa propre clé
- Le site n'a **aucune clé** : chaque visiteur colle sa clé gratuite Twelve Data
  ([création](https://twelvedata.com/register), offre Basic, sans carte bancaire).
- La clé reste **dans le navigateur du visiteur** (sessionStorage, ou localStorage s'il coche
  « se souvenir »). Elle n'est envoyée qu'à `api.twelvedata.com`, dans l'en-tête `Authorization`.
- Chacun consomme ses propres crédits (8 par minute, 800 par jour). Cela respecte les conditions
  de la clé gratuite : pas de partage de clé ni de redistribution des données.

## Fonctions
| Onglet | Contenu |
|---|---|
| Moniteur | Un relevé par minute (2 crédits), décisions **WATCH / REJECT / DATA_MISSING** avec les mêmes règles que `monitor.py`, notifications du navigateur, export CSV, démo synthétique, **sessions de marché** (Sydney, Tokyo, Londres, New York, chevauchements, rollover), **alertes de prix** |
| Analyse | 12 paires (majeures, croisées, or, argent) : graphique en chandeliers H1/H4/D1 dessiné sans bibliothèque, EMA 20/50/200, RSI, ATR, efficacité, biais multi-unités, lecture (étirement, Bollinger, surachat/survente, régime), supports et résistances (sommets/creux D1 et H4, pivots, Fibonacci, chiffres ronds), plages 5/20/60 jours. 3 crédits par analyse, résultat gardé 5 min. Un niveau touché crée une alerte |
| Fondamental | Taux directeur, inflation sur 1 an et chômage aux États-Unis et en zone euro, à partir de **sources officielles datées** (Fed de New York, BLS, BCE, Eurostat), avec une étiquette « ancien » si la donnée est vieille ; écart de taux, taux réels, annonces à venir, liens vers les autres banques centrales et l'actualité |
| Synthèse | Lecture automatique du jour avec les données du visiteur et des règles explicites : bilan fondamental (écart de taux, taux réels, inflation par rapport à la cible), agenda des 24 h, amplitude habituelle (ATR D1), régime, scénarios conditionnels sur les niveaux les plus proches, moment de la journée, niveau de prudence. **Aucune prédiction de direction, aucun signal** |
| Plan | Plan de trade : entrée, stop (prix ou ATR), objectifs en R, spread compris, valeur du pip convertie en USD, taille arrondie vers le bas, vérifications et verdict **OK / À REVOIR / NON** ; **pré-test d'une idée** (coût d'un trade, taux de réussite minimal, nombre de trades pour prouver un avantage) ; taille de position rapide |
| Annonces | Fenêtres d'annonces saisies en heure locale, enregistrées en UTC, import CSV ; REJECT 15 min avant et après |
| Journal | Journal papier : stop obligatoire, risque max 2 %, P&L seulement si la sortie a été observée |
| Aide | Règles, limites, confidentialité, conditions |

Règles : marché fermé (heure de New York, heure d'été gérée), donnée périmée (> 180 s), annonce à
≤ 15 min, spread trop large, prix à plus de 1,5 % du taux de référence BCE (EUR/USD) → **REJECT**.
Mouvement ≥ 15 pips (EUR/USD) ou ≥ 30 pips de 0,10 $ (or) sur 5 min → **WATCH**, candidat à examiner,
sans direction ni profit implicite. bid/ask non fournis par `/quote` : le spread est **supposé**.

## Sécurité et confidentialité
- Aucun script tiers, aucun suivi, aucun compte. Une politique CSP stricte n'autorise que
  `api.twelvedata.com` (avec la clé du visiteur), et sans clé `data-api.ecb.europa.eu`,
  `ec.europa.eu` (Eurostat), `markets.newyorkfed.org` et `api.bls.gov`.
- Tout le texte est inséré sans `innerHTML`. Les exports CSV sont protégés contre l'injection de formules.

## Fichiers
- `index.html`, `style.css`, `app.js` (moniteur, annonces, journal), `desk.js` (analyse, fondamental, plan, alertes, sessions)
- `journal.js`, `accounts.js`, `mt5-import.js` : journal, comptes et challenges, import MT5 ; `db.js` : stockage IndexedDB
- `rules.js`, `analysis.js`, `journal-core.js`, `challenge-core.js`, `mt5-core.js` : moteurs purs, sans DOM ni réseau
- `outils/mt5_export.py` : script local MT5 en **lecture seule** (guide : `outils/GUIDE-MT5.md`, tests : `python -m unittest discover -s outils -p "test_*.py"`).
  Sa configuration `outils/mt5_config.json` et ses exports sont ignorés par Git
- `tests/` : `node --test tests/` (25 tests)

## Limites
- La surveillance ne tourne que **tant que la page est ouverte**.
- Le calendrier ForexFactory et les flux d'actualités des banques centrales ne peuvent pas être lus
  par un site tiers : les annonces se saisissent à la main, et l'actualité passe par des liens.
- Fondamental : seulement USD et EUR (les autres banques centrales n'ont pas de source lisible
  directement). En novembre 2026, la série d'inflation de la zone euro (Eurostat) s'arrête à
  décembre 2025 : elle est marquée « ancien ». Le BLS a des mois manquants (octobre 2025) : l'inflation
  US est calculée sur le dernier mois comparable, avec sa date.
- Jours fériés non gérés. Prix = clôture 1 min (milieu de marché), pas un prix d'exécution.
- Avantage d'un WATCH : **INCONNU** sans backtest coûts compris.

Outil éducatif, pas un conseil en investissement. Le trading avec effet de levier peut faire perdre
plus que la mise.
