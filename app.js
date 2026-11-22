/* Desk Forex : interface (LECTURE SEULE, aucun ordre). La logique de decision est dans rules.js. */
(function () {
  "use strict";
  // Horloge de l'en-tete : demarree en premier et independante du reste du site,
  // pour qu'une erreur ailleurs ne la laisse jamais bloquee sur « --:-- ».
  function clockTick() {
    const c = document.getElementById("clock");
    if (!c) return;
    const now = new Date();
    const utc = document.createElement("span");
    utc.className = "clock-utc"; utc.textContent = " · " + now.toISOString().slice(11, 16) + " UTC";   // cache sur telephone
    c.textContent = window.Fmt ? window.Fmt.benin(now.getTime()) : now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    c.append(utc);
    c.setAttribute("datetime", now.toISOString());
  }
  clockTick(); setInterval(clockTick, 10000);
  const R = window.Rules, F = window.Fmt, JC = window.JournalCore;
  // cfg est modifie sur place quand l'utilisateur change ses reglages (desk.js garde la meme reference)
  const cfg = {};
  function applySettings(s) {
    const n = R.withSettings(R.DEFAULTS, s);
    Object.keys(cfg).forEach((k) => delete cfg[k]);
    Object.assign(cfg, n);
    if (window.Analysis) window.Analysis.configureXau(n.settings.xauPipUsd);
  }
  applySettings((function () { try { return JSON.parse(localStorage.getItem("dfx.settings")) || {}; } catch (e) { return {}; } })());
  const SYMS = Object.keys(cfg.symbols);
  const PER_POLL = SYMS.length; // 1 credit par symbole
  const TD_URL = "https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(SYMS.join(",")) + "&interval=1min&timezone=UTC";
  const ECB_URL = "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=jsondata";
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- stockage local (jamais envoye)
  const store = {
    get(k, d) { try { const v = localStorage.getItem("dfx." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("dfx." + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem("dfx." + k); } catch (e) { /* idem */ } },
    /** Liste enregistree : toujours un tableau d'objets (une valeur abimee donne une liste vide au lieu de bloquer le site). */
    list(k) { const v = this.get(k, []); return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []; },
  };
  let memKey = "";
  function getKey() {
    try { return sessionStorage.getItem("dfx.key") || localStorage.getItem("dfx.key") || memKey; } catch (e) { return memKey; }
  }
  function keyWhere() {
    try { if (localStorage.getItem("dfx.key")) return "sur cet appareil"; if (sessionStorage.getItem("dfx.key")) return "jusqu'à la fermeture de l'onglet"; } catch (e) { /* */ }
    return memKey ? "pour cette page" : "";
  }
  function saveKey(k, remember) {
    forgetKey();
    memKey = k;
    try { (remember ? localStorage : sessionStorage).setItem("dfx.key", k); } catch (e) { /* reste en memoire */ }
  }
  function forgetKey() {
    memKey = "";
    try { localStorage.removeItem("dfx.key"); sessionStorage.removeItem("dfx.key"); } catch (e) { /* */ }
  }

  // ---------------------------------------------------------------- utilitaires d'affichage (texte uniquement, pas d'innerHTML)
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  const fmtLocal = (ms) => F.benin(ms, { date: true });                      // heure du Benin (UTC+1)
  /** Cellule d'heure : heure du Benin, et l'heure UTC en petit dessous. */
  const timeCell = (ms, opt) => [F.benin(ms, opt || { date: true }), el("small", { class: "utc" }, F.utc(ms))];
  const fmtUtc = (ms) => R.isoUtc(ms).slice(0, 16).replace("T", " ");
  function toast(msg, ms = 4000) {
    const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), ms);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const REASON_FR = { MARKET_CLOSED: "marché fermé", STALE_DATA: "donnée périmée", NEWS_WINDOW: "annonce proche",
    SPREAD_TOO_WIDE: "spread trop large", BID_ASK_CROSSED: "bid > ask", PRICE_FAR_FROM_CONTROL: "écart avec la BCE",
    NETWORK_ERROR: "erreur réseau", QUOTA_EXCEEDED_API: "quota atteint", PRICE_MISSING: "prix absent",
    NO_DATA_IN_RESPONSE: "pas de donnée", SYNTHETIC_MISSING_TICK: "donnée manquante (démo)" };
  const reasonsFr = (s) => (s || "").split(";").filter(Boolean)
    .map((r) => (r.startsWith("SHARP_MOVE") ? "mouvement brusque à examiner"
      : r.startsWith("WATCH_ALREADY_SIGNALED_") ? `mouvement déjà signalé à ${r.slice(-5)} UTC (pause en cours)`
        : REASON_FR[r] || r)).join(", ");

  // ---------------------------------------------------------------- onglets, horloge, marche
  // 4 groupes (Accueil, Analyse, Trader, Aide), chacun avec ses pages ; chaque groupe se souvient de sa derniere page
  const GROUPS = { home: ["monitor", "briefing", "brief"], analyse: ["analyse", "fund", "news"], trader: ["dash", "pretrade", "plan", "journal", "accounts"], help: ["help"] };
  const groupOf = (tab) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(tab)) || "home";
  const PAGE_NAMES = { monitor: "Moniteur", briefing: "Briefing", brief: "Synthèse du jour", analyse: "Technique", fund: "Fondamental", news: "Annonces",
    dash: "Dashboard", pretrade: "Avant le trade", plan: "Plan", journal: "Journal", accounts: "Comptes", help: "Aide" };
  const GROUP_NAMES = { home: "Accueil", analyse: "Analyse", trader: "Trader", help: "Aide" };
  document.querySelectorAll("#subNav button, #sideNav button[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.querySelectorAll("#groupNav button, #sideNav .side-grp").forEach((b) => b.addEventListener("click", () => {
    const g = b.dataset.group, last = store.get("tabOf", {})[g];
    showTab(GROUPS[g].includes(last) ? last : GROUPS[g][0]);
  }));
  function showTab(name) {
    if (!document.getElementById("tab-" + name)) name = "monitor";
    const g = groupOf(name);
    document.querySelectorAll("#groupNav button, #sideNav .side-grp").forEach((b) => {
      if (b.dataset.group === g) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelectorAll("#sideNav button[data-tab]").forEach((b) => {
      if (b.dataset.tab === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    // titre de la page (hierarchie claire) et titre de l'onglet du navigateur
    $("pageTitle").textContent = PAGE_NAMES[name] || name;
    $("pageCrumb").textContent = GROUP_NAMES[g];
    $("pageCrumb").classList.toggle("hidden", GROUP_NAMES[g] === PAGE_NAMES[name]);
    document.title = `${PAGE_NAMES[name] || name} · Desk Forex`;
    document.querySelectorAll("#subNav button").forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.classList.toggle("hidden", b.dataset.group !== g);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    $("subNav").classList.toggle("single", GROUPS[g].length < 2);
    if (name === "monitor") autoDemo();
    document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + name));
    store.set("tab", name);
    const tabOf = store.get("tabOf", {}); if (tabOf && typeof tabOf === "object") { tabOf[g] = name; store.set("tabOf", tabOf); }
  }
  // theme : sombre par defaut, clair en option (bouton soleil / lune), memorise sur l'appareil
  function applyTheme(t) {
    const light = t === "light";
    if (light) document.documentElement.setAttribute("data-theme", "light"); else document.documentElement.removeAttribute("data-theme");
    $("themeBtn").setAttribute("aria-label", light ? "Passer en thème sombre" : "Passer en thème clair");
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute("content", light ? "#F3F6FB" : "#0B1220");
    window.dispatchEvent(new Event("resize"));            // les graphiques se redessinent avec les nouvelles couleurs
  }
  $("themeBtn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    store.set("theme", next); applyTheme(next);
  });
  // taille du texte : A- / A+ (5 niveaux, memorises sur l'appareil)
  const FS_MIN = -1, FS_MAX = 3;
  function applyFontSize(level) {
    const v = Math.max(FS_MIN, Math.min(FS_MAX, Math.round(Number(level) || 0)));
    if (v) document.documentElement.setAttribute("data-fs", String(v)); else document.documentElement.removeAttribute("data-fs");
    document.querySelectorAll(".fs-down").forEach((b) => { b.disabled = v <= FS_MIN; });
    document.querySelectorAll(".fs-up").forEach((b) => { b.disabled = v >= FS_MAX; });
    store.set("fontSize", v);
    window.dispatchEvent(new Event("resize"));            // les graphiques se redessinent a la nouvelle taille
    return v;
  }
  const fsStep = (d) => { const v = applyFontSize((store.get("fontSize", 0) || 0) + d); toast(`Taille du texte : ${v === 0 ? "normale" : (v > 0 ? "+" : "") + v}`); };
  document.querySelectorAll(".fs-down").forEach((b) => b.addEventListener("click", () => fsStep(-1)));
  document.querySelectorAll(".fs-up").forEach((b) => b.addEventListener("click", () => fsStep(1)));
  function tick() {
    const now = Date.now();
    const demoRun = typeof mon !== "undefined" && mon.running && mon.mode === "demo";
    // badge Demo / Reel : Demo sans cle ou pendant la demonstration, Reel avec une cle
    const demo = demoRun || !getKey();
    $("modeBadge").textContent = demo ? "Démo" : "Réel";
    $("modeBadge").className = "pill mode " + (demo ? "WATCH" : "on");
    $("modeBadge").title = demo ? (getKey() ? "Démonstration en cours : prix simulés" : "Aucune clé Twelve Data : prix simulés") : "Clé Twelve Data enregistrée : vrais prix";
    if (demoRun) { $("mktPill").textContent = "Marché simulé"; $("mktPill").className = "pill off mkt"; return; }   // la demo simule un mercredi
    const open = R.marketStatus(now, "EUR/USD") === "OPEN";
    $("mktPill").textContent = open ? "Marché ouvert" : "Marché fermé";
    $("mktPill").className = "pill mkt " + (open ? "on" : "bad");
  }

  // ---------------------------------------------------------------- cle
  const KEY_RE = /^[A-Za-z0-9]{16,64}$/;
  function renderKey() {
    const has = !!getKey();
    $("demoGlobal").classList.toggle("hidden", has);     // bandeau « Données de démo » tant qu'aucune cle n'est enregistree
    $("logEmptyBtn").textContent = has ? "Démarrer la surveillance" : "Voir la démo";
    $("keyCard").classList.toggle("hidden", has);
    $("keyOk").classList.toggle("hidden", !has);
    $("keyWhere").textContent = has ? "(" + keyWhere() + ")" : "";
    tick();                                                   // badge Demo / Reel
  }
  $("keyForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const k = $("keyInput").value.trim();
    if (!KEY_RE.test(k)) { toast("Clé invalide : colle la clé affichée sur ton tableau de bord Twelve Data."); return; }
    saveKey(k, $("keyRemember").checked);
    $("keyInput").value = "";
    keySaved(); toast("Clé enregistrée dans ton navigateur.");
  });
  function keySaved() {
    if (mon.running && mon.mode === "demo") stopMonitor("Démo arrêtée : ta clé est enregistrée. Tu peux démarrer la surveillance.");
    renderKey();
  }
  $("demoAddKey").addEventListener("click", () => {
    showTab("monitor");
    $("keyCard").scrollIntoView({ block: "center" }); $("keyInput").focus();
  });
  $("keyForget").addEventListener("click", () => { if (mon.running && mon.mode === "live") stopMonitor("Arrêt : clé oubliée."); forgetKey(); renderKey(); toast("Clé oubliée."); });

  // boutons des messages « tableau vide » : data-focus = aller au champ, data-click = cliquer un bouton existant
  document.addEventListener("click", (e) => {
    const f = e.target.closest("[data-focus]"), c = e.target.closest("[data-click]");
    if (f) { const t = $(f.dataset.focus); if (t) { t.scrollIntoView({ block: "center" }); t.focus(); } }
    if (c) { const t = $(c.dataset.click); if (t) t.click(); }
  });

  // ---------------------------------------------------------------- credits
  const storageAdapter = { get: (k) => store.get(k, null), set: (k, v) => store.set(k, v) };
  const credits = R.CreditTracker(storageAdapter, cfg.creditsPerMinute, cfg.creditsPerDay);
  function renderCredits() {
    const used = credits.usedToday(Date.now());
    $("creditBar").style.width = Math.min(100, used / cfg.creditsPerDay * 100) + "%";
    $("creditTxt").textContent = `Crédits utilisés aujourd'hui sur cet appareil : ${used} / ${cfg.creditsPerDay} (remise à zéro à minuit UTC).`;
  }

  // ---------------------------------------------------------------- annonces
  let news = store.list("news").filter((e) => Number.isFinite(e.timeMs) && e.timeMs > Date.now() - 30 * 86400000);
  const saveNews = () => { news.sort((a, b) => a.timeMs - b.timeMs); store.set("news", news); };
  function addNews(list) {
    let added = 0;
    for (const ev of list) {
      if (news.some((n) => n.timeMs === ev.timeMs && n.currency === ev.currency && n.event.toLowerCase() === ev.event.toLowerCase())) continue;
      news.push({ timeMs: ev.timeMs, currency: ev.currency, event: ev.event.slice(0, 80), impact: ev.impact || "" });
      added++;
    }
    saveNews(); renderNews(); return added;
  }
  function renderNews() {
    const tb = clear($("newsTable").querySelector("tbody"));
    const up = news.filter((e) => e.timeMs >= Date.now() - 15 * 60000);
    up.forEach((e) => tb.append(el("tr", {},
      el("td", { class: "mono" }, timeCell(e.timeMs)), el("td", {}, e.currency),
      el("td", {}, e.event), el("td", {}, e.impact === "high" ? "fort" : e.impact === "medium" ? "moyen" : e.impact),
      el("td", {}, el("button", { class: "btn ghost small", type: "button", "aria-label": `Supprimer l'annonce ${e.currency} ${e.event} du ${F.benin(e.timeMs, { date: true })}`, onclick: () => {
        news = news.filter((n) => n !== e); saveNews(); renderNews(); } }, "Supprimer")))));
    $("newsEmpty").classList.toggle("hidden", up.length > 0);
    $("newsTable").parentElement.classList.toggle("hidden", !up.length);
  }
  $("newsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = JC.parseLocalInput($("nDate").value);            // saisie en heure du Benin
    const ev = $("nEvent").value.trim();
    if (!Number.isFinite(t) || !ev) { toast("Date ou nom d'annonce manquant."); return; }
    addNews([{ timeMs: t, currency: $("nCcy").value, event: ev, impact: $("nImpact").value }]);
    $("nEvent").value = ""; toast("Annonce ajoutée : " + F.both(t, { date: true }) + ".");
  });
  $("newsImport").addEventListener("click", () => {
    const { events, errors } = R.parseNewsCsv($("newsCsv").value);
    const n = addNews(events);
    $("newsImportMsg").textContent = `${n} ajoutée(s)` + (errors.length ? ` · ${errors.length} ligne(s) ignorée(s) : ${errors[0]}` : "");
    if (n) $("newsCsv").value = "";
  });

  // ---------------------------------------------------------------- moniteur
  const mon = { running: false, mode: "live", sid: 0, timer: null, endAt: 0, engine: null, rows: [], controls: {},
    failures: 0, lastNotified: {}, demoNews: [] };
  let liveLog = store.list("log");

  function setStatus(msg) { $("status").textContent = msg; }
  function setRunningUi(on) {
    $("startBtn").classList.toggle("hidden", on); $("stopBtn").classList.toggle("hidden", !on);
    $("demoBtn").disabled = on; $("duration").disabled = on;
  }
  function startCommon(mode) {
    mon.running = true; mon.mode = mode; mon.sid++; mon.engine = R.newEngineState(cfg); mon.rows = [];
    mon.failures = 0; mon.lastNotified = {};
    $("demoBanner").classList.toggle("hidden", mode !== "demo");
    setRunningUi(true); renderCards(); renderLog(); tick();
    return mon.sid;
  }
  function stopMonitor(msg, important) {
    mon.sid++; mon.running = false; clearTimeout(mon.timer);
    setRunningUi(false); setStatus(msg || "Arrêté."); tick();
    if (important) { toast(msg, 7000); notify("Desk Forex", msg); }
    renderCredits();
  }
  $("stopBtn").addEventListener("click", () => stopMonitor("Arrêté par toi. Journal conservé."));

  function addRows(rows) {
    for (const r of rows) {
      mon.rows.push(r);
      if (r.decision === "WATCH") onWatch(r);
    }
    if (mon.mode === "live") { liveLog = liveLog.concat(rows).slice(-500); store.set("log", liveLog); }
    renderCards(); renderLog(); renderCredits();
  }
  function onWatch(r) {
    // la pause par paire est appliquee par le moteur (rules.js) : chaque WATCH ici est un nouveau mouvement
    const msg = `À surveiller : ${r.symbol} ${F.fromText(r.price)}, ${F.fromText(r.change_5m_pips)} pips en 5 min. À examiner, pas un signal.`;
    toast(msg, 8000); notify("À surveiller : " + r.symbol + (mon.mode === "demo" ? " (démo)" : ""), msg);
  }
  function notify(title, body) {
    try { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, icon: "icon.svg", tag: title }); } catch (e) { /* */ }
    try {
      const active = !navigator.userActivation || navigator.userActivation.hasBeenActive;
      if (navigator.vibrate && active) navigator.vibrate([200, 100, 200]);
    } catch (e) { /* */ }
  }
  $("notifBtn").addEventListener("click", async () => {
    if (!("Notification" in window)) { toast("Ce navigateur ne gère pas les notifications."); return; }
    const p = await Notification.requestPermission();
    toast(p === "granted" ? "Notifications activées (tant que la page est ouverte)." : "Notifications refusées.");
    renderNotifBtn();
  });
  function renderNotifBtn() {
    const ok = "Notification" in window && Notification.permission === "granted";
    $("notifBtn").textContent = ok ? "Notifications activées" : "Activer les notifications";
    $("notifBtn").disabled = ok;
  }

  // ----- requetes
  async function fetchJson(url, opts, tries = 3) {
    let last = "";
    for (let i = 0; i < tries; i++) {
      const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(url, Object.assign({ signal: ctrl.signal, cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit" }, opts));
        if (r.status === 429) throw Object.assign(new Error("quota"), { kind: "QUOTA" });
        if (r.status === 401 || r.status === 403) throw Object.assign(new Error("clé refusée"), { kind: "AUTH" });
        if (r.status >= 500) last = "HTTP " + r.status;
        else if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { kind: "API" });
        else return await r.json();
      } catch (e) {
        if (e.kind) throw e;
        last = e.name === "AbortError" ? "délai dépassé" : "réseau";
      } finally { clearTimeout(to); }
      if (i < tries - 1) await sleep(2000 * 2 ** i); // backoff exponentiel
    }
    throw Object.assign(new Error(last || "réseau"), { kind: "NETWORK" });
  }
  async function loadEcb() {
    try {
      const c = R.parseEcbJson(await fetchJson(ECB_URL, {}, 2));
      return { "EUR/USD": { price: c.price, source: "BCE " + c.date } };
    } catch (e) { toast("Taux BCE indisponible : contrôle de prix désactivé pour cette session."); return {}; }
  }

  // ----- surveillance reelle
  $("startBtn").addEventListener("click", async () => {
    const key = getKey();
    if (!key) { toast("Enregistre d'abord ta clé Twelve Data."); $("keyInput").focus(); return; }
    const minutes = Number($("duration").value);
    const need = Math.ceil(minutes) * PER_POLL, left = cfg.creditsPerDay - credits.usedToday(Date.now());
    if (left < PER_POLL) { toast("Quota du jour épuisé sur cet appareil. Reprise à minuit UTC."); return; }
    const sid = startCommon("live");
    mon.endAt = Date.now() + minutes * 60000;
    setStatus("Démarrage… lecture du taux BCE.");
    if (need > left) toast(`Crédits restants (${left}) insuffisants pour toute la durée : arrêt propre au quota.`, 7000);
    mon.controls = await loadEcb();
    if (sid !== mon.sid) return;
    pollLive(sid);
  });
  function missingRows(reason) {
    const t = Date.now();
    addRows(SYMS.map((s) => R.evaluate(mon.engine, { symbol: s, price: null, sourceMs: null, source: "TWELVE_DATA", missingReason: reason },
      t, cfg, news, mon.controls, { mode: "live", creditsToday: credits.usedToday(t) })));
  }
  async function pollLive(sid) {
    if (sid !== mon.sid) return;
    const t0 = Date.now();
    if (t0 >= mon.endAt) return stopMonitor("Durée écoulée : session terminée. " + summary(), true);
    const st = credits.check(PER_POLL, t0);
    if (st === "DAILY") { missingRows("QUOTA_DAILY_LOCAL"); return stopMonitor("Quota quotidien atteint (800 crédits). Reprise à minuit UTC.", true); }
    if (st === "MINUTE") { setStatus("Limite par minute atteinte : pause de 15 s."); mon.timer = setTimeout(() => pollLive(sid), 15000); return; }
    setStatus("Relevé en cours…");
    let payload;
    try {
      payload = await fetchJson(TD_URL, { headers: { Authorization: "apikey " + getKey() } });
      const err = R.apiError(payload);
      if (err) throw Object.assign(new Error(err.message), { kind: err.kind });
    } catch (e) {
      if (sid !== mon.sid) return;
      if (e.kind === "QUOTA") { missingRows("QUOTA_EXCEEDED_API"); return stopMonitor("Quota Twelve Data atteint : arrêt propre.", true); }
      if (e.kind === "AUTH") return stopMonitor("Clé refusée par Twelve Data : vérifie-la (Accueil → Moniteur).", true);
      if (e.kind === "API") return stopMonitor("Erreur de l'API Twelve Data : " + e.message, true);
      mon.failures++;
      missingRows("NETWORK_ERROR");
      if (mon.failures >= 3) return stopMonitor("Échecs réseau répétés : arrêt. Vérifie ta connexion.", true);
      return schedule(sid, t0);
    }
    if (sid !== mon.sid) return;
    mon.failures = 0;
    const t = Date.now();
    credits.spend(PER_POLL, t);
    const quotes = R.parseQuotePayload(payload, SYMS);
    const obs = SYMS.map((s) => R.quoteToObservation(s, quotes[s]));
    addRows(obs.map((o) => R.evaluate(mon.engine, o, t, cfg, news, mon.controls,
      { mode: "live", creditsUsed: 1, creditsToday: credits.usedToday(t) })));
    const prices = {};
    obs.forEach((o) => { if (o.price != null) prices[o.symbol] = o.price; });
    priceHooks.forEach((fn) => { try { fn(prices, t); } catch (e) { /* un module ne bloque pas la surveillance */ } });
    const future = obs.some((o) => o.sourceMs && o.sourceMs - t > 120000);
    setStatus(future ? "Attention : l'horloge de ton appareil semble en retard (données marquées périmées). Règle l'heure automatique."
      : `Dernier relevé ${F.both(t)} · prochain dans ${cfg.intervalSeconds} s · fin à ${F.benin(mon.endAt)} (Bénin). Garde la page ouverte.`);
    schedule(sid, t0);
  }
  function schedule(sid, t0) {
    mon.timer = setTimeout(() => pollLive(sid), Math.max(1000, cfg.intervalSeconds * 1000 - (Date.now() - t0)));
  }
  function summary() {
    const c = { WATCH: 0, REJECT: 0, DATA_MISSING: 0, NO_ALERT: 0 };
    mon.rows.forEach((r) => c[r.decision]++);
    return `${mon.rows.length} lignes : à surveiller ${c.WATCH}, refusés ${c.REJECT}, données manquantes ${c.DATA_MISSING}.`;
  }

  // ----- demo synthetique
  /** Dernier prix reel connu par symbole : journal live de cet appareil, sinon /price si une cle existe (2 credits). */
  async function lastRealPrices() {
    const out = {};
    [...liveLog].reverse().forEach((r) => { if (!(r.symbol in out) && r.price !== "MISSING" && r.source === "TWELVE_DATA") out[r.symbol] = Number(r.price); });
    const missing = SYMS.filter((s) => !(out[s] > 0) && !(Number((cfg.settings.demoStart || {})[s]) > 0));
    if (missing.length && getKey() && credits.check(missing.length, Date.now()) === "OK") {
      try {
        const j = await fetchJson("https://api.twelvedata.com/price?symbol=" + encodeURIComponent(missing.join(",")),
          { headers: { Authorization: "apikey " + getKey() } }, 1);
        if (!R.apiError(j)) {
          credits.spend(missing.length, Date.now()); renderCredits();
          if (missing.length === 1 && j.price != null) out[missing[0]] = Number(j.price);
          else missing.forEach((s) => { if (j[s] && j[s].price != null) out[s] = Number(j[s].price); });
        }
      } catch (e) { /* repli sur le reglage ou la valeur par defaut */ }
    }
    return out;
  }
  $("demoBtn").addEventListener("click", () => runDemo());
  async function runDemo() {
    if (mon.running) return;
    $("demoBtn").disabled = true;
    const starts = R.demoStartPrices(cfg.settings, await lastRealPrices());
    const sid = startCommon("demo");
    const start = Date.parse("2026-11-18T13:00:00Z");
    const feed = R.SyntheticFeed(cfg, 42, Object.fromEntries(Object.entries(starts).map(([s, v]) => [s, v.price])));
    $("demoBanner").textContent = "Données de démo : prix SIMULÉS, aucun prix réel. Départ : " +
      SYMS.map((s) => `${s} ${F.num(starts[s].price, cfg.symbols[s].decimals)} (${starts[s].source})`).join(", ") +
      ". Un mouvement brusque, une donnée périmée et une donnée manquante sont injectés exprès.";
    const demoNews = [{ timeMs: Date.parse("2026-11-18T13:40:00Z"), currency: "USD", event: "EXEMPLE_SYNTHETIQUE_CPI", impact: "high" }];
    // controle BCE synthetique aligne sur le prix de depart (sinon faux "prix trop eloigne")
    const controls = { "EUR/USD": { price: starts["EUR/USD"].price, source: "SYNTHETIQUE" } };
    let i = 0;
    const step = () => {
      if (sid !== mon.sid) return;
      if (i >= 30) return stopMonitor("Démo terminée (30 minutes simulées). " + summary());
      const t = start + i * 60000;
      addRows(feed.step(i, t).map((o) => R.evaluate(mon.engine, o, t, cfg, demoNews, controls, { mode: "demo" })));
      setStatus(`Données de démo : minute simulée ${i + 1}/30, ${F.both(t)}. Prix simulés.`);
      i++; mon.timer = setTimeout(step, 600);
    };
    step();
  }

  // ----- rendu
  function renderCards() {
    const box = clear($("cards"));
    const rows = mon.rows.length ? mon.rows : (mon.mode === "live" ? liveLog : []);
    SYMS.forEach((s) => {
      const r = [...rows].reverse().find((x) => x.symbol === s);
      const dir = (v) => (v && v.startsWith("+") ? "up" : v && v.startsWith("-") ? "down" : "");
      box.append(el("div", { class: "card sym" },
        el("div", { class: "head" }, symBadge(s),
          r ? el("span", { class: "pill " + r.decision }, F.status(r.decision)) : el("span", { class: "pill off" }, "en attente")),
        el("div", { class: "price mono" }, r ? F.fromText(r.price) : "–"),
        el("div", { class: "muted small" }, r ? `${r.source === "SYNTHETIC" ? "SIMULÉ · " : ""}${F.both(Date.parse(r.fetched_at_utc))} · ${r.market_status === "OPEN" ? "marché ouvert" : "marché fermé"}` : "Aucun relevé"),
        el("div", { class: "kv" },
          el("div", {}, el("span", {}, "1 min (pips) ", tip("pip")), el("b", { class: "mono " + dir(r && r.change_1m_pips) }, r ? F.fromText(r.change_1m_pips) : "–")),
          el("div", {}, el("span", {}, "5 min (pips)"), el("b", { class: "mono " + dir(r && r.change_5m_pips) }, r ? F.fromText(r.change_5m_pips) : "–")),
          el("div", {}, el("span", {}, "Spread ", tip("spread")), el("b", { class: "mono" }, r ? F.fromText(r.spread_pips) + " pips" : "–"), r && r.spread_status === "ASSUMED" ? el("span", {}, "supposé") : null)),
        el("div", { class: "small" }, r && r.reasons ? reasonsFr(r.reasons) : (r ? "Rien à signaler." : "")),
        r && r.news_proximity !== "NONE" ? el("div", { class: "small warnline" }, "Annonce : " + r.news_proximity) : null,
        el("div", { class: "pipnote" }, pipLabel(s))));
    });
  }
  function pipLabel(s) {
    const sc = cfg.symbols[s];
    const val = sc.pipSize.toLocaleString("fr-FR", { minimumFractionDigits: s === "XAU/USD" ? 2 : 4 });
    return s === "XAU/USD"
      ? `1 pip = ${val} $ de prix (${sc.pipValuePerLot.toLocaleString("fr-FR")} $ par lot de 100 oz) · réglable, varie selon le courtier`
      : `1 pip = ${val} · ${sc.pipValuePerLot} $ par lot standard`;
  }

  // ---------------------------------------------------------------- reglages
  function renderSettingsForm() {
    const s = cfg.settings;
    $("setCdEUR").value = s.watchCooldownMin["EUR/USD"];
    $("setCdXAU").value = s.watchCooldownMin["XAU/USD"];
    $("setXauPip").value = String(s.xauPipUsd);
    $("setDemoEUR").value = s.demoStart["EUR/USD"] || "";
    $("setDemoXAU").value = s.demoStart["XAU/USD"] || "";
  }
  $("setForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (mon.running) { toast("Arrête d'abord la surveillance ou la démo."); return; }
    const num = (id) => { const v = Number($(id).value); return $(id).value !== "" && v >= 0 ? v : null; };
    const s = {
      watchCooldownMin: { "EUR/USD": num("setCdEUR") ?? 10, "XAU/USD": num("setCdXAU") ?? 10 },
      xauPipUsd: Number($("setXauPip").value),
      demoStart: { "EUR/USD": num("setDemoEUR") || null, "XAU/USD": num("setDemoXAU") || null },
    };
    store.set("settings", s); applySettings(s);
    renderSettingsForm(); renderCards(); toast("Réglages enregistrés.");
  });
  $("setReset").addEventListener("click", () => {
    if (mon.running) { toast("Arrête d'abord la surveillance ou la démo."); return; }
    store.del("settings"); applySettings({}); renderSettingsForm(); renderCards(); toast("Réglages par défaut rétablis.");
  });
  function renderLog() {
    const tb = clear($("logTable").querySelector("tbody"));
    const rows = (mon.rows.length ? mon.rows : liveLog).slice(-60).reverse();
    $("logEmpty").classList.toggle("hidden", rows.length > 0);
    $("logTable").parentElement.classList.toggle("hidden", !rows.length);
    rows.forEach((r) => tb.append(el("tr", {},
      el("td", { class: "mono" }, timeCell(Date.parse(r.fetched_at_utc))), el("td", {}, symBadge(r.symbol)),
      el("td", { class: "mono" }, F.fromText(r.price)), el("td", { class: "mono" }, F.fromText(r.change_1m_pips)), el("td", { class: "mono" }, F.fromText(r.change_5m_pips)),
      el("td", {}, r.market_status === "OPEN" ? "ouvert" : "fermé"),
      el("td", {}, el("span", { class: "pill " + r.decision }, F.status(r.decision))), el("td", { class: "wrap" }, reasonsFr(r.reasons)))));
  }
  function download(name, text) {
    const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $("exportLog").addEventListener("click", () => {
    const rows = mon.mode === "demo" && mon.rows.length ? mon.rows : liveLog;
    if (!rows.length) { toast("Journal vide."); return; }
    download(`desk-forex-${rows[0].mode}-${R.isoUtc(Date.now()).slice(0, 10)}.csv`, R.toCsv(rows, R.LOG_FIELDS));
  });
  $("clearLog").addEventListener("click", () => {
    if (mon.running) { toast("Arrête d'abord la surveillance."); return; }
    if (!confirm("Effacer le journal des relevés enregistré sur cet appareil ?")) return;
    liveLog = []; mon.rows = []; store.set("log", []); renderCards(); renderLog();
  });

  // ---------------------------------------------------------------- taille de position
  function renderSize() {
    const sym = $("sSym").value;
    const r = R.positionSize(Number($("sBal").value), Number($("sRisk").value), Number($("sStop").value),
      Number($("sPv").value), Number($("sMin").value), 0.01);
    const out = clear($("sizeOut"));
    const maxRisk = Number($("sBal").value) * Number($("sRisk").value) / 100;
    if (r.reason === "INVALID_INPUT") out.append("Complète le solde, le risque, le stop et la valeur du pip.");
    else if (!r.allowed) out.append(el("span", { class: "err" }, `Refusé : même ${F.num($("sMin").value, 2)} lot risque ${F.money(r.riskUsd)} (${F.pct(r.riskPct)}), au-delà de ${F.money(maxRisk)}. Stop trop large pour ce solde.`));
    else out.append(el("b", { class: "mono" }, F.num(r.lots, 2) + " lot"), ` sur ${sym} · risque ${F.money(r.riskUsd)} (${F.pct(r.riskPct)} du solde, max ${F.money(maxRisk)})`);
  }
  ["sSym", "sBal", "sRisk", "sStop", "sPv", "sMin"].forEach((id) => $(id).addEventListener("input", renderSize));
  $("sSym").addEventListener("change", () => { $("sPv").value = cfg.symbols[$("sSym").value].pipValuePerLot; renderSize(); });

  // ---------------------------------------------------------------- icones ⓘ (lexique dans fmt.js)
  const tipBox = el("div", { id: "tipBox", class: "tipbox hidden", role: "tooltip", "aria-live": "polite" });
  document.body.append(tipBox);
  let tipOwner = null;
  function prepTip(b) {
    const g = F.GLOSSARY[b.dataset.tip];
    if (!g || b.dataset.ready) return b;
    b.dataset.ready = "1"; b.type = "button"; b.classList.add("tip"); b.textContent = "ⓘ";
    b.setAttribute("aria-label", "Explication : " + g[0]); b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-controls", "tipBox");
    return b;
  }
  /** Bouton ⓘ pour un terme du lexique (contenu cree en JavaScript). */
  function tip(key) { return prepTip(el("button", { type: "button", class: "tip", "data-tip": key })); }
  function hideTip() {
    if (!tipOwner) return;
    tipOwner.setAttribute("aria-expanded", "false"); tipOwner.removeAttribute("aria-describedby");
    tipBox.classList.add("hidden"); tipOwner = null;
  }
  function showTip(b) {
    const g = F.GLOSSARY[b.dataset.tip]; if (!g) return;
    if (tipOwner === b) return hideTip();
    hideTip();
    clear(tipBox).append(el("b", {}, g[0]), " : ", g[1]);
    tipBox.classList.remove("hidden");
    const r = b.getBoundingClientRect(), w = tipBox.offsetWidth, h = tipBox.offsetHeight;
    tipBox.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    tipBox.style.top = (r.bottom + 8 + h < window.innerHeight ? r.bottom + 8 : Math.max(8, r.top - h - 8)) + "px";
    b.setAttribute("aria-expanded", "true"); b.setAttribute("aria-describedby", "tipBox"); tipOwner = b;
  }
  document.querySelectorAll("button[data-tip]").forEach(prepTip);
  const gl = $("helpGlossary");
  if (gl) Object.values(F.GLOSSARY).forEach(([term, text]) => gl.append(el("dt", {}, term), el("dd", {}, text)));
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tip]");
    if (b) { e.preventDefault(); e.stopPropagation(); prepTip(b); showTip(b); return; }
    if (!e.target.closest("#tipBox")) hideTip();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && tipOwner) { const b = tipOwner; hideTip(); b.focus(); } });
  window.addEventListener("scroll", hideTip, { passive: true }); window.addEventListener("resize", hideTip);

  /** Badge du symbole : bleu pour les paires de devises, dore pour l'or (XAU/USD). */
  const symBadge = (s) => el("span", { class: "sym-badge" + (/^XA[UG]/.test(String(s)) ? " gold" : "") }, String(s || "–"));
  // tableaux : les colonnes de nombres (police a chasse fixe) sont alignees a droite, en-tete compris
  function alignTables(root) {
    (root || document).querySelectorAll("table").forEach((t) => {
      const first = t.tBodies[0] && t.tBodies[0].rows[0];
      if (!first) return;
      [...first.cells].forEach((cell, i) => {
        if (i === 0 || !cell.classList.contains("mono")) return;
        if (t.tHead && t.tHead.rows[0] && t.tHead.rows[0].cells[i]) t.tHead.rows[0].cells[i].classList.add("r");
        [...t.tBodies[0].rows].forEach((row) => { if (row.cells[i]) row.cells[i].classList.add("r"); });
      });
    });
  }
  let alignQueued = false;
  new MutationObserver(() => { if (alignQueued) return; alignQueued = true; requestAnimationFrame(() => { alignQueued = false; alignTables(); }); })
    .observe(document.getElementById("main"), { childList: true, subtree: true });

  // ---------------------------------------------------------------- outils partages avec desk.js et journal.js
  const priceHooks = [];
  window.DeskApp = {
    cfg, store, getKey, credits, fetchJson, toast, notify, el, clear, showTab, renderCredits, download,
    getNews: () => news.slice(),
    onPrices: (fn) => priceHooks.push(fn),
    fmtUtc, fmtLocal, timeCell, tip, symBadge,
  };

  // ---------------------------------------------------------------- demarrage
  // ---------------------------------------------------------------- prise en main
  // sans cle : la demo se lance toute seule (une fois par visite), avec le bandeau « Données de démo »
  let autoDemoDone = false;
  function autoDemo() {
    if (autoDemoDone || typeof mon === "undefined" || mon.running || getKey()) return;
    autoDemoDone = true;
    setTimeout(() => { if (!getKey() && !mon.running) runDemo(); }, 400);
  }
  $("logEmptyBtn").addEventListener("click", () => (getKey() ? $("startBtn").click() : runDemo()));
  // ecran d'accueil en 3 etapes (premiere visite), bouton « Passer », Echap = passer
  const W = { step: 1, dlg: $("welcome") };
  function wShow(n) {
    W.step = n;
    W.dlg.querySelectorAll(".w-step").forEach((sec) => sec.classList.toggle("hidden", Number(sec.dataset.step) !== n));
    W.dlg.querySelectorAll(".w-dots li").forEach((li, i) => li.classList.toggle("on", i < n));
    $("wPrev").classList.toggle("hidden", n === 1);
    $("wNext").textContent = n < 3 ? "Suivant" : getKey() ? "Démarrer la surveillance" : "Voir la démo";
    if (n === 2) $("wKeyMsg").textContent = getKey() ? "✓ Une clé est déjà enregistrée sur cet appareil." : "";
    if (n === 3) $("wStartInfo").textContent = getKey() ? "Ta clé est enregistrée : la surveillance utilisera de vrais prix."
      : "Pas encore de clé : tu verras d'abord la démo (prix simulés). Tu pourras ajouter ta clé plus tard dans Accueil → Moniteur.";
    const h = W.dlg.querySelector(`.w-step[data-step="${n}"] h3`); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
  }
  function wClose() { store.set("welcomeDone", true); if (W.dlg.open) W.dlg.close(); }
  function wOpen() { if (typeof W.dlg.showModal !== "function") return; if (!W.dlg.open) W.dlg.showModal(); wShow(1); }
  $("wSkip").addEventListener("click", wClose);
  W.dlg.addEventListener("cancel", () => store.set("welcomeDone", true));
  $("wPrev").addEventListener("click", () => wShow(Math.max(1, W.step - 1)));
  $("wNext").addEventListener("click", () => {
    if (W.step < 3) return wShow(W.step + 1);
    wClose(); showTab("monitor");
    if (getKey()) { if (mon.running) stopMonitor("Démo arrêtée."); $("startBtn").click(); } else runDemo();
  });
  $("wKeyForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const k = $("wKey").value.trim();
    if (!KEY_RE.test(k)) { $("wKeyMsg").textContent = "Clé invalide : colle la clé affichée sur ton tableau de bord Twelve Data (16 à 64 lettres et chiffres)."; return; }
    saveKey(k, $("wRemember").checked); $("wKey").value = "";
    keySaved(); toast("Clé enregistrée dans ton navigateur.");
    wShow(3);
  });
  $("wAgain").addEventListener("click", wOpen);

  // chaque partie demarre seule : une erreur dans l'une n'empeche pas les autres de s'afficher
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`Desk Forex : erreur au démarrage (${name})`, e); } };
  safe("taille du texte", () => applyFontSize(store.get("fontSize", 0)));
  safe("thème", () => applyTheme(store.get("theme", "dark")));
  safe("onglet", () => showTab(store.get("tab", "monitor")));
  [["clé", renderKey], ["crédits", renderCredits], ["annonces", renderNews], ["cartes", renderCards], ["relevés", renderLog],
    ["taille de position", renderSize], ["notifications", renderNotifBtn], ["réglages", renderSettingsForm], ["marché", tick]]
    .forEach(([name, fn]) => safe(name, fn));
  setInterval(() => safe("marché", tick), 30000);
  safe("accueil", () => { if (!store.get("welcomeDone", false)) wOpen(); });
  window.addEventListener("beforeunload", (e) => { if (mon.running && mon.mode === "live") { e.preventDefault(); e.returnValue = ""; } });
})();
