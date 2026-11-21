// Tests de l'affichage en francais (aucun reseau). Lancer : node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../fmt.js");
const S = F.NBSP;

test("nombres au format francais", () => {
  assert.equal(F.num(1234.56), `1${S}234,56`);
  assert.equal(F.num(1234567.891, 2), `1${S}234${S}567,89`);
  assert.equal(F.num(1.08765, 5), "1,08765");
  assert.equal(F.num(-81.4), "−81,40");
  assert.equal(F.num(-0.001), "0,00");                 // pas de « −0,00 »
  assert.equal(F.num(12, 0), "12");
  assert.equal(F.num(null), "–"); assert.equal(F.num(""), "–"); assert.equal(F.num(NaN), "–"); assert.equal(F.num("abc"), "–");
  assert.equal(F.num("1234.5", 1), `1${S}234,5`);       // texte numerique accepte
  assert.equal(F.signed(977.31), "+977,31");
  assert.equal(F.signed(-50), "−50,00");
  assert.equal(F.signed(0), "0,00");
  assert.equal(F.signed(0.001), "0,00");                // arrondi a zero : pas de signe
  assert.equal(F.money(10977.31), `10${S}977,31${S}$`);
  assert.equal(F.money(517.43, true), `+517,43${S}$`);
  assert.equal(F.money(null), "–");
  assert.equal(F.pct(4.326, 2, true), `+4,33${S}%`);
  assert.equal(F.pct(-2.67), `−2,67${S}%`);
  assert.equal(F.fromText("+12.3"), "+12,3");
  assert.equal(F.fromText("-32.9"), "−32,9");
  assert.equal(F.fromText("3521.37"), `3${S}521,37`);
  assert.equal(F.fromText("N/A"), "N/A"); assert.equal(F.fromText("MISSING"), "MISSING");
});

test("heure du Benin (UTC+1) avec l'heure UTC", () => {
  const t = Date.parse("2026-11-18T13:30:00Z");
  assert.equal(F.benin(t), "14:30");
  assert.equal(F.benin(t, { date: true }), "18/11 14:30");
  assert.equal(F.benin(t, { year: true }), "18/11/2026 14:30");
  assert.equal(F.utc(t), "13:30 UTC");
  assert.equal(F.both(t), "14:30 (Bénin) · 13:30 UTC");
  assert.equal(F.benin(Date.parse("2026-11-20T23:30:00Z"), { date: true }), "21/11 00:30");   // passage au lendemain
  assert.equal(F.benin(null), "–"); assert.equal(F.utc(null), "");
});

test("statuts traduits et lexique", () => {
  assert.equal(F.status("WATCH"), "À surveiller");
  assert.equal(F.status("REJECT"), "Refusé");
  assert.equal(F.status("DATA_MISSING"), "Données manquantes");
  assert.equal(F.status("OPEN"), "Ouvert");
  assert.equal(F.status("CLOSED"), "Clôturé");
  assert.equal(F.status("AUTRE"), "AUTRE");
  for (const k of ["atr", "rsi", "ema", "r", "drawdown", "spread", "pip", "lot"]) {
    const [term, text] = F.GLOSSARY[k];
    assert.ok(term && text.length > 30 && text.length < 220, k);
    assert.ok(!/[.!?].+[.!?]$/.test(text.slice(0, -1)) || text.split(/[.!?]\s/).length <= 2, `${k} : une seule phrase`);
  }
});
