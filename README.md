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
| Moniteur | Un relevé par minute (2 crédits), décisions **WATCH / REJECT / DATA_MISSING** avec les mêmes règles que `monitor.py`, notifications du navigateur, export CSV, démo synthétique |
| Annonces | Fenêtres d'annonces saisies en heure locale, enregistrées en UTC, import CSV ; REJECT 15 min avant et après |
| Position | Taille en lots arrondie vers le bas, refus si même le lot minimal dépasse le risque |
| Journal | Journal papier : stop obligatoire, risque max 2 %, P&L seulement si la sortie a été observée |
| Aide | Règles, limites, confidentialité, conditions |

Règles : marché fermé (heure de New York, heure d'été gérée), donnée périmée (> 180 s), annonce à
≤ 15 min, spread trop large, prix à plus de 1,5 % du taux de référence BCE (EUR/USD) → **REJECT**.
Mouvement ≥ 15 pips (EUR/USD) ou ≥ 30 pips de 0,10 $ (or) sur 5 min → **WATCH**, candidat à examiner,
sans direction ni profit implicite. bid/ask non fournis par `/quote` : le spread est **supposé**.

## Sécurité et confidentialité
- Aucun script tiers, aucun suivi, aucun compte. Une politique CSP stricte n'autorise que
  `api.twelvedata.com` et `data-api.ecb.europa.eu`.
- Tout le texte est inséré sans `innerHTML`. Les exports CSV sont protégés contre l'injection de formules.

## Fichiers
- `index.html`, `style.css`, `app.js` (interface), `rules.js` (moteur pur, sans DOM ni réseau)
- `tests/rules.test.js` : `node --test tests/`

## Limites
- La surveillance ne tourne que **tant que la page est ouverte**.
- Le calendrier ForexFactory ne peut pas être lu par un site tiers : les annonces se saisissent à la main.
- Jours fériés non gérés. Prix = clôture 1 min (milieu de marché), pas un prix d'exécution.
- Avantage d'un WATCH : **INCONNU** sans backtest coûts compris.

Outil éducatif, pas un conseil en investissement. Le trading avec effet de levier peut faire perdre
plus que la mise.
