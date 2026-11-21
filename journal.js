/* Desk Forex : interface du journal de trading (trades, statistiques, revue, reglages, sauvegardes).
 * Les calculs sont dans journal-core.js (teste). Aucun ordre n'est passe.
 */
(function () {
  "use strict";
  const JC = window.JournalCore, DB = window.DeskDB, D = window.DeskApp, A = window.Analysis;
  if (!JC || !DB || !D || !A) return;
  const { el, clear, toast } = D;
  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const PAIRS = Object.keys(A.PAIRS);

  let trades = [], accounts = [], prefs = clone(JC.DEFAULT_PREFS), enriched = [];
  let view = "trades", editingId = null, editingSource = "manual", editingTicket = null;
  const nowL = JC.local(Date.now());
  let calY = nowL.y, calM = nowL.m, reviewWeek = JC.weekStart(Date.now());

  // ---------------------------------------------------------------- formats
  const money = (v) => (v == null || !Number.isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(2) + " $");
  const fix = (v, d = 1) => (v == null || !Number.isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(d));
  const pct = (v, d = 0) => (v == null || !Number.isFinite(v) ? "–" : (v * 100).toFixed(d) + " %");
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  const opt = (v, label, sel) => { const o = el("option", { value: v }, label == null ? v : label); if (sel) o.selected = true; return o; };
  const fillSelect = (s, items, value, first) => {
    clear(s); if (first !== undefined) s.append(opt("", first));
    items.forEach((it) => s.append(opt(typeof it === "string" ? it : it.v, typeof it === "string" ? it : it.l, (typeof it === "string" ? it : it.v) === value)));
    if (value && ![...s.options].some((o) => o.value === value)) s.append(opt(value, value, true));   // valeur hors liste conservee
  };
  const newId = () => "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------------------------------------------------------------- chargement et migration
  async function load() {
    try {
      await DB.open();
      accounts = await DB.getAll("accounts");
      if (!accounts.length) {
        const start = Number(D.store.get("jStart", 68)) || 68;      // solde de l'ancien journal
        accounts = [Object.assign(clone(JC.DEFAULT_ACCOUNT), { startBalance: start })];
        await DB.putMany("accounts", accounts);
      }
      const p = await DB.get("meta", "prefs");
      if (p && p.value) prefs = Object.assign(clone(JC.DEFAULT_PREFS), p.value);
      trades = await DB.getAll("trades");
      const mig = await DB.get("meta", "migratedV1");
      if (!mig) {
        const old = D.store.get("journal", []);
        if (Array.isArray(old) && old.length) {
          const conv = JC.migrateV1(old, accounts[0].id).filter((c) => !trades.some((t) => t.id === c.id));
          await DB.putMany("trades", conv);
          trades = trades.concat(conv);
          toast(`${conv.length} ligne(s) de l'ancien journal reprise(s) dans le nouveau journal.`, 7000);
        }
        await DB.put("meta", { key: "migratedV1", value: Date.now() });   // l'ancienne cle reste en place, par securite
      }
      $("jStoreInfo").textContent = DB.isFallback() ? "localStorage, IndexedDB indisponible ici" : "IndexedDB";
    } catch (e) {
      $("jStoreInfo").textContent = "erreur de stockage : " + e.message;
    }
    renderStatic();
    refresh();
  }

  function recompute() { enriched = JC.enrich(trades, accounts, prefs.maxRiskPct); }
  const listeners = [];
  function refresh() {
    recompute();
    renderFilterOptions();
    renderList();
    if (view === "stats") renderStats();
    if (view === "review") renderReview();
    listeners.forEach((fn) => { try { fn(); } catch (e) { /* un module ne bloque pas le journal */ } });
  }

  // ---------------------------------------------------------------- listes et filtres
  function renderStatic() {
    fillSelect($("jfStatus"), JC.STATUSES, "CLOSED");
    fillSelect($("jfSymbol"), PAIRS, "EUR/USD");
    fillSelect($("jfTfA"), JC.TIMEFRAMES, "", "–");
    fillSelect($("jfTfE"), JC.TIMEFRAMES, "", "–");
    fillSelect($("fSession"), JC.SESSIONS, "", "Toutes les sessions");
    fillSelect($("fStatus"), JC.STATUSES, "", "Tous les statuts");
    fillSelect($("fSymbol"), PAIRS, "", "Tous les symboles");
    renderPrefsForm();
  }
  function renderFilterOptions() {
    const keep = (id) => $(id).value;
    const setups = [...new Set(prefs.setups.concat(trades.map((t) => t.setup).filter(Boolean)))];
    fillSelect($("fSetup"), setups, keep("fSetup"), "Tous les setups");
    fillSelect($("fAccount"), accounts.map((a) => ({ v: a.id, l: a.name })), keep("fAccount"), "Tous les comptes");
  }
  function periodRange() {
    const p = $("fPeriod").value, now = Date.now(), l = JC.local(now), off = JC.LOCAL_OFFSET_MIN * 60000;
    if (p === "7") return { from: now - 7 * 86400000 };
    if (p === "30") return { from: now - 30 * 86400000 };
    if (p === "month") return { from: Date.UTC(l.y, l.m - 1, 1) - off };
    if (p === "year") return { from: Date.UTC(l.y, 0, 1) - off };
    if (p === "custom") {
      const f = JC.parseLocalInput($("fFrom").value + "T00:00"), t = JC.parseLocalInput($("fTo").value + "T00:00");
      return { from: f, to: t != null ? t + 86400000 : null };
    }
    return {};
  }
  function filter(includeStatus) {
    const r = periodRange();
    return { from: r.from, to: r.to, symbol: $("fSymbol").value, setup: $("fSetup").value, session: $("fSession").value,
      accountId: $("fAccount").value, status: includeStatus ? $("fStatus").value : "" };
  }
  function startBalanceFor(accountId) {
    const list = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
    return list.reduce((s, a) => s + (Number(a.startBalance) || 0), 0);
  }
  ["fPeriod", "fFrom", "fTo", "fSymbol", "fSetup", "fSession", "fAccount", "fStatus"].forEach((id) => $(id).addEventListener("change", () => {
    const custom = $("fPeriod").value === "custom";
    $("fFrom").classList.toggle("hidden", !custom); $("fTo").classList.toggle("hidden", !custom);
    refresh();
  }));

  // ---------------------------------------------------------------- navigation interne
  $("jNav").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.v)));
  function setView(v) {
    view = v;
    $("jNav").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
    ["trades", "stats", "review", "prefs"].forEach((k) => $("jv-" + k).classList.toggle("hidden", k !== v));
    $("jFilters").classList.toggle("hidden", v === "prefs" || v === "review");
    $("fStatus").classList.toggle("hidden", v !== "trades");
    if (v === "stats") renderStats();
    if (v === "review") renderReview();
  }

  // ---------------------------------------------------------------- liste des trades
  function renderList() {
    const list = JC.filterTrades(enriched, filter(true)).sort((a, b) => (b.t.entryTime || 0) - (a.t.entryTime || 0));
    const tb = clear($("jList").querySelector("tbody"));
    list.forEach(({ t, m }) => {
      const tr = el("tr", { class: "tap", title: "Ouvrir la fiche" },
        el("td", { class: "mono" }, t.entryTime ? JC.fmtLocal(t.entryTime) : "–"), el("td", {}, t.symbol),
        el("td", {}, t.side === "sell" ? "vente" : "achat"),
        el("td", {}, el("span", { class: "pill " + statusCls(t.status) }, t.status)),
        el("td", { class: "mono" }, t.lots != null ? t.lots : "–"),
        el("td", { class: "mono " + cls(m.pips) }, fix(m.pips)),
        el("td", { class: "mono " + cls(m.net) }, money(m.net)),
        el("td", { class: "mono " + cls(m.r) }, fix(m.r, 2)),
        el("td", {}, t.setup || ""), el("td", {}, m.session || ""), el("td", {}, t.quality || ""),
        el("td", { title: m.inPlan == null ? "checklist non remplie" : m.inPlan ? "dans le plan" : "hors plan" }, m.inPlan == null ? "–" : m.inPlan ? "✓" : "✗"),
        el("td", {}, t.screenshot ? el("a", { href: t.screenshot, target: "_blank", rel: "noopener noreferrer", onclick: (e) => e.stopPropagation() }, "capture") : ""));
      tr.addEventListener("click", () => openEdit(t.id));
      tb.append(tr);
    });
    $("jEmpty").classList.toggle("hidden", list.length > 0);
    const closed = list.filter((x) => x.t.status === "CLOSED" && x.m.net != null);
    $("jCount").textContent = `${list.length} ligne(s) · ${closed.length} clôturée(s) · net ${money(closed.reduce((s, x) => s + x.m.net, 0))}`;
  }
  const statusCls = (s) => ({ CLOSED: "on", OPEN: "WATCH", WATCH: "off", REJECT: "bad", UNFILLED: "off" }[s] || "off");

  // ---------------------------------------------------------------- formulaire
  function checkboxes(box, items, checkedFn, name) {
    clear(box);
    items.forEach((it) => {
      const id = name + "-" + Math.random().toString(36).slice(2, 8);
      const cb = el("input", { type: "checkbox", id, "data-item": it });
      cb.checked = !!checkedFn(it);
      cb.addEventListener("change", preview);
      box.append(el("label", { class: "check", for: id }, cb, it));
    });
  }
  function fillForm(t) {
    fillSelect($("jfAccount"), accounts.map((a) => ({ v: a.id, l: a.name })), t.accountId || accounts[0].id);
    fillSelect($("jfStatus"), JC.STATUSES, t.status || "CLOSED");
    fillSelect($("jfSymbol"), PAIRS, t.symbol || "EUR/USD");
    $("jfSide").value = t.side === "sell" ? "sell" : "buy";
    const set = (id, v) => ($(id).value = v == null ? "" : v);
    set("jfLots", t.lots); set("jfEntry", t.entry); set("jfSl", t.sl); set("jfTp", t.tp); set("jfExit", t.exit);
    set("jfPipValue", t.pipValue); set("jfGross", t.grossOverride); set("jfCommission", t.commission); set("jfSwap", t.swap);
    $("jfEntryTime").value = JC.toLocalInput(t.entryTime); $("jfExitTime").value = JC.toLocalInput(t.exitTime);
    fillSelect($("jfSetup"), prefs.setups, t.setup || "", "–");
    fillSelect($("jfTfA"), JC.TIMEFRAMES, t.tfAnalysis || "", "–");
    fillSelect($("jfTfE"), JC.TIMEFRAMES, t.tfEntry || "", "–");
    $("jfQuality").value = t.quality || "";
    fillSelect($("jfEmoBefore"), prefs.emotions, t.emotionBefore || "", "–");
    fillSelect($("jfEmoAfter"), prefs.emotions, t.emotionAfter || "", "–");
    const cl = t.checklist || {};
    checkboxes($("jfChecklist"), [...new Set(prefs.checklist.concat(Object.keys(cl)))], (it) => cl[it], "cl");
    checkboxes($("jfErrors"), [...new Set(prefs.errors.concat(t.errors || []))], (it) => (t.errors || []).includes(it), "er");
    set("jfShot", t.screenshot); set("jfNotes", t.notes);
    editingSource = t.source || "manual"; editingTicket = t.ticket || null;
    $("jfSource").textContent = t.source === "mt5" ? `importé de MT5 (ticket ${t.ticket})` : t.source === "v1" ? "repris de l'ancien journal" : "";
    preview();
  }
  function collect() {
    const n = (id) => ($(id).value === "" ? null : Number($(id).value));
    const old = trades.find((x) => x.id === editingId);
    // aucune case cochee = checklist non remplie (et non "hors plan") ; un ecart volontaire se note avec l'erreur "Hors plan"
    const boxes = [...$("jfChecklist").querySelectorAll("input")];
    const checklist = {};
    if (boxes.some((c) => c.checked)) boxes.forEach((c) => (checklist[c.dataset.item] = c.checked));
    return {
      id: editingId || newId(), accountId: $("jfAccount").value, status: $("jfStatus").value, symbol: $("jfSymbol").value,
      side: $("jfSide").value, lots: n("jfLots"), entry: n("jfEntry"), sl: n("jfSl"), tp: n("jfTp"), exit: n("jfExit"),
      pipValue: n("jfPipValue"), grossOverride: n("jfGross"), commission: n("jfCommission"), swap: n("jfSwap"),
      entryTime: JC.parseLocalInput($("jfEntryTime").value), exitTime: JC.parseLocalInput($("jfExitTime").value),
      setup: $("jfSetup").value, tfAnalysis: $("jfTfA").value, tfEntry: $("jfTfE").value, quality: $("jfQuality").value,
      checklist, emotionBefore: $("jfEmoBefore").value, emotionAfter: $("jfEmoAfter").value,
      errors: [...$("jfErrors").querySelectorAll("input")].filter((c) => c.checked).map((c) => c.dataset.item),
      screenshot: $("jfShot").value.trim(), notes: $("jfNotes").value.trim(),
      source: editingSource, ticket: editingTicket,
      createdAt: old ? old.createdAt : Date.now(), updatedAt: Date.now(),
    };
  }
  function metricsFor(t) {
    const list = JC.enrich(trades.filter((x) => x.id !== t.id).concat([t]), accounts, prefs.maxRiskPct);
    return list.find((x) => x.t.id === t.id).m;
  }
  function preview() {
    const t = collect(), m = metricsFor(t);
    const auto = A.pipValueUsd(t.symbol, t.entry, null);
    $("jfPipValue").placeholder = auto ? `auto : ${auto.toFixed(2)}` : "à saisir (paire croisée)";
    const box = clear($("jfPreview"));
    const kv = (label, value, c) => el("div", { class: "kvbox" }, el("span", {}, label), el("b", { class: "mono " + (c || "") }, value));
    box.append(el("div", { class: "grid3" },
      kv("Risque", m.riskUsd != null ? `${m.riskUsd.toFixed(2)} $ (${m.riskPct != null ? m.riskPct.toFixed(2) : "?"} %)` : "–"),
      kv("Stop / objectif", `${m.slPips != null ? m.slPips.toFixed(1) : "–"} p / ${m.tpPips != null ? m.tpPips.toFixed(1) : "–"} p${m.plannedRR != null ? " (R " + m.plannedRR.toFixed(2) + ")" : ""}`),
      kv("Résultat", `${fix(m.pips)} p · ${money(m.net != null ? m.net : m.gross)}${m.r != null ? " · " + fix(m.r, 2) + " R" : ""}`, cls(m.net != null ? m.net : m.gross)),
      kv("Durée", JC.fmtDuration(m.durationMs) || "–"),
      kv("Session · jour", m.session ? `${m.session} · ${m.weekday}` : "–"),
      kv("Plan", m.inPlan == null ? "checklist à remplir" : m.inPlan ? `respecté (${m.checklistOk}/${m.checklistTotal})` : `hors plan (${m.checklistOk}/${m.checklistTotal})`, m.inPlan === false ? "down" : m.inPlan ? "up" : "")));
    if (t.entryTime) box.append(el("p", { class: "muted small" }, `Entrée : ${JC.fmtUtc(t.entryTime)} UTC · ${JC.fmtLocal(t.entryTime)} au Bénin` +
      (t.exitTime ? ` — Sortie : ${JC.fmtUtc(t.exitTime)} UTC · ${JC.fmtLocal(t.exitTime)} au Bénin` : "")));
    m.errors.forEach((x) => box.append(el("p", { class: "err small" }, "À corriger : " + x)));
    m.warnings.forEach((x) => box.append(el("p", { class: "warnline small" }, "Attention : " + x)));
    if (t.screenshot && !/^https:\/\//i.test(t.screenshot)) box.append(el("p", { class: "err small" }, "Le lien de capture doit commencer par https://"));
  }
  $("jForm").addEventListener("input", preview);
  $("jForm").addEventListener("change", preview);

  function openNew(prefill) {
    editingId = null;
    $("jfTitle").textContent = "Nouveau trade";
    ["jfDelete", "jfDup"].forEach((id) => $(id).classList.add("hidden"));
    fillForm(Object.assign({ status: "CLOSED", accountId: $("fAccount").value || accounts[0].id, entryTime: Date.now(), errors: [], checklist: {} }, prefill || {}));
    showForm();
  }
  function openEdit(id) {
    const t = trades.find((x) => x.id === id); if (!t) return;
    editingId = id;
    $("jfTitle").textContent = "Fiche du trade";
    ["jfDelete", "jfDup"].forEach((x) => $(x).classList.remove("hidden"));
    fillForm(t); showForm();
  }
  function showForm() {
    D.showTab("journal"); setView("trades");
    $("jFormCard").classList.remove("hidden");
    $("jFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function closeForm() { $("jFormCard").classList.add("hidden"); editingId = null; }
  $("jNew").addEventListener("click", () => openNew());
  $("jfCancel").addEventListener("click", closeForm);
  $("jfDup").addEventListener("click", () => {
    const t = collect();
    openNew(Object.assign(t, { id: undefined, status: "OPEN", exit: null, exitTime: null, grossOverride: null, ticket: null, source: "manual", entryTime: Date.now() }));
  });
  $("jfDelete").addEventListener("click", async () => {
    if (!editingId || !confirm("Supprimer définitivement ce trade du journal ?")) return;
    await DB.del("trades", editingId);
    trades = trades.filter((x) => x.id !== editingId);
    closeForm(); refresh(); toast("Trade supprimé.");
  });
  $("jForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = collect(), m = metricsFor(t);
    if (t.screenshot && !/^https:\/\/[^\s"'<>]+$/i.test(t.screenshot)) { toast("Lien de capture invalide : il doit commencer par https://"); return; }
    if (m.errors.length) { toast("À corriger avant d'enregistrer : " + m.errors[0], 6000); return; }
    if (m.warnings.length && !confirm("Attention : " + m.warnings.join(" ; ") + ".\n\nEnregistrer quand même ? (Un risque au-delà de ta limite compte comme hors plan.)")) return;
    const clean = JC.sanitizeTrade(t);
    try { await DB.put("trades", clean); } catch (err) { toast("Enregistrement impossible : " + err.message, 7000); return; }
    const i = trades.findIndex((x) => x.id === clean.id);
    if (i >= 0) trades[i] = clean; else trades.push(clean);
    closeForm(); refresh(); toast("Trade enregistré.");
  });

  // ---------------------------------------------------------------- statistiques
  function groupTable(rows, keyLabel) {
    if (!rows.length) return el("p", { class: "muted" }, "Pas encore de trade clôturé.");
    const t = el("table", {}, el("thead", {}, el("tr", {}, ...[keyLabel || "", "Trades", "Réussite", "Net", "R moyen"].map((h) => el("th", {}, h)))));
    const tb = el("tbody"); t.append(tb);
    rows.forEach((g) => tb.append(el("tr", {}, el("td", {}, g.key), el("td", { class: "mono" }, g.n), el("td", { class: "mono" }, pct(g.winRate)),
      el("td", { class: "mono " + cls(g.net) }, money(g.net)), el("td", { class: "mono " + cls(g.avgR) }, fix(g.avgR, 2)))));
    return el("div", { class: "scroll" }, t);
  }
  function kpis(box, s, extra) {
    clear(box);
    const tile = (label, value, c, sub) => el("div", { class: "kpi" }, el("span", {}, label), el("b", { class: "mono " + (c || "") }, value), sub ? el("small", {}, sub) : null);
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor == null ? "–" : s.profitFactor.toFixed(2);
    const pl = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
    [tile("Trades clôturés", String(s.n), "", `${pl(s.wins, "gagnant")} · ${pl(s.losses, "perdant")}`),
      tile("Taux de réussite", pct(s.winRate)),
      tile("Résultat net", money(s.net), cls(s.net)),
      tile("Gain moyen / perte moyenne", `${money(s.avgWin)} / ${money(s.avgLoss)}`),
      tile("R moyen gains / pertes", `${fix(s.avgWinR, 2)} / ${fix(s.avgLossR, 2)}`),
      tile("Espérance par trade", `${money(s.expectancyUsd)}`, cls(s.expectancyUsd), s.expectancyR != null ? `${fix(s.expectancyR, 2)} R (sur ${s.rCount} trades avec risque connu)` : "R inconnu"),
      tile("Profit factor", pf, s.profitFactor > 1 ? "up" : s.profitFactor != null && s.profitFactor < 1 ? "down" : ""),
      tile("Drawdown max", money(s.maxDD), s.maxDD < 0 ? "down" : "", `${s.maxDDPct.toFixed(1)} %`),
      tile("Plus longues séries", `${pl(s.longestWin, "gain")} · ${pl(s.longestLoss, "perte")}`),
      tile("Respect du plan", pct(s.plan.rate), "", `${s.plan.known} trade(s) avec checklist`),
      ...(extra || [])].forEach((x) => box.append(x));
  }
  function lineChart(cv, values, opts) {
    const css = getComputedStyle(document.documentElement), col = (v) => css.getPropertyValue(v).trim();
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = col("--muted");
    if (values.length < 2) { ctx.fillText("Pas assez de trades clôturés.", 8, h / 2); return; }
    let lo = Math.min(...values), hi = Math.max(...values);
    if (opts.zeroTop) hi = Math.max(hi, 0);
    if (hi === lo) { hi += 1; lo -= 1; }
    const padL = 54, padR = 8, padT = 8, padB = 18, pw = w - padL - padR, ph = h - padT - padB;
    const x = (i) => padL + i / (values.length - 1) * pw, y = (v) => padT + (hi - v) / (hi - lo) * ph;
    ctx.strokeStyle = col("--line"); ctx.lineWidth = 1; ctx.textBaseline = "middle";
    for (let i = 0; i <= 3; i++) {
      const v = lo + (hi - lo) * i / 3, yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(opts.fmt(v), 2, yy);
    }
    if (opts.base != null && opts.base > lo && opts.base < hi) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = col("--muted");
      ctx.beginPath(); ctx.moveTo(padL, y(opts.base)); ctx.lineTo(w - padR, y(opts.base)); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath(); values.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = opts.color; ctx.lineWidth = 2; ctx.stroke();
    if (opts.fill) { ctx.lineTo(x(values.length - 1), y(opts.fillTo)); ctx.lineTo(x(0), y(opts.fillTo)); ctx.closePath(); ctx.globalAlpha = 0.15; ctx.fillStyle = opts.color; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.fillStyle = col("--muted"); ctx.textBaseline = "alphabetic";
    ctx.fillText("départ", padL, h - 4); ctx.fillText(`trade ${values.length - 1}`, w - padR - 50, h - 4);
  }
  function renderCalendar(list) {
    const cal = JC.calendar(list, calY, calM);
    $("calTitle").textContent = new Date(Date.UTC(calY, calM - 1, 1)).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
    const box = clear($("sCal"));
    ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"].forEach((d) => box.append(el("div", { class: "cal-h" }, d)));
    const first = new Date(Date.UTC(calY, calM - 1, 1)).getUTCDay(), offset = (first + 6) % 7;
    const days = new Date(Date.UTC(calY, calM, 0)).getUTCDate();
    for (let i = 0; i < offset; i++) box.append(el("div", { class: "cal-d empty" }));
    let total = 0, n = 0;
    for (let d = 1; d <= days; d++) {
      const k = `${calY}-${String(calM).padStart(2, "0")}-${String(d).padStart(2, "0")}`, c = cal[k];
      if (c) { total += c.net; n += c.n; }
      box.append(el("div", { class: "cal-d " + (c ? (c.net > 0 ? "win" : c.net < 0 ? "loss" : "flat") : "") },
        el("span", { class: "cal-n" }, d), c ? el("b", { class: "mono" }, money(c.net)) : null, c ? el("small", {}, `${c.n} trade${c.n > 1 ? "s" : ""}`) : null));
    }
    box.append(el("div", { class: "cal-total" }, `Total du mois : `, el("b", { class: "mono " + cls(total) }, money(total)), ` sur ${n} trade(s)`));
  }
  function renderStats() {
    const f = filter(false), list = JC.filterTrades(enriched, f), s = JC.stats(list, startBalanceFor(f.accountId));
    kpis($("sKpis"), s);
    const css = getComputedStyle(document.documentElement);
    lineChart($("sEquity"), s.curve.map((p) => p.equity), { color: css.getPropertyValue("--accent").trim(), fmt: (v) => v.toFixed(0) + " $", base: s.curve[0].equity });
    lineChart($("sDD"), s.curve.map((p) => p.ddPct), { color: css.getPropertyValue("--reject").trim(), fmt: (v) => v.toFixed(1) + " %", zeroTop: true, fill: true, fillTo: 0 });
    renderCalendar(list);
    const put = (id, node) => { clear($(id)).append(node); };
    put("sBySetup", groupTable(s.bySetup, "Setup")); put("sBySession", groupTable(s.bySession, "Session"));
    put("sByWeekday", groupTable(s.byWeekday, "Jour")); put("sByHour", groupTable(s.byHour, "Heure"));
    put("sBySymbol", groupTable(s.bySymbol, "Symbole"));
    if (!s.errorCost.length) put("sErrors", el("p", { class: "muted" }, "Aucune erreur notée sur les trades clôturés."));
    else {
      const t = el("table", {}, el("thead", {}, el("tr", {}, ...["Erreur", "Trades", "Résultat total", "Pertes", "R moyen"].map((h) => el("th", {}, h)))));
      const tb = el("tbody"); t.append(tb);
      s.errorCost.forEach((e) => tb.append(el("tr", {}, el("td", {}, e.key), el("td", { class: "mono" }, e.n), el("td", { class: "mono " + cls(e.net) }, money(e.net)),
        el("td", { class: "mono down" }, money(e.losses)), el("td", { class: "mono " + cls(e.avgR) }, fix(e.avgR, 2)))));
      put("sErrors", el("div", { class: "scroll" }, t));
    }
    const p = s.plan;
    const t = el("table", {}, el("thead", {}, el("tr", {}, ...["", "Trades", "Réussite", "Net", "R moyen"].map((h) => el("th", {}, h)))));
    const tb = el("tbody"); t.append(tb);
    [["Dans le plan", p.inPlan], ["Hors plan", p.outPlan]].forEach(([k, g]) => tb.append(el("tr", {}, el("td", {}, k), el("td", { class: "mono" }, g.n),
      el("td", { class: "mono" }, pct(g.winRate)), el("td", { class: "mono " + cls(g.net) }, money(g.net)), el("td", { class: "mono " + cls(g.avgR) }, fix(g.avgR, 2)))));
    clear($("sPlan")).append(el("p", {}, `Plan respecté sur ${pct(p.rate)} des trades dont la checklist est remplie (${p.known}). Hors plan = case non cochée, erreur « Hors plan » ou risque au-delà de ta limite.`),
      el("div", { class: "scroll" }, t));
  }
  $("calPrev").addEventListener("click", () => { calM--; if (calM < 1) { calM = 12; calY--; } renderStats(); });
  $("calNext").addEventListener("click", () => { calM++; if (calM > 12) { calM = 1; calY++; } renderStats(); });
  window.addEventListener("resize", () => { if (view === "stats" && !$("tab-journal").classList.contains("hidden")) { clearTimeout(renderStats.t); renderStats.t = setTimeout(renderStats, 200); } });
  new MutationObserver(() => { if (!$("tab-journal").classList.contains("hidden") && view === "stats") renderStats(); })
    .observe($("tab-journal"), { attributes: true, attributeFilter: ["class"] });

  // ---------------------------------------------------------------- rapport imprimable
  $("sPrint").addEventListener("click", () => {
    const f = filter(false), list = JC.filterTrades(enriched, f), s = JC.stats(list, startBalanceFor(f.accountId));
    const box = clear($("printReport"));
    const closed = list.filter((x) => x.t.status === "CLOSED").sort((a, b) => (a.t.exitTime || 0) - (b.t.exitTime || 0));
    box.append(el("h1", {}, "Desk Forex — rapport du journal"),
      el("p", {}, `Édité le ${JC.fmtLocal(Date.now())} (heure du Bénin). Période : ${$("fPeriod").selectedOptions[0].textContent}. ` +
        `Filtres : ${[f.symbol, f.setup, f.session, f.accountId && (accounts.find((a) => a.id === f.accountId) || {}).name].filter(Boolean).join(", ") || "aucun"}.`),
      el("p", {}, `Trades clôturés : ${s.n} · réussite ${pct(s.winRate)} · net ${money(s.net)} · espérance ${money(s.expectancyUsd)} (${fix(s.expectancyR, 2)} R) · ` +
        `profit factor ${s.profitFactor === Infinity ? "∞" : s.profitFactor == null ? "–" : s.profitFactor.toFixed(2)} · drawdown max ${money(s.maxDD)} (${s.maxDDPct.toFixed(1)} %) · ` +
        `respect du plan ${pct(s.plan.rate)}.`),
      el("h2", {}, "Par setup"), groupTable(s.bySetup, "Setup"), el("h2", {}, "Par session"), groupTable(s.bySession, "Session"),
      el("h2", {}, "Coût des erreurs"), s.errorCost.length ? groupTable(s.errorCost.map((e) => ({ key: e.key, n: e.n, winRate: null, net: e.net, avgR: e.avgR })), "Erreur") : el("p", {}, "Aucune."),
      el("h2", {}, "Trades clôturés"));
    const t = el("table", {}, el("thead", {}, el("tr", {}, ...["Entrée (Bénin)", "Sortie (Bénin)", "Symbole", "Sens", "Lots", "Pips", "Net", "R", "Setup", "Erreurs"].map((h) => el("th", {}, h)))));
    const tb = el("tbody"); t.append(tb);
    closed.forEach(({ t: x, m }) => tb.append(el("tr", {}, el("td", {}, JC.fmtLocal(x.entryTime)), el("td", {}, JC.fmtLocal(x.exitTime)), el("td", {}, x.symbol),
      el("td", {}, x.side === "sell" ? "vente" : "achat"), el("td", {}, x.lots), el("td", {}, fix(m.pips)), el("td", {}, money(m.net)), el("td", {}, fix(m.r, 2)),
      el("td", {}, x.setup || ""), el("td", {}, (x.errors || []).join(", ")))));
    box.append(t, el("p", { class: "small" }, "Outil éducatif : aucun ordre passé par le site, aucun conseil. Un petit échantillon ne prouve aucun avantage."));
    window.print();
  });

  // ---------------------------------------------------------------- revue de la semaine
  async function renderReview() {
    const acc = $("fAccount").value;
    const list = acc ? enriched.filter((x) => x.t.accountId === acc) : enriched;
    const w = JC.weeklyReview(list, reviewWeek, startBalanceFor(acc));
    $("rvTitle").textContent = `du ${JC.fmtLocal(w.from).slice(0, 10)} au ${JC.fmtLocal(w.to - 60000).slice(0, 10)}`;
    kpis($("rvKpis"), w.stats);
    const tradeList = (items, empty) => {
      if (!items.length) return el("p", { class: "muted" }, empty);
      const ul = el("ul", { class: "notes" });
      items.forEach(({ t, m }) => {
        const li = el("li", { class: "tap" }, `${JC.fmtLocal(t.entryTime)} · ${t.symbol} ${t.side === "sell" ? "vente" : "achat"} · `,
          el("b", { class: "mono " + cls(m.net) }, money(m.net)), m.r != null ? ` · ${fix(m.r, 2)} R` : "", t.setup ? ` · ${t.setup}` : "");
        li.addEventListener("click", () => openEdit(t.id));
        ul.append(li);
      });
      return ul;
    };
    clear($("rvBest")).append(tradeList(w.best, "Aucun trade gagnant cette semaine."));
    clear($("rvWorst")).append(tradeList(w.worst, "Aucun trade perdant cette semaine."));
    clear($("rvErrors")).append(w.frequentErrors.length
      ? el("ul", { class: "notes" }, ...w.frequentErrors.map((e) => el("li", {}, `${e.key} : ${e.n} fois`)))
      : el("p", { class: "muted" }, "Aucune erreur notée cette semaine."));
    clear($("rvActivity")).append(el("p", {}, `${w.entered} ligne(s) saisie(s) cette semaine : ` +
      (Object.entries(w.statusCount).map(([k, v]) => `${k} ${v}`).join(" · ") || "aucune") + "."));
    const saved = await DB.get("reviews", w.key);
    $("rvLessons").value = saved ? saved.lessons : ""; $("rvGoal").value = saved ? saved.goal : "";
    $("rvSaved").textContent = saved ? `Enregistrée le ${JC.fmtLocal(saved.updatedAt)}` : "";
    $("rvSave").dataset.key = w.key;
  }
  $("rvPrev").addEventListener("click", () => { reviewWeek -= 7 * 86400000; renderReview(); });
  $("rvNext").addEventListener("click", () => { reviewWeek += 7 * 86400000; renderReview(); });
  $("rvSave").addEventListener("click", async () => {
    const rec = { key: $("rvSave").dataset.key, lessons: $("rvLessons").value.slice(0, 4000), goal: $("rvGoal").value.slice(0, 1000), updatedAt: Date.now() };
    await DB.put("reviews", rec);
    $("rvSaved").textContent = `Enregistrée le ${JC.fmtLocal(rec.updatedAt)}`; toast("Revue enregistrée.");
  });

  // ---------------------------------------------------------------- reglages du journal
  function renderPrefsForm() {
    $("prMaxRisk").value = prefs.maxRiskPct;
    $("plSetups").value = prefs.setups.join("\n"); $("plErrors").value = prefs.errors.join("\n");
    $("plEmotions").value = prefs.emotions.join("\n"); $("plChecklist").value = prefs.checklist.join("\n");
  }
  const savePrefs = () => DB.put("meta", { key: "prefs", value: prefs });
  $("acForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = Number($("prMaxRisk").value);
    prefs.maxRiskPct = r > 0 && r <= 20 ? r : 2;
    await savePrefs(); refresh(); toast("Règle enregistrée.");
  });
  $("plSave").addEventListener("click", async () => {
    const lines = (id) => [...new Set($(id).value.split("\n").map((s) => s.trim().slice(0, 80)).filter(Boolean))].slice(0, 40);
    prefs.setups = lines("plSetups"); prefs.errors = lines("plErrors"); prefs.emotions = lines("plEmotions"); prefs.checklist = lines("plChecklist");
    await savePrefs(); renderPrefsForm(); refresh(); toast("Listes enregistrées.");
  });

  // ---------------------------------------------------------------- sauvegardes et exports
  const today = () => JC.localDay(Date.now());
  $("exCsv").addEventListener("click", () => {
    if (!enriched.length) { toast("Journal vide."); return; }
    D.download(`journal-${today()}.csv`, JC.toCsv([...enriched].sort((a, b) => (a.t.entryTime || 0) - (b.t.entryTime || 0))));
  });
  $("exJson").addEventListener("click", async () => {
    const local = {};
    ["news", "alerts", "settings"].forEach((k) => { const v = D.store.get(k, null); if (v != null) local[k] = v; });   // jamais la cle API
    const backup = { app: "desk-forex", kind: "backup", version: 1, exportedAt: new Date().toISOString(),
      trades, accounts, reviews: await DB.getAll("reviews"), prefs, local };
    const blob = new Blob([JSON.stringify(backup, null, 1)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `desk-forex-sauvegarde-${today()}.json` });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    $("exMsg").textContent = `Sauvegarde créée : ${trades.length} trade(s).`;
  });
  $("imJson").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast("Fichier trop gros (20 Mo maximum)."); return; }
    let data;
    try { data = JSON.parse(await file.text()); } catch (err) { toast("Fichier illisible : ce n'est pas du JSON."); return; }
    if (!data || data.app !== "desk-forex" || data.kind !== "backup") { toast("Ce fichier n'est pas une sauvegarde Desk Forex."); return; }
    const tr = (Array.isArray(data.trades) ? data.trades : []).map(JC.sanitizeTrade).filter(Boolean);
    const ac = (Array.isArray(data.accounts) ? data.accounts : []).filter((a) => a && a.id).map((a) => ({
      id: String(a.id).slice(0, 80), name: String(a.name || "Compte").slice(0, 40), type: String(a.type || "demo").slice(0, 20),
      currency: String(a.currency || "USD").slice(0, 3), startBalance: Math.max(0, Number(a.startBalance) || 0),
      startDate: Number(a.startDate) || null,
      rules: a.rules && typeof a.rules === "object" && window.ChallengeCore ? window.ChallengeCore.normalizeRules(a.rules) : undefined,
      equitySnapshots: Array.isArray(a.equitySnapshots) ? a.equitySnapshots.filter((s) => s && Number.isFinite(+s.t) && Number.isFinite(+s.equity))
        .slice(-200).map((s) => ({ t: +s.t, equity: +s.equity, balance: Number.isFinite(+s.balance) ? +s.balance : null, source: String(s.source || "manuel").slice(0, 20) })) : [] }));
    const rv = (Array.isArray(data.reviews) ? data.reviews : []).filter((r) => r && r.key).map((r) => ({
      key: String(r.key).slice(0, 20), lessons: String(r.lessons || "").slice(0, 4000), goal: String(r.goal || "").slice(0, 1000), updatedAt: Number(r.updatedAt) || Date.now() }));
    if (!confirm(`Importer ${tr.length} trade(s), ${ac.length} compte(s) et ${rv.length} revue(s) ? Les trades avec le même identifiant seront remplacés ; rien ne sera supprimé.`)) return;
    try {
      await DB.putMany("trades", tr); await DB.putMany("accounts", ac); await DB.putMany("reviews", rv);
      if (data.prefs && typeof data.prefs === "object") {
        const lists = (v) => (Array.isArray(v) ? v.map((s) => String(s).slice(0, 80)).filter(Boolean).slice(0, 40) : null);
        ["setups", "errors", "emotions", "checklist"].forEach((k) => { const l = lists(data.prefs[k]); if (l) prefs[k] = l; });
        if (Number(data.prefs.maxRiskPct) > 0) prefs.maxRiskPct = Math.min(20, Number(data.prefs.maxRiskPct));
        await savePrefs();
      }
      if (data.local && typeof data.local === "object") ["news", "alerts", "settings"].forEach((k) => { if (k in data.local) D.store.set(k, data.local[k]); });
    } catch (err) { toast("Import interrompu : " + err.message, 7000); return; }
    trades = await DB.getAll("trades"); accounts = await DB.getAll("accounts");
    renderPrefsForm(); refresh();
    $("exMsg").textContent = `Import terminé : ${tr.length} trade(s). Recharge la page pour appliquer les annonces, alertes et réglages importés.`;
  });
  $("jWipe").addEventListener("click", async () => {
    if (!confirm("Effacer TOUT le journal (trades et revues) de ce navigateur ? C'est irréversible.")) return;
    if (!confirm("Dernière confirmation : as-tu exporté une sauvegarde JSON ?")) return;
    await DB.clear("trades"); await DB.clear("reviews");
    trades = []; refresh(); toast("Journal effacé.");
  });

  // ---------------------------------------------------------------- donnees partagees avec l'onglet Comptes
  async function saveAccount(a) {
    await DB.put("accounts", a);
    const i = accounts.findIndex((x) => x.id === a.id);
    if (i >= 0) accounts[i] = a; else accounts.push(a);
    refresh();
  }
  async function deleteAccount(id) {
    if (trades.some((t) => t.accountId === id)) return "Ce compte a des trades dans le journal : supprime-les ou déplace-les d'abord.";
    if (accounts.length <= 1) return "Il faut garder au moins un compte.";
    await DB.del("accounts", id);
    accounts = accounts.filter((a) => a.id !== id);
    refresh();
    return null;
  }
  function showAccount(id) {
    $("fAccount").value = id; D.showTab("journal"); setView("trades"); refresh();
  }
  /** Enregistre plusieurs trades (import MT5) puis rafraichit le journal. */
  async function upsertTrades(list) {
    const clean = list.map(JC.sanitizeTrade).filter(Boolean);
    await DB.putMany("trades", clean);
    trades = await DB.getAll("trades");
    refresh();
    return clean.length;
  }
  window.Journal = {
    openNew, reload: load, saveAccount, deleteAccount, showAccount, upsertTrades,
    getState: () => ({ accounts: accounts.slice(), trades: trades.slice(), enriched, prefs }),
    onChange: (fn) => listeners.push(fn),
  };
  load();
})();
