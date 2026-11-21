/* Desk Forex : onglet Comptes (comptes, regles de challenge, jauges, statut, lot maximum, modeles).
 * Les calculs sont dans challenge-core.js (teste). Aucune regle de vraie prop firm n'est codee. Aucun ordre.
 */
(function () {
  "use strict";
  const C = window.ChallengeCore, JC = window.JournalCore, J = window.Journal, D = window.DeskApp, A = window.Analysis, DB = window.DeskDB;
  if (!C || !JC || !J || !D || !A || !DB) return;
  const { el, clear, toast } = D;
  const $ = (id) => document.getElementById(id);
  let editingId = null, templates = [];
  const alerted = new Set();          // alertes deja signalees pendant cette visite

  const F = window.Fmt, nb = (v, d) => F.num(v, d);         // affichage francais : 1 234,56
  const money = (v) => F.signed(v, 2);
  const plain = (v) => F.num(v, 2);
  const opt = (v, l, sel) => { const o = el("option", { value: v }, l); if (sel) o.selected = true; return o; };

  // ---------------------------------------------------------------- initialisation
  Object.entries(C.ACCOUNT_TYPES).forEach(([k, l]) => $("acfType").append(opt(k, l)));
  Object.keys(A.PAIRS).forEach((p) => $("lmPair").append(opt(p, p)));
  (async () => { const t = await DB.get("meta", "ruleTemplates"); templates = (t && t.value) || []; renderTemplates(); })();

  // ---------------------------------------------------------------- liste des comptes
  function evalAll() {
    const st = J.getState(), news = D.getNews(), now = Date.now();
    return st.accounts.map((a) => ({ a, ev: C.evaluate(a, st.enriched.filter((x) => x.t.accountId === a.id), { nowMs: now, news }) }));
  }
  function gauge(label, frac, lvl, text) {
    const bar = el("div", { class: "gauge-bar" }, el("div", { class: "gauge-fill " + lvl }));
    bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, frac || 0)) * 100) + "%";
    return el("div", { class: "gauge" }, el("div", { class: "row between" }, el("span", {}, label), el("b", { class: "mono" }, text)), bar);
  }
  function render() {
    const box = clear($("acList"));
    const all = evalAll();
    all.forEach(({ a, ev }) => {
      const hasRules = ev.rules.newsBan || ["profitTargetPct", "dailyLossPct", "maxDDPct", "minTradingDays", "maxDays", "consistencyPct", "maxRiskPerTradePct"].some((k) => ev.rules[k]);
      const statusCls = { "EN COURS": "WATCH", "OBJECTIF ATTEINT": "on", "RÈGLE VIOLÉE": "bad" }[ev.status];
      const card = el("div", { class: "card account" },
        el("div", { class: "row between wrap" },
          el("div", {}, el("b", { class: "acc-name" }, a.name), " ", el("span", { class: "pill off" }, C.ACCOUNT_TYPES[a.type] || a.type)),
          hasRules ? el("span", { class: "verdict small-verdict " + { "EN COURS": "v-warn", "OBJECTIF ATTEINT": "v-ok", "RÈGLE VIOLÉE": "v-no" }[ev.status] }, ev.status)
            : el("span", { class: "pill " + statusCls }, "sans règles")),
        el("div", { class: "grid3" },
          el("div", { class: "kvbox" }, el("span", {}, "Solde"), el("b", { class: "mono" }, `${plain(ev.balance)} ${a.currency || "USD"}`),
            el("small", {}, `départ ${plain(+a.startBalance)} · ${money(ev.profit)}`)),
          el("div", { class: "kvbox" }, el("span", {}, "Équité"), el("b", { class: "mono" }, ev.equity != null ? plain(ev.equity) : "inconnue"),
            el("small", {}, lastSnapText(a))),
          el("div", { class: "kvbox" }, el("span", {}, "Jours"), el("b", { class: "mono" }, `${ev.tradingDays} jour(s) tradé(s)`),
            el("small", {}, `${ev.daysElapsed} jour(s) écoulé(s)${ev.rules.maxDays ? " sur " + ev.rules.maxDays : ""}${ev.rules.minTradingDays ? " · minimum " + ev.rules.minTradingDays : ""}`))));
      const gauges = el("div", { class: "gauges" });
      if (ev.target != null) gauges.append(gauge(`Objectif ${ev.rules.profitTargetPct} % (${plain(ev.target)})`, ev.progress, ev.progress >= 1 ? "ok" : "accent",
        `${money(ev.profit)} · ${Math.round(Math.min(ev.progress, 9.99) * 100)} %`));
      if (ev.daily) gauges.append(gauge(`Marge perte journalière (limite ${plain(ev.daily.limit)})`, ev.daily.remainFrac, ev.daily.level,
        `reste ${plain(Math.max(0, ev.daily.remain))} · ${Math.round(ev.daily.remainFrac * 100)} %`));
      if (ev.dd) gauges.append(gauge(`Marge drawdown ${ev.dd.mode === "trailing" ? "suiveur" : "statique"} sur ${ev.dd.basis === "equity" ? "l'équité" : "le solde"} (plancher ${plain(ev.dd.floor)})`,
        ev.dd.remainFrac, ev.dd.level, `reste ${plain(Math.max(0, ev.dd.remain))} · ${Math.round(ev.dd.remainFrac * 100)} %`));
      if (ev.rules.consistencyPct) gauges.append(el("p", { class: "small " + (ev.consistencyOk ? "" : "warnline") },
        `Consistance : ${ev.consistencyRatio == null ? "pas encore de profit" : `meilleur jour = ${nb(ev.consistencyRatio, 0)} % du profit`} (maximum ${ev.rules.consistencyPct} %) ${ev.consistencyOk ? "✓" : "✗"}`));
      if (gauges.childNodes.length) card.append(gauges);
      const lists = el("div", {});
      ev.violations.forEach((v) => lists.append(el("p", { class: "err small" }, `Règle violée : ${v.rule} — ${v.detail}`)));
      ev.alerts.forEach((x) => lists.append(el("p", { class: "warnline small" }, "Alerte : " + x)));
      if (ev.status === "EN COURS") ev.pending.forEach((x) => lists.append(el("p", { class: "muted small" }, "À atteindre : " + x)));
      ev.notes.forEach((x) => lists.append(el("p", { class: "muted small" }, x)));
      if (window.DashboardCore && (a.cashflows || []).length) {
        const net = window.DashboardCore.flowsOf(a).reduce((s, f) => s + window.DashboardCore.signed(f), 0);
        lists.append(el("p", { class: "muted small" }, `Dépôts et retraits : ${net >= 0 ? "+" : ""}${nb(net, 2)} au total. Ils sont comptés dans le solde du Dashboard ; les règles de challenge ci-dessus utilisent seulement les trades.`));
      }
      card.append(lists);
      card.append(el("div", { class: "row wrap" },
        el("button", { class: "btn ghost small", type: "button", onclick: () => openForm(a.id) }, "Modifier"),
        el("button", { class: "btn ghost small", type: "button", onclick: () => addEquity(a, ev) }, "Saisir l'équité actuelle"),
        el("button", { class: "btn ghost small", type: "button", onclick: () => J.showAccount(a.id) }, "Voir ses trades")));
      box.append(card);
      // alertes : une seule notification par probleme et par visite
      ev.violations.concat(ev.alerts.map((x) => ({ rule: "alerte", detail: x }))).forEach((v) => {
        const k = `${a.id}|${v.rule}|${v.detail.slice(0, 40)}`;
        if (alerted.has(k)) return;
        alerted.add(k);
        if (v.rule === "alerte") { D.notify(`Desk Forex : ${a.name}`, v.detail); }
        else D.notify(`Desk Forex : ${a.name} — règle violée`, `${v.rule} : ${v.detail}`);
      });
    });
    renderLotAccounts();
  }
  function lastSnapText(a) {
    const s = (a.equitySnapshots || []).slice(-1)[0];
    return s ? `saisie le ${JC.fmtLocal(s.t)}${s.source && s.source !== "manuel" ? " (" + s.source + ")" : ""}` : "aucune valeur saisie";
  }
  async function addEquity(a, ev) {
    const v = prompt(`Équité actuelle de « ${a.name} » (solde + gains/pertes latents des positions ouvertes) :`, ev.equity != null ? ev.equity.toFixed(2) : ev.balance.toFixed(2));
    if (v == null) return;
    const n = Number(String(v).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { toast("Valeur invalide."); return; }
    const snaps = (a.equitySnapshots || []).concat([{ t: Date.now(), equity: n, balance: ev.balance, source: "manuel" }]).slice(-200);
    await J.saveAccount(Object.assign({}, a, { equitySnapshots: snaps }));
    toast("Équité enregistrée.");
  }

  // ---------------------------------------------------------------- formulaire de compte
  const RULE_FIELDS = { ruTarget: "profitTargetPct", ruDaily: "dailyLossPct", ruDD: "maxDDPct", ruMinDays: "minTradingDays",
    ruMaxDays: "maxDays", ruConsistency: "consistencyPct", ruMaxRisk: "maxRiskPerTradePct", ruNewsWin: "newsWindowMin", ruReset: "dayResetHourLocal" };
  function fillRules(r) {
    r = C.normalizeRules(r);
    Object.entries(RULE_FIELDS).forEach(([id, k]) => ($(id).value = r[k] == null ? "" : r[k]));
    $("ruDailyBase").value = r.dailyBase; $("ruDDMode").value = r.ddMode; $("ruDDBasis").value = r.ddBasis;
    $("ruTrailLock").checked = r.trailLock; $("ruNewsBan").checked = r.newsBan;
  }
  function readRules() {
    const r = {};
    Object.entries(RULE_FIELDS).forEach(([id, k]) => (r[k] = $(id).value === "" ? null : Number($(id).value)));
    r.dailyBase = $("ruDailyBase").value; r.ddMode = $("ruDDMode").value; r.ddBasis = $("ruDDBasis").value;
    r.trailLock = $("ruTrailLock").checked; r.newsBan = $("ruNewsBan").checked;
    return C.normalizeRules(r);
  }
  function openForm(id) {
    const st = J.getState();
    const a = id ? st.accounts.find((x) => x.id === id) : { name: "", type: "challenge", currency: "USD", startBalance: "", startDate: Date.now(), rules: {} };
    editingId = id || null;
    $("acfTitle").textContent = id ? "Modifier le compte" : "Nouveau compte";
    $("acfName").value = a.name; $("acfType").value = a.type || "demo"; $("acfCcy").value = a.currency || "USD";
    $("acfStart").value = a.startBalance; $("acfStartDate").value = a.startDate ? JC.toLocalInput(a.startDate).slice(0, 10) : "";
    fillRules(a.rules);
    $("acfDelete").classList.toggle("hidden", !id);
    $("acFormCard").classList.remove("hidden");
    $("acFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("acNew").addEventListener("click", () => openForm(null));
  window.DeskAccounts = { edit: openForm };     // utilise par le Dashboard (options avancees des regles)
  $("acfCancel").addEventListener("click", () => $("acFormCard").classList.add("hidden"));
  $("acfForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = J.getState(), old = editingId ? st.accounts.find((x) => x.id === editingId) : null;
    const start = Number($("acfStart").value);
    if (!(start > 0)) { toast("Indique un solde de départ supérieur à 0."); return; }
    const a = Object.assign({}, old || {}, {
      id: editingId || "acc" + Date.now().toString(36), name: $("acfName").value.trim().slice(0, 40) || "Compte",
      type: $("acfType").value, currency: $("acfCcy").value, startBalance: start,
      startDate: $("acfStartDate").value ? JC.parseLocalInput($("acfStartDate").value + "T00:00") : null,
      rules: readRules(), equitySnapshots: (old && old.equitySnapshots) || [],
    });
    await J.saveAccount(a);
    $("acFormCard").classList.add("hidden");
    toast(editingId ? "Compte modifié." : "Compte créé. Choisis-le dans tes trades (champ Compte).");
  });
  $("acfDelete").addEventListener("click", async () => {
    if (!editingId || !confirm("Supprimer ce compte ?")) return;
    const err = await J.deleteAccount(editingId);
    if (err) { toast(err, 6000); return; }
    $("acFormCard").classList.add("hidden"); toast("Compte supprimé.");
  });

  // ---------------------------------------------------------------- modeles de regles
  function renderTemplates() {
    const s = $("acfTemplate"), keep = s.value;
    clear(s); s.append(opt("", "Appliquer un modèle…"));
    templates.forEach((t, i) => s.append(opt(String(i), t.name, String(i) === keep)));
  }
  $("acfTemplate").addEventListener("change", () => {
    const t = templates[Number($("acfTemplate").value)];
    if (t) { fillRules(t.rules); toast(`Modèle « ${t.name} » appliqué : vérifie puis enregistre.`); }
  });
  $("acfSaveTpl").addEventListener("click", async () => {
    const name = (prompt("Nom du modèle (par exemple : « Mon challenge phase 1 ») :") || "").trim().slice(0, 40);
    if (!name) return;
    templates = templates.filter((t) => t.name !== name).concat([{ name, rules: readRules() }]).slice(-30);
    await DB.put("meta", { key: "ruleTemplates", value: templates });
    renderTemplates(); toast("Modèle enregistré.");
  });
  $("acfDelTpl").addEventListener("click", async () => {
    const i = $("acfTemplate").value;
    if (i === "") { toast("Choisis d'abord un modèle dans la liste."); return; }
    if (!confirm(`Supprimer le modèle « ${templates[Number(i)].name} » ?`)) return;
    templates.splice(Number(i), 1);
    await DB.put("meta", { key: "ruleTemplates", value: templates });
    renderTemplates(); toast("Modèle supprimé.");
  });

  // ---------------------------------------------------------------- lot maximum
  function renderLotAccounts() {
    const s = $("lmAccount"), keep = s.value;
    clear(s);
    J.getState().accounts.forEach((a) => s.append(opt(a.id, a.name, a.id === keep)));
  }
  function autoPip() {
    const p = $("lmPair").value;
    $("lmSpread").placeholder = String(A.PAIRS[p].spread);
    const pv = A.pipValueUsd(p, null, null) || (p.startsWith("USD/") ? null : null);
    $("lmPv").placeholder = pv ? `auto : ${nb(pv, 2)}` : "à saisir";
  }
  $("lmPair").addEventListener("change", autoPip);
  $("lmForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const all = evalAll(), cur = all.find((x) => x.a.id === $("lmAccount").value);
    const out = clear($("lmOut"));
    if (!cur) return;
    const p = $("lmPair").value, ev = cur.ev;
    const pv = Number($("lmPv").value) || A.pipValueUsd(p, null, null);
    const limits = [];
    if (ev.daily) limits.push({ name: "marge perte journalière", amount: Math.max(0, ev.daily.remain) });
    if (ev.dd) limits.push({ name: "marge avant le drawdown max", amount: Math.max(0, ev.dd.remain) });
    if (ev.rules.maxRiskPerTradePct) limits.push({ name: `risque max ${ev.rules.maxRiskPerTradePct} % par trade`, amount: ev.balance * ev.rules.maxRiskPerTradePct / 100 });
    const r = C.maxLot({ stopPips: Number($("lmStop").value), spreadPips: $("lmSpread").value === "" ? A.PAIRS[p].spread : Number($("lmSpread").value), pipValue: pv, limits });
    if (r.error) { out.append(el("p", { class: "err" }, r.error === "stop (pips) et valeur du pip requis" && !pv ? "Valeur du pip à saisir pour cette paire (paire croisée ou cotée en autre devise que USD)." : r.error)); return; }
    out.append(el("div", { class: "result" }, r.allowed ? el("b", { class: "mono" }, `${nb(r.lots, 2)} lot maximum`) : el("b", { class: "down" }, "Aucun lot possible"),
      r.allowed ? ` — perte au stop ${nb(r.risk, 2)} (spread compris)` : ` — ${r.reason}`));
    const ul = el("ul", { class: "notes small" });
    limits.forEach((l) => ul.append(el("li", { class: l.name === r.binding.name ? "warnline" : "" }, `${l.name} : ${nb(l.amount, 2)}${l.name === r.binding.name ? " ← limite la plus serrée" : ""}`)));
    out.append(ul, el("p", { class: "muted small" }, `Perte au stop pour 1 lot : ${nb(r.perLot, 2)}. Arrondi vers le bas. Calcul papier : vérifie la taille de lot et la valeur du pip chez ton courtier.`));
  });

  // ---------------------------------------------------------------- mises a jour
  J.onChange(render);
  setInterval(() => { if (!$("tab-accounts").classList.contains("hidden")) render(); }, 60000);   // remise a zero journaliere
  new MutationObserver(() => { if (!$("tab-accounts").classList.contains("hidden")) render(); }).observe($("tab-accounts"), { attributes: true, attributeFilter: ["class"] });
  autoPip();
  render();
})();
