# Guide : relier MetaTrader 5 au journal Desk Forex

Ce guide est fait pour un débutant. Il y a **deux façons** de faire arriver tes trades MT5 dans le journal :

| | A. Rapport MT5 | B. Script local (recommandé) |
|---|---|---|
| Ce que tu fais | Tu exportes un rapport depuis MT5 et tu le glisses dans le site | Un petit programme lit ton MT5 ouvert et donne les données au site |
| Automatique | Non | Oui, quand le PC est allumé et MT5 ouvert |
| Mot de passe | Aucun | Aucun (il lit le terminal déjà connecté) |
| Équité en direct (jauges de challenge) | Non | Oui |
| Coût | 0 € | 0 € |

> **Sécurité.** Le script est en **lecture seule** : il n'appelle aucune fonction d'ordre (un test le vérifie).
> Il n'écoute que ton PC (`127.0.0.1`), pas ton Wi-Fi, n'accepte que le site Desk Forex et exige un code secret.
> Ne mets **jamais** ton mot de passe principal MT5 dans un fichier. Si un jour tu remplis les champs
> d'identifiants, utilise uniquement le **mot de passe investisseur** (lecture seule).

---

## A. Importer un rapport MT5 (sans rien installer)

1. Dans MT5, ouvre la **Boîte à outils** (Ctrl + T), onglet **Historique**.
2. Choisis la période (clic droit → *Période personnalisée* si besoin).
3. Clic droit dans la liste → **Rapport** → **HTML** (ou **Open XML** pour Excel). Enregistre le fichier.
4. Dans le site : onglet **Comptes** → carte **Import MT5** → **Rapport MT5**, choisis le fichier.
5. Vérifie le **décalage horaire du serveur** (voir plus bas), choisis le compte du site, puis **Importer**.

Le site lit le tableau *Positions* du rapport. Les trades déjà importés ne sont pas dupliqués (même ticket MT5)
et ce que tu as ajouté à la main (setup, émotions, erreurs, captures, notes) est conservé.

---

## B. Le script local, pas à pas

### 1. Vérifier Python
Ouvre **PowerShell** et tape :
```powershell
python --version
```
Tu dois voir `Python 3.x`. Sinon, installe Python depuis python.org (coche **Add python.exe to PATH**), puis rouvre PowerShell.

### 2. Installer la librairie officielle MetaTrader5 (une seule fois)
```powershell
python -m pip install MetaTrader5
```
(Sur ton PC, elle est déjà installée.)

### 3. Ouvrir MT5
Lance MetaTrader 5 et **connecte-toi à ton compte** (démo de préférence pour commencer). Laisse-le ouvert.

### 4. Premier test (diagnostic)
Dans PowerShell, va dans le dossier `outils` du projet, puis lance le diagnostic :
```powershell
cd C:\Users\HP\.agents\desk-forex-web\outils
python mt5_export.py --check
```
Tu dois voir `Connexion OK - compte ****123 (demo, USD)` et le nombre de positions lues.
Au premier lancement, le script crée `mt5_config.json` (ignoré par Git) avec un **code secret**.

### 5a. Export simple (un fichier à importer)
```powershell
python mt5_export.py
```
Le fichier `desk-forex-mt5.json` est créé dans `outils`. Dans le site : **Comptes → Import MT5 → Fichier du script**.

### 5b. Mode automatique (le site récupère tout seul)
```powershell
python mt5_export.py --serve
```
Laisse cette fenêtre ouverte. Elle affiche le **code secret**. Dans le site : **Comptes → Import MT5 →
Connexion automatique**, colle le code, puis **Tester** et **Synchroniser**. Coche *Synchroniser toutes les
5 minutes* pour un suivi continu tant que la page est ouverte. Arrêt : **Ctrl + C**.

Options : `--interval 2` (minutes entre deux lectures), `--port 8791`, `--days 90` (jours d'historique).

> La connexion automatique ne marche que dans un navigateur **de ce PC** (ton téléphone ne peut pas joindre
> `127.0.0.1` de ton PC). Si ton navigateur demande d'**autoriser l'accès au réseau local**, accepte pour le
> site Desk Forex. S'il bloque, utilise l'export simple (5a) : même résultat, en un clic de plus.

---

## Le fichier `mt5_config.json`

| Champ | Rôle |
|---|---|
| `port` | Port local du mode automatique (8790 par défaut) |
| `token` | Code secret à coller dans le site. Pour en changer, efface la valeur et relance le script |
| `allowedOrigins` | Sites autorisés à lire les données (le site Desk Forex et la version locale) |
| `serverOffsetHours` | Décalage de l'heure du serveur MT5 par rapport à UTC. Vide = détection automatique quand le marché est ouvert |
| `daysOfHistory` | Nombre de jours d'historique lus (365) |
| `terminalPath` | Chemin de `terminal64.exe` si tu as plusieurs MT5 (sinon vide) |
| `login`, `server`, `investorPassword` | **À laisser vides.** Seulement si tu veux que le script se connecte lui-même : mot de passe **investisseur** uniquement. Attention, cela connecte ton terminal à ce compte |

### Le décalage horaire du serveur
MT5 affiche les heures **à l'heure du serveur de ton courtier** (souvent UTC+2 en hiver, UTC+3 en été), pas en UTC
ni à l'heure du Bénin. Le script le détecte tout seul quand le marché est ouvert. Le week-end, il utilise la
dernière valeur connue (2 h par défaut). Si les heures de tes trades sont décalées dans le journal, règle
`serverOffsetHours` (ou le champ *Décalage* lors de l'import d'un rapport).

---

## En cas d'erreur

| Message | Que faire |
|---|---|
| `python` n'est pas reconnu | Installe Python (case *Add to PATH*), puis rouvre PowerShell |
| `la librairie MetaTrader5 n'est pas installee` | `python -m pip install MetaTrader5` |
| `MetaTrader 5 inaccessible` | Ouvre MT5 et connecte-toi. Si tu as plusieurs MT5, remplis `terminalPath` |
| `aucun compte n'est connecte` | Dans MT5 : Fichier → Se connecter à un compte de trading |
| `Address already in use` / port occupé | Lance avec `--port 8791` et mets le même port dans le site |
| Le site dit *code secret faux* | Recopie le code affiché par le script (ou celui de `mt5_config.json`) |
| Le site dit *connexion impossible* | Le script `--serve` tourne-t-il ? Même port ? Le navigateur a-t-il bloqué l'accès local ? Sinon : export simple |
| Des trades sont ignorés (`US30`, `BTCUSD`…) | Normal : le site suit 12 paires forex et métaux |
| Les heures sont décalées | Règle le décalage du serveur (voir plus haut) |

Rappel : outil éducatif. Le script et le site ne passent **aucun ordre** et ne donnent aucun conseil.
