/* Desk Forex : analyse technique, fondamental, sessions, alertes, plan de trade, pre-test.
 * LECTURE SEULE : aucun ordre, aucun conseil. Les calculs sont dans analysis.js (teste).
 */
(function () {
  "use strict";
  const A = window.Analysis, D = window.DeskApp;
  if (!A || !D) return;
  const { el, clear, store, toast } = D;
  const $ = (id) => document.getElementById(id);
  const PAIRS = Object.keys(A.PAIRS);
  const TD = "https://api.twelvedata.com";
  const F = window.Fmt;
  const fmt = (x, d) => F.num(x, d);                       // nombres au format francais (affichage)

  // ---------------------------------------------------------------- listes de paires
  document.querySelectorAll(".pairsel").forEach((s) => PAIRS.forEach((p) => s.append(el("option", { value: p }, p))));
  $("aPair").value = store.get("aPair", "EUR/USD");

  // ---------------------------------------------------------------- requetes Twelve Data (credits partages)
  async function td(path, params, credits) {
    const key = D.getKey();
    if (!key) throw new Error("Enregistre d'abord ta clé Twelve Data (onglet Moniteur).");
    const now = Date.now();
    const st = D.credits.check(credits, now);
    if (st === "DAILY") throw new Error("Quota du jour épuisé (800 crédits). Reprise à minuit UTC.");
    if (st === "MINUTE") throw new Error("Limite de 8 crédits par minute atteinte : réessaie dans une minute.");
    const qs = new URLSearchParams(params).toString();
    let j;
    try { j = await D.fetchJson(`${TD}${path}?${qs}`, { headers: { Authorization: "apikey " + key } }, 2); }
    catch (e) {
      if (e.kind === "AUTH") throw new Error("Clé refusée par Twelve Data.");
      if (e.kind === "QUOTA") throw new Error("Quota Twelve Data atteint.");
      throw new Error("Twelve Data injoignable (" + e.message + ").");
    }
    D.credits.spend(credits, Date.now()); D.renderCredits();
    if (j && j.status === "error") throw new Error(`Twelve Data : ${String(j.message || j.code).slice(0, 160)}`);
    return j;
  }

  // ---------------------------------------------------------------- sessions
  function renderSessions() {
    const s = A.sessionsAt(Date.now());
    const box = clear($("sessPills"));
    s.sessions.forEach((x) => box.append(el("span", { class: "pill " + (x.open ? "on" : "off") }, x.name + (x.open ? " · ouverte" : ""))));
    const ul = clear($("sessNotes"));
    (s.notes.length ? s.notes : ["Rien de particulier."]).forEach((n) => ul.append(el("li", { class: n.startsWith("ATTENTION") ? "warnline" : "" }, n)));
  }
  renderSessions(); setInterval(renderSessions, 30000);

  // ---------------------------------------------------------------- alertes de prix
  let alerts = store.list("alerts");
  const saveAlerts = () => store.set("alerts", alerts);
  function renderAlerts() {
    const tb = clear($("alTable").querySelector("tbody"));
    $("alEmpty").classList.toggle("hidden", alerts.length > 0);
    $("alTable").parentElement.classList.toggle("hidden", !alerts.length);
    alerts.forEach((a) => tb.append(el("tr", {},
      el("td", {}, a.pair), el("td", {}, a.side === "above" ? "au-dessus" : "en dessous"),
      el("td", { class: "mono" }, a.price), el("td", {}, a.note || ""),
      el("td", {}, a.triggered ? el("span", { class: "pill WATCH" }, `déclenchée (${a.at})`) : el("span", { class: "pill off" }, "active")),
      el("td", {}, el("button", { class: "btn ghost small", type: "button", "aria-label": `Supprimer l'alerte ${a.pair} ${a.side === "above" ? "au-dessus de" : "en dessous de"} ${fmt(a.price, 5).replace(/0+$/, "").replace(/,$/, "")}`,
        onclick: () => { alerts = alerts.filter((x) => x !== a); saveAlerts(); renderAlerts(); } }, "Supprimer")))));
  }
  function fire(list) {
    list.forEach((a) => {
      const msg = `Alerte ${a.pair} ${a.side === "above" ? "au-dessus de" : "en dessous de"} ${a.price} (prix ${a.at}). ${a.note || ""}`;
      toast(msg, 9000); D.notify("Alerte " + a.pair, msg);
    });
    if (list.length) { saveAlerts(); renderAlerts(); }
  }
  $("alForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const price = Number($("alPrice").value);
    if (!(price > 0)) { toast("Prix invalide."); return; }
    alerts.push({ id: Date.now(), pair: $("alPair").value, side: $("alSide").value, price, note: $("alNote").value.trim().slice(0, 80), triggered: null });
    saveAlerts(); renderAlerts(); $("alPrice").value = ""; $("alNote").value = "";
  });
  $("alCheck").addEventListener("click", async () => {
    const pairs = [...new Set(alerts.filter((a) => !a.triggered).map((a) => a.pair))];
    if (!pairs.length) { $("alMsg").textContent = "Aucune alerte active."; return; }
    $("alMsg").textContent = `Vérification (${pairs.length} crédit${pairs.length > 1 ? "s" : ""})…`;
    try {
      const j = await td("/price", { symbol: pairs.join(",") }, pairs.length);
      const prices = {};
      if (pairs.length === 1 && j.price != null) prices[pairs[0]] = +j.price;
      else pairs.forEach((p) => { if (j[p] && j[p].price != null) prices[p] = +j[p].price; });
      const f = A.checkAlerts(alerts, prices, Date.now());
      fire(f);
      $("alMsg").textContent = `${Object.entries(prices).map(([p, v]) => `${p} ${v}`).join(" · ")} · ${f.length} déclenchée(s).`;
    } catch (e) { $("alMsg").textContent = e.message; }
  });
  D.onPrices((prices, t) => fire(A.checkAlerts(alerts, prices, t)));
  renderAlerts();

  // ---------------------------------------------------------------- analyse technique
  const cache = {};
  let current = null, chartTf = "H1";
  $("aPair").addEventListener("change", () => { store.set("aPair", $("aPair").value); const c = cache[$("aPair").value]; if (c && Date.now() - c.at < 300000) render(c); });
  $("aTf").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    chartTf = b.dataset.tf;
    $("aTf").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    if (current) drawChart();
  }));
  /** Charge les bougies H1/H4/D1 (3 credits) et calcule l'analyse ; resultat garde en memoire. */
  async function runAnalysis(pair, onStep) {
    const series = {};
    for (const [k, interval, size] of [["h1", "1h", 500], ["h4", "4h", 300], ["d1", "1day", 300]]) {
      if (onStep) onStep(`Chargement des bougies ${interval}…`);
      series[k] = A.parseTimeSeries(await td("/time_series", { symbol: pair, interval, outputsize: size, timezone: "UTC" }, 1));
      if (!series[k]) throw new Error("Réponse de bougies illisible.");
    }
    const tech = A.technical(pair, series);
    if (tech.error) throw new Error(tech.error);
    cache[pair] = { at: Date.now(), pair, series, tech };
    return cache[pair];
  }
  $("aRun").addEventListener("click", async () => {
    const pair = $("aPair").value;
    const c = cache[pair];
    if (c && Date.now() - c.at < 300000) { render(c); $("aStatus").textContent = "Résultat de moins de 5 min (aucun crédit utilisé)."; return; }
    $("aRun").disabled = true;
    try {
      render(await runAnalysis(pair, (m) => ($("aStatus").textContent = m)));
      $("aStatus").textContent = `Analyse à jour (${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}). 3 crédits utilisés.`;
    } catch (e) { $("aStatus").textContent = e.message; toast(e.message, 6000); }
    finally { $("aRun").disabled = false; }
  });
  function render(c) {
    current = c;
    const t = c.tech, dec = t.dec;
    $("aOut").classList.remove("hidden");
    $("aPrice").textContent = `${c.pair} ${fmt(t.price, dec)}`;
    $("aTime").textContent = `Dernière bougie H1 : ${F.both(t.time, { date: true })} · prix milieu de marché`;
    $("aBias").textContent = t.bias;
    $("aBias").className = "bias " + (/^Haussier/.test(t.bias) ? "up" : /^Baissier/.test(t.bias) ? "down" : "warnline");
    const ul = clear($("aNotes")); t.notes.forEach((n) => ul.append(el("li", {}, n)));
    const tb = clear($("aTfs").querySelector("tbody"));
    t.tfs.forEach((x) => tb.append(el("tr", {}, el("td", {}, el("b", {}, x.tf)),
      el("td", { class: x.trend === "haussière" ? "up" : x.trend === "baissière" ? "down" : "" }, x.trend),
      el("td", { class: "mono" }, fmt(x.rsi, 0)), el("td", { class: "mono" }, fmt(x.atrPips, 1)), el("td", { class: "mono" }, fmt(x.eff, 2)),
      el("td", { class: "mono" }, fmt(x.ema20, dec)), el("td", { class: "mono" }, fmt(x.ema50, dec)), el("td", { class: "mono" }, fmt(x.ema200, dec)))));
    const lv = (box, list, side) => {
      clear(box);
      if (!list.length) box.append(el("p", { class: "muted" }, "Aucun niveau proche."));
      list.forEach((l) => box.append(el("button", { class: "level", type: "button", title: "Créer une alerte",
        "aria-label": `${l.label} : ${fmt(l.price, dec)}, à ${fmt(Math.abs(l.price - t.price) / t.pip, 0)} pips. Créer une alerte à ce prix`,
        onclick: () => {
          alerts.push({ id: Date.now(), pair: c.pair, side, price: +l.price.toFixed(dec), note: l.label, triggered: null });
          saveAlerts(); renderAlerts(); toast(`Alerte créée : ${c.pair} ${side === "above" ? "au-dessus de" : "en dessous de"} ${fmt(l.price, dec)}.`);
        } }, el("span", {}, l.label), el("span", { class: "mono" }, `${fmt(l.price, dec)} · ${fmt(Math.abs(l.price - t.price) / t.pip, 0)} p`))));
    };
    lv($("aRes"), t.resistances, "above"); lv($("aSup"), t.supports, "below");
    const rg = clear($("aRanges"));
    t.ranges.forEach((r) => rg.append(el("div", { class: "kvbox" }, el("span", {}, `${r.days} jours`),
      el("b", { class: "mono" }, `${fmt(r.low, dec)} – ${fmt(r.high, dec)}`), el("small", {}, `position ${fmt(r.pos * 100, 0)} %`))));
    const h1 = t.tfs.find((x) => x.tf === "H1");
    if (h1 && h1.atrPips) { $("prAtr").value = h1.atrPips.toFixed(1); $("prSpread").value = A.PAIRS[c.pair].spread; }
    drawChart();
  }

  // ----- graphique en chandeliers (canvas, sans bibliotheque)
  function drawChart() {
    if (!current) return;
    const cv = $("aChart");
    const bars = current.series[{ H1: "h1", H4: "h4", D1: "d1" }[chartTf]] || [];
    const closes = bars.map((b) => b.c);
    const e20 = A.emaSeries(closes, 20), e50 = A.emaSeries(closes, 50);
    const n = Math.min(120, bars.length), off = bars.length - n, data = bars.slice(off);
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h || !n) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const t = current.tech, dec = t.dec;
    let lo = Math.min(...data.map((b) => b.l)), hi = Math.max(...data.map((b) => b.h));
    const pad = (hi - lo) * 0.06 || t.pip * 10; lo -= pad; hi += pad;
    const padR = 66, padT = 8, padB = 20, plotW = w - padR, plotH = h - padT - padB;
    const y = (p) => padT + (hi - p) / (hi - lo) * plotH;
    const cw = plotW / n;
    ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "middle";
    // grille
    ctx.strokeStyle = col("--line"); ctx.fillStyle = col("--muted"); ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const p = lo + (hi - lo) * i / 4, yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillText(fmt(p, dec), plotW + 6, yy);
    }
    // niveaux proches
    const labelYs = [];
    const lvl = (l, color) => {
      if (l.price < lo || l.price > hi) return;
      const yy = Math.round(y(l.price)) + 0.5;
      ctx.setLineDash([4, 4]); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]);
      if (labelYs.every((v) => Math.abs(v - yy) >= 13)) {   // pas d'etiquettes superposees
        labelYs.push(yy); ctx.fillStyle = color; ctx.fillText(l.label, 4, yy - 7);
      }
    };
    t.resistances.slice(0, 3).forEach((l) => lvl(l, col("--reject")));
    t.supports.slice(0, 3).forEach((l) => lvl(l, col("--ok")));
    // bougies
    data.forEach((b, i) => {
      const x = i * cw + cw / 2, upc = b.c >= b.o;
      ctx.strokeStyle = ctx.fillStyle = upc ? col("--ok") : col("--reject");
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(b.h)); ctx.lineTo(Math.round(x) + 0.5, y(b.l)); ctx.stroke();
      const bw = Math.max(1, cw * 0.62), top = y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      ctx.fillRect(x - bw / 2, top, bw, bh);
    });
    // EMA
    const line = (series, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = series[off + i]; if (v == null) continue;
        const x = i * cw + cw / 2;
        if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
      }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    line(e20, "#f59e0b"); line(e50, "#3b82f6");
    // dernier prix
    const lp = data[n - 1].c, ly = y(lp);
    ctx.fillStyle = col("--accent"); ctx.fillRect(plotW + 2, ly - 9, padR - 4, 18);
    ctx.fillStyle = "#ffffff"; ctx.fillText(fmt(lp, dec), plotW + 6, ly);
    // dates
    ctx.fillStyle = col("--muted"); ctx.textBaseline = "alphabetic";
    const long = chartTf !== "D1" && plotW > 420;            // heure seulement si la place le permet
    const ticks = Math.max(2, Math.floor(plotW / (long ? 95 : 55)));
    for (let i = 0; i < n; i += Math.ceil(n / ticks)) {
      const d = new Date(data[i].t).toISOString();
      ctx.fillText(long ? d.slice(5, 10) + " " + d.slice(11, 16) : d.slice(5, 10), i * cw, h - 5);
    }
  }
  window.addEventListener("resize", () => { clearTimeout(drawChart.t); drawChart.t = setTimeout(drawChart, 150); });
  const tabObserver = new MutationObserver(() => { if (!$("tab-analyse").classList.contains("hidden")) drawChart(); });
  tabObserver.observe($("tab-analyse"), { attributes: true, attributeFilter: ["class"] });
  $("aToBuy").addEventListener("click", () => toPlan("buy"));
  $("aToSell").addEventListener("click", () => toPlan("sell"));
  function toPlan(dir) {
    if (!current) return;
    const t = current.tech, h1 = t.tfs.find((x) => x.tf === "H1");
    $("pPair").value = current.pair; $("pDir").value = dir; $("pEntry").value = t.price.toFixed(t.dec);
    $("pStop").value = ""; $("pAtr").value = h1 && h1.atr ? h1.atr.toFixed(t.dec + 1) : "";
    $("pSpread").value = A.PAIRS[current.pair].spread;
    updatePipValue(true); D.showTab("plan");
  }

  // ---------------------------------------------------------------- fondamental
  const ECB = "https://data-api.ecb.europa.eu/service/data/";
  const SOURCES = {
    usdRate: [["https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json", A.parseNyFedEffr]],
    usdCpi: [["https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0", A.blsYoY]],
    usdUnemp: [["https://api.bls.gov/publicAPI/v2/timeseries/data/LNS14000000", A.blsLatest]],
    eurRate: [[ECB + "FM/D.U2.EUR.4F.KR.DFR.LEV?lastNObservations=1&format=jsondata", A.parseEcbSeries]],
    eurCpi: [["https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_manr?geo=EA&coicop=CP00&unit=RCH_A&lastTimePeriod=3", A.parseEurostat],
      [ECB + "ICP/M.U2.N.000000.4.ANR?lastNObservations=1&format=jsondata", A.parseEcbSeries]],
    eurUnemp: [[ECB + "LFSI/M.I9.S.UNEHRT.TOTAL0.15_74.T?lastNObservations=1&format=jsondata", A.parseEcbSeries]],
  };
  async function loadOne(list) {
    let err = "";
    for (const [url, parse] of list) {
      try { return parse(await D.fetchJson(url, {}, 2)); } catch (e) { err = e.message; }
    }
    return { error: err || "indisponible" };
  }
  /** Donnees fondamentales (gratuites), gardees 6 h. Retourne {data, cached}. */
  async function getFund(force) {
    const c = store.get("fund", null);
    if (!force && c && typeof c === "object" && Number.isFinite(c.at) && Date.now() - c.at < 6 * 3600000) return { data: c, cached: true };
    const keys = Object.keys(SOURCES);
    const vals = await Promise.all(keys.map((k) => loadOne(SOURCES[k])));
    const data = { at: Date.now() };
    keys.forEach((k, i) => (data[k] = vals[i]));
    store.set("fund", data);
    return { data, cached: false };
  }
  async function loadFund(force) {
    $("fStatus").textContent = "Lecture des sources officielles…"; $("fRefresh").disabled = true;
    try { const r = await getFund(force); renderFund(r.data, r.cached); }
    finally { $("fRefresh").disabled = false; }
  }
  function cell(x, unit, maxDays) {
    if (!x || x.error) return el("td", { class: "muted" }, "indisponible");
    const age = A.ageDays(x.date, Date.now());
    return el("td", {}, el("b", { class: "mono" }, `${fmt(x.value, 2)} ${unit}`), el("br"),
      el("small", { class: "muted" }, x.date), age != null && age > maxDays ? el("span", { class: "pill bad tiny" }, "ancien") : null);
  }
  function renderFund(d, cached) {
    const tb = clear($("fTable").querySelector("tbody"));
    [["Taux directeur", "usdRate", "eurRate", "%", 10, "Fed Funds effectif", "taux de dépôt BCE"],
      ["Inflation sur 1 an", "usdCpi", "eurCpi", "%", 75, "CPI", "HICP"],
      ["Chômage", "usdUnemp", "eurUnemp", "%", 120, "", ""]].forEach(([label, u, e, unit, md, nu, ne]) =>
      tb.append(el("tr", {}, el("td", {}, label, nu || ne ? el("br") : null, nu || ne ? el("small", { class: "muted" }, [nu, ne].filter(Boolean).join(" / ")) : null),
        cell(d[u], unit, md), cell(d[e], unit, md))));
    const s = A.fundamentalSummary(d, Date.now());
    const ul = clear($("fNotes")); s.notes.forEach((n) => ul.append(el("li", {}, n)));
    const fails = Object.keys(SOURCES).filter((k) => d[k] && d[k].error);
    $("fStatus").textContent = `${cached ? "Données gardées" : "Données lues"} à ${new Date(d.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.` +
      (fails.length ? ` ${fails.length} source(s) indisponible(s).` : "");
    renderFundNews();
  }
  function renderFundNews() {
    const box = clear($("fNews"));
    const now = Date.now();
    const up = D.getNews().filter((e) => e.timeMs >= now - 900000 && e.timeMs <= now + 7 * 86400000);
    if (!up.length) {
      box.append(el("p", { class: "muted" }, "Aucune annonce dans les 7 prochains jours."),
        el("button", { class: "btn ghost small", type: "button", onclick: () => D.showTab("news") }, "+ Ajouter une annonce"));
      return;
    }
    const t = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Heure (Bénin)"), el("th", {}, "Devise"), el("th", {}, "Annonce"), el("th", {}, "Impact"))));
    const tb = el("tbody"); t.append(tb);
    up.forEach((e) => tb.append(el("tr", {}, el("td", {}, D.timeCell(e.timeMs)), el("td", {}, e.currency), el("td", {}, e.event),
      el("td", {}, e.impact === "high" ? "fort" : e.impact === "medium" ? "moyen" : e.impact))));
    box.append(el("div", { class: "scroll" }, t));
  }
  $("fRefresh").addEventListener("click", () => loadFund(true));
  let fundLoaded = false;
  new MutationObserver(() => {
    if ($("tab-fund").classList.contains("hidden")) return;
    renderFundNews();                                   // tes annonces : tout de suite, sans attendre les statistiques officielles
    if (!fundLoaded) { fundLoaded = true; loadFund(false); }
  }).observe($("tab-fund"), { attributes: true, attributeFilter: ["class"] });
  renderFundNews();
  if (!$("tab-fund").classList.contains("hidden")) { fundLoaded = true; loadFund(false); }

  // ---------------------------------------------------------------- synthese du jour
  $("bPair").value = store.get("bPair", "EUR/USD");
  $("bPair").addEventListener("change", () => store.set("bPair", $("bPair").value));
  async function runBrief() {
    const pair = $("bPair").value;
    $("bRun").disabled = true; $("bStatus").textContent = "Lecture du fondamental…";
    try {
      const { data } = await getFund(false);
      const c = cache[pair];
      const fresh = c && Date.now() - c.at < 30 * 60000;
      const b = A.dailyBrief({ pair, nowMs: Date.now(), fund: data, tech: fresh ? c.tech : null, news: D.getNews() });
      renderBrief(b, fresh ? c : null);
      $("bStatus").textContent = fresh ? `Technique : analyse de ${new Date(c.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`
        : "Sans partie technique : lance d'abord l'analyse technique de cette paire pour l'ajouter.";
    } catch (e) { $("bStatus").textContent = e.message; }
    finally { $("bRun").disabled = false; }
  }
  function renderBrief(b, techEntry) {
    $("bOut").classList.remove("hidden");
    $("bTitle").textContent = `${b.pair} · synthèse`;
    $("bTime").textContent = `Générée le ${D.fmtLocal(b.generatedAt)} (heure du Bénin)` + (techEntry ? ` · prix ${fmt(techEntry.tech.price, techEntry.tech.dec)}` : "");
    const cv = { "élevée": "v-no", "normale": "v-ok", "marché fermé": "v-warn" }[b.caution] || "v-warn";
    $("bCaution").className = "verdict " + cv;
    $("bCaution").textContent = b.caution.toUpperCase();
    $("bWhy").textContent = "Pourquoi : " + b.cautionWhy.join(", ") + ".";
    const box = clear($("bSections"));
    b.sections.forEach((s) => box.append(el("div", { class: "card" }, el("h2", {}, s.title),
      el("ul", { class: "notes" }, ...s.items.map((it) => el("li", {}, it))))));
  }
  $("bRun").addEventListener("click", runBrief);
  $("bTech").addEventListener("click", async () => {
    const pair = $("bPair").value;
    $("bTech").disabled = true;
    try {
      await runAnalysis(pair, (m) => ($("bStatus").textContent = m));
      if ($("aPair").value === pair) render(cache[pair]);
      await runBrief();
    } catch (e) { $("bStatus").textContent = e.message; toast(e.message, 6000); }
    finally { $("bTech").disabled = false; }
  });

  // ---------------------------------------------------------------- plan de trade
  let pvManual = false;
  $("pPv").addEventListener("input", () => { pvManual = true; });
  function updatePipValue(reset) {
    if (reset) pvManual = false;
    const pair = $("pPair").value, conv = A.conversionNeeded(pair);
    $("pConvWrap").classList.toggle("hidden", !conv);
    $("pConvName").textContent = conv ? `(${conv})` : "";
    if (!$("pSpread").value || reset) $("pSpread").value = A.PAIRS[pair].spread;
    if (pvManual) return;
    const v = A.pipValueUsd(pair, Number($("pEntry").value), Number($("pConv").value));
    $("pPv").value = v ? v.toFixed(2) : "";
  }
  $("pPair").addEventListener("change", () => updatePipValue(true));
  ["pEntry", "pConv"].forEach((id) => $(id).addEventListener("input", () => updatePipValue(false)));
  $("pForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const pair = $("pPair").value;
    const h1 = current && current.pair === pair ? current.tech.tfs.find((x) => x.tf === "H1") : null;
    const r = A.plan({
      pair, dir: $("pDir").value, entry: Number($("pEntry").value), stop: $("pStop").value ? Number($("pStop").value) : null,
      stopAtr: Number($("pStopAtr").value), atr: Number($("pAtr").value), atrH1: h1 ? h1.atr : Number($("pAtr").value) || null,
      rr: $("pRR").value.split(/[\s,;]+/).map(Number).filter((x) => x > 0).slice(0, 5),
      target: $("pTarget").value ? Number($("pTarget").value) : null, spreadPips: Number($("pSpread").value),
      balance: Number($("pBal").value), riskPct: Number($("pRisk").value), pipValue: Number($("pPv").value) || null,
      minRR: Number($("pMinRR").value) || 1.5, news: D.getNews(), nowMs: Date.now(), windowHours: 4,
    });
    const out = clear($("pOut"));
    if (r.error) { out.append(el("p", { class: "err" }, "Impossible : " + r.error + ".")); return; }
    const dec = A.PAIRS[pair].dec;
    out.append(el("div", { class: "verdict v-" + (r.verdict === "OK" ? "ok" : r.verdict === "NON" ? "no" : "warn") }, r.verdict));
    out.append(el("div", { class: "grid3" },
      el("div", { class: "kvbox" }, el("span", {}, "Entrée → stop"), el("b", { class: "mono" }, `${fmt(r.entry, dec)} → ${fmt(r.stop, dec)}`), el("small", {}, `${fmt(r.stopPips, 1)} pips + spread ${r.spread} p`)),
      el("div", { class: "kvbox" }, el("span", {}, "Taille"), el("b", { class: r.size && !r.size.allowed ? "down" : "mono" }, r.size ? (r.size.allowed ? `${fmt(r.size.lots, 2)} lot` : "refusé") : "–"),
        el("small", {}, r.size ? `risque ${fmt(r.size.riskUsd, 2)} $ (${fmt(r.size.riskPct, 2)} %)` : "valeur du pip inconnue")),
      el("div", { class: "kvbox" }, el("span", {}, "Objectifs"), ...r.targets.map((t) => el("small", { class: "mono" }, `${fmt(t.price, dec)} · ${fmt(t.pips, 0)} p · R net ${fmt(t.rrNet, 2)}`)))));
    const ul = el("ul", { class: "checks" });
    r.checks.forEach((c) => ul.append(el("li", {}, el("span", { class: "pill " + (c.level === "OK" ? "on" : c.level === "NON" ? "bad" : "WATCH") }, c.level), " ", c.msg)));
    out.append(ul);
    if (window.Journal) {
      out.append(el("button", { class: "btn ghost", type: "button", onclick: () => {
        window.Journal.openNew({
          symbol: pair, side: r.dir, status: "OPEN", entry: +r.entry.toFixed(dec), sl: +r.stop.toFixed(dec),
          tp: r.targets.length ? +r.targets[0].price.toFixed(dec) : null, lots: r.size && r.size.allowed ? r.size.lots : null,
          pipValue: Number($("pPv").value) || null, entryTime: Date.now(),
          notes: `Plan ${r.verdict} : ${r.checks.filter((c) => c.level !== "OK").map((c) => c.msg).join(" ; ") || "toutes les vérifications OK"}`,
        });
        toast("Plan copié dans un nouveau trade du journal : complète-le et enregistre.");
      } }, "Copier dans le journal"));
    }
    out.append(el("p", { class: "muted small" }, "Calcul papier. Aucun ordre n'est passé. Vérifie le prix réel (ask/bid) et le spread chez ton courtier."));
  });
  updatePipValue(true);

  // ---------------------------------------------------------------- pre-test
  $("prForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const win = Number($("prWin").value);
    const r = A.pretest({ atrPips: Number($("prAtr").value), stopAtr: Number($("prStopAtr").value), rr: Number($("prRR").value),
      spreadPips: Number($("prSpread").value), slippagePips: Number($("prSlip").value), commissionPerLot: Number($("prComm").value),
      pipValuePerLot: Number($("prPv").value), winRate: win > 0 ? win / 100 : null });
    const out = clear($("prOut"));
    if (r.error) { out.append(el("p", { class: "err" }, r.error)); return; }
    out.append(el("div", { class: "verdict v-" + (r.verdict === "IDÉE TESTABLE" ? "ok" : r.verdict === "DIFFICILE" ? "warn" : "no") }, r.verdict));
    const ul = el("ul", { class: "notes" });
    [`Stop : ${fmt(r.stopPips, 1)} pips. Coût d'un trade : ${fmt(r.costPips, 2)} pips, soit ${fmt(r.costAtr * 100, 0)} % de l'ATR et ${fmt(r.costR, 2)} R.`,
      `Taux de réussite minimal pour ne pas perdre (coûts compris) : ${fmt(r.breakeven * 100, 1)} %.`,
      `Taux visé par prudence (espérance ≥ 3 × le coût) : ${fmt(r.target * 100, 1)} %.`,
      r.expectancy != null ? `Avec ${win} % de réussite : espérance nette ${r.expectancy >= 0 ? "+" : ""}${fmt(r.expectancy, 2)} R par trade.` : null,
      r.expectancy != null ? (r.tradesToProve ? `Il faudrait environ ${r.tradesToProve} trades pour distinguer cet avantage du hasard (95 %).` : "Espérance négative ou nulle : pas d'avantage à prouver.") : null,
    ].filter(Boolean).forEach((t) => ul.append(el("li", {}, t)));
    out.append(ul, el("p", { class: "muted small" }, "Un pré-test ne remplace pas un backtest hors échantillon, puis un test en démo."));
  });
  $("prAtr").placeholder = "lance une analyse ou saisis l'ATR";
})();
