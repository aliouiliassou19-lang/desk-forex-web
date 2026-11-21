/* Desk Forex : ecran "Import MT5" (rapport HTML/Excel, fichier du script, connexion locale automatique).
 * LECTURE SEULE : le site lit des donnees, il n'envoie jamais rien a MT5. Calculs dans mt5-core.js (teste).
 */
(function () {
  "use strict";
  const nb = (v, d) => window.Fmt.num(v, d);
  const M = window.Mt5Core, J = window.Journal, D = window.DeskApp;
  if (!M || !J || !D) return;
  const { el, clear, toast } = D;
  const $ = (id) => document.getElementById(id);
  const conn = Object.assign({ port: 8790, token: "", auto: false, offset: 2 }, D.store.get("mt5conn", {}));
  let autoTimer = null;
  const opt = (v, l, sel) => { const o = el("option", { value: v }, l); if (sel) o.selected = true; return o; };
  const mask = (login) => (login ? "…" + String(login).slice(-3) : "?");
  const saveConn = () => D.store.set("mt5conn", conn);

  // ---------------------------------------------------------------- onglets internes et comptes
  $("mtNav").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    $("mtNav").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    ["report", "file", "auto"].forEach((k) => $("mt-" + k).classList.toggle("hidden", k !== b.dataset.v));
  }));
  function renderAccounts() {
    const s = $("mtAccount"), keep = s.value;
    clear(s);
    J.getState().accounts.forEach((a) => s.append(opt(a.id, a.name + (a.mt5Login ? ` (MT5 ${mask(a.mt5Login)})` : ""), a.id === keep)));
    s.append(opt("__new", "+ Nouveau compte créé depuis MT5", keep === "__new"));
  }
  J.onChange(renderAccounts);
  $("mtPort").value = conn.port; $("mtToken").value = conn.token; $("mtAuto").checked = !!conn.auto; $("mtOffset").value = conn.offset;

  // ---------------------------------------------------------------- import commun
  async function applyImport(norm, label) {
    const out = clear($("mtOut"));
    if (!norm.positions.length && !norm.open.length) {
      out.append(el("p", { class: "err" }, "Aucune position trouvée. Est-ce bien un rapport d'historique MT5 (Historique → clic droit → Rapport) ou le fichier du script ?"));
      return;
    }
    let st = J.getState(), accountId = $("mtAccount").value;
    const linked = M.accountForLogin(st.accounts, norm.login);
    if (linked && accountId === "__new" && confirm(`Ce compte MT5 (${mask(norm.login)}) est déjà lié à « ${linked.name} ».\nOK = importer dans « ${linked.name} » ; Annuler = créer quand même un nouveau compte.`)) {
      accountId = linked.id;
    } else if (linked && accountId !== linked.id && accountId !== "__new") {
      const chosen = st.accounts.find((a) => a.id === accountId);
      if (!confirm(`Ce compte MT5 (${mask(norm.login)}) est lié à « ${linked.name} ».\nOK = importer dans « ${linked.name} » ; Annuler = importer dans « ${chosen ? chosen.name : "?"} ».`)) {
        /* on garde le compte choisi */
      } else accountId = linked.id;
    }
    if (accountId === "__new") {
      const closedNet = norm.positions.reduce((s, p) => s + (p.profit || 0) - (p.commission || 0) + (p.swap || 0), 0);
      let start = norm.snapshot && norm.snapshot.balance != null ? Math.round((norm.snapshot.balance - closedNet) * 100) / 100 : null;
      const typed = prompt("Solde de départ de ce compte (avant ces trades) :", start != null ? String(start) : "");
      if (typed == null) return;
      start = Number(String(typed).replace(",", "."));
      if (!(start > 0)) { toast("Solde de départ invalide."); return; }
      const acc = { id: "acc" + Date.now().toString(36), name: `MT5 ${mask(norm.login)}${norm.mode ? " (" + norm.mode + ")" : ""}`,
        type: norm.mode === "real" ? "live" : "demo", currency: norm.currency || "USD", startBalance: start, startDate: null,
        rules: {}, equitySnapshots: [], mt5Login: norm.login || null };
      await J.saveAccount(acc);
      accountId = acc.id;
    }
    st = J.getState();
    const res = M.toTrades(norm, accountId, st.trades, Date.now());
    if (res.upserts.length) await J.upsertTrades(res.upserts);
    const acc = J.getState().accounts.find((a) => a.id === accountId);
    const patch = {};
    if ($("mtLink").checked && norm.login && String(acc.mt5Login || "") !== String(norm.login)) patch.mt5Login = String(norm.login);
    const known = (acc.equitySnapshots || []).some((s) => norm.snapshot && s.t === norm.snapshot.t);   // meme export deja importe
    if (norm.snapshot && !known && (!acc.mt5Login || !norm.login || String(acc.mt5Login) === String(norm.login) || patch.mt5Login)) {
      patch.equitySnapshots = (acc.equitySnapshots || []).concat([norm.snapshot]).slice(-200);
    }
    if (Object.keys(patch).length) await J.saveAccount(Object.assign({}, acc, patch));
    $("mtAccount").value = accountId;
    const skipped = {};
    res.skipped.forEach((s) => (skipped[s.symbol] = (skipped[s.symbol] || 0) + 1));
    out.append(el("div", { class: "result" },
      el("b", {}, `${label} : `), `${norm.positions.length} position(s) fermée(s) et ${norm.open.length} ouverte(s) lues pour le compte MT5 ${mask(norm.login)}.`, el("br"),
      `Journal (« ${acc.name} ») : ${res.created} ajoutée(s), ${res.updated} mise(s) à jour, ${res.unchanged} déjà à jour.`,
      norm.snapshot ? el("span", {}, el("br"), `Équité enregistrée : ${nb(norm.snapshot.equity, 2)} (solde ${norm.snapshot.balance != null ? nb(norm.snapshot.balance, 2) : "?"}).`) : null));
    if (Object.keys(skipped).length) out.append(el("p", { class: "muted small" },
      "Ignorés (symboles non suivis par le site) : " + Object.entries(skipped).map(([k, v]) => `${k} ×${v}`).join(", ") + "."));
    (norm.warnings || []).forEach((w) => out.append(el("p", { class: "warnline small" }, "Attention : " + w)));
    if (norm.serverOffsetHours != null) out.append(el("p", { class: "muted small" }, `Heures converties en UTC avec un décalage serveur de ${norm.serverOffsetHours} h.`));
    out.append(el("p", { class: "muted small" }, `Mis à jour le ${D.fmtLocal(Date.now())}. Complète maintenant tes fiches (setup, émotions, erreurs) dans le journal.`));
  }

  // ---------------------------------------------------------------- lecture du rapport HTML
  function htmlRows(text, mode) {
    const doc = new DOMParser().parseFromString(text, "text/html");      // aucun script n'est execute
    return [...doc.querySelectorAll("tr")].map((tr) => {
      const out = [];
      [...tr.children].forEach((td) => {
        if (!/^(TD|TH)$/.test(td.tagName)) return;
        if (mode === "visible" && (td.hidden || /display\s*:\s*none/i.test(td.getAttribute("style") || "") || /\bhidden\b/.test(td.className))) return;
        out.push(td.textContent.replace(/\s+/g, " ").trim());
        if (mode !== "flat") { const span = Math.min(20, Number(td.getAttribute("colspan")) || 1); for (let i = 1; i < span; i++) out.push(""); }
      });
      return out;
    });
  }
  async function readHtml(file) {
    const buf = await file.arrayBuffer(), b = new Uint8Array(buf);
    const utf16 = (b[0] === 0xff && b[1] === 0xfe) || (b.length > 4 && b[1] === 0 && b[3] === 0);
    const text = new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(buf);
    // plusieurs facons de lire les colonnes : on garde celle qui trouve le plus de positions
    let best = null;
    for (const mode of ["colspan", "visible", "flat"]) {
      const r = M.parseReportRows(htmlRows(text, mode), Number($("mtOffset").value) || 0);
      if (!best || r.positions.length > best.positions.length) best = r;
    }
    return best;
  }

  // ---------------------------------------------------------------- lecture d'un CSV (rapport reenregistre depuis Excel)
  async function readCsv(file) {
    const buf = await file.arrayBuffer(), b = new Uint8Array(buf);
    const utf16 = (b[0] === 0xff && b[1] === 0xfe) || (b.length > 4 && b[1] === 0 && b[3] === 0);
    let text = new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(buf);
    if (!utf16 && text.includes("�")) text = new TextDecoder("windows-1252").decode(buf);   // CSV Excel en ANSI
    return M.parseReportRows(M.parseCsv(text), Number($("mtOffset").value) || 0);
  }

  // ---------------------------------------------------------------- lecture du rapport Excel (.xlsx) sans bibliotheque
  async function unzip(buf, wanted) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("fichier Excel illisible");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
      p += 46 + nlen + elen + clen;
      if (!wanted(name)) continue;
      const data = new Uint8Array(buf, lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true), csize);
      let bytes;
      if (method === 0) bytes = data;
      else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      else throw new Error("compression Excel non prise en charge");
      files[name] = new TextDecoder().decode(bytes);
    }
    return files;
  }
  async function readXlsx(file) {
    if (typeof DecompressionStream === "undefined") throw new Error("Ce navigateur ne sait pas lire les fichiers Excel : exporte le rapport en HTML.");
    const f = await unzip(await file.arrayBuffer(), (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
    const shared = f["xl/sharedStrings.xml"] ? [...xml(f["xl/sharedStrings.xml"]).getElementsByTagName("si")]
      .map((si) => [...si.getElementsByTagName("t")].map((t) => t.textContent).join("")) : [];
    const sheet = Object.keys(f).filter((n) => n.startsWith("xl/worksheets/")).sort()[0];
    if (!sheet) throw new Error("aucune feuille dans le fichier Excel");
    const colIndex = (ref) => { let n = 0; for (const ch of String(ref).replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
    const rows = [...xml(f[sheet]).getElementsByTagName("row")].map((row) => {
      const out = [];
      [...row.getElementsByTagName("c")].forEach((c) => {
        const i = colIndex(c.getAttribute("r") || "A"), t = c.getAttribute("t");
        const v = c.getElementsByTagName("v")[0];
        let val = t === "s" ? shared[Number(v && v.textContent)] : t === "inlineStr" ? [...c.getElementsByTagName("t")].map((x) => x.textContent).join("") : v ? v.textContent : "";
        while (out.length < i) out.push("");
        out[i] = val == null ? "" : String(val);
      });
      return out;
    });
    return M.parseReportRows(rows, Number($("mtOffset").value) || 0);
  }

  $("mtReport").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) { toast("Fichier trop gros (30 Mo maximum)."); return; }
    conn.offset = Number($("mtOffset").value) || 0; saveConn();
    try {
      const norm = /\.xlsx$/i.test(file.name) ? await readXlsx(file) : /\.csv$/i.test(file.name) ? await readCsv(file) : await readHtml(file);
      norm.serverOffsetHours = conn.offset;
      await applyImport(norm, "Rapport MT5");
    } catch (err) { clear($("mtOut")).append(el("p", { class: "err" }, "Lecture impossible : " + err.message)); }
  });

  // ---------------------------------------------------------------- fichier du script
  $("mtJson").addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    try { await applyImport(M.normalizeExport(JSON.parse(await file.text())), "Fichier du script"); }
    catch (err) { clear($("mtOut")).append(el("p", { class: "err" }, err instanceof SyntaxError ? "Fichier illisible (JSON invalide)." : err.message)); }
  });

  // ---------------------------------------------------------------- connexion automatique (127.0.0.1)
  function readConn() {
    conn.port = Math.max(1024, Math.min(65535, Number($("mtPort").value) || 8790));
    conn.token = $("mtToken").value.trim();
    conn.auto = $("mtAuto").checked;
    saveConn();
  }
  async function local(path, withToken) {
    const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(`http://127.0.0.1:${conn.port}${path}`, { headers: withToken ? { "X-Desk-Token": conn.token } : {},
        cache: "no-store", credentials: "omit", signal: ctrl.signal });
      const body = await r.json().catch(() => ({}));
      if (r.status === 401) throw new Error("code secret faux : recopie celui affiché par le script.");
      if (r.status === 403) throw new Error("le script refuse ce site (vérifie allowedOrigins dans mt5_config.json).");
      if (r.status === 503) throw new Error("le script tourne mais ne lit pas MT5 : " + (body.error || "MT5 fermé ?"));
      if (!r.ok) throw new Error("réponse inattendue (" + r.status + ").");
      return body;
    } catch (err) {
      if (err.name === "AbortError") throw new Error("pas de réponse du script (délai dépassé).");
      if (err instanceof TypeError) throw new Error("connexion impossible. Le script « python mt5_export.py --serve » tourne-t-il sur ce PC, avec le même port ? "
        + "Ton navigateur a peut-être bloqué l'accès au réseau local : autorise-le pour ce site, ou utilise « Fichier du script ».");
      throw err;
    } finally { clearTimeout(to); }
  }
  $("mtTest").addEventListener("click", async () => {
    readConn();
    const out = clear($("mtOut"));
    try {
      const p = await local("/ping", false);
      out.append(el("p", { class: p.ok ? "up" : "err" }, p.ok ? "Le script répond. Clique sur « Synchroniser maintenant »." : "Réponse inconnue."));
    } catch (err) { out.append(el("p", { class: "err" }, "Test : " + err.message)); }
  });
  async function sync(silent) {
    readConn();
    if (!conn.token) { if (!silent) toast("Colle d'abord le code secret affiché par le script."); return; }
    try { await applyImport(M.normalizeExport(await local("/mt5.json", true)), "Synchronisation automatique"); }
    catch (err) { clear($("mtOut")).append(el("p", { class: "err" }, "Synchronisation : " + err.message)); }
  }
  $("mtSync").addEventListener("click", () => sync(false));
  function setAuto() {
    clearInterval(autoTimer); autoTimer = null;
    if (conn.auto) autoTimer = setInterval(() => sync(true), 5 * 60000);
  }
  $("mtAuto").addEventListener("change", () => { readConn(); setAuto(); if (conn.auto) sync(true); });
  ["mtPort", "mtToken"].forEach((id) => $(id).addEventListener("change", readConn));
  renderAccounts();
  setAuto();
})();
