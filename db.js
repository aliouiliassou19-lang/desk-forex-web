/* Desk Forex : stockage local du journal (IndexedDB, repli localStorage). Rien n'est envoye sur internet. */
(function () {
  "use strict";
  const DB_NAME = "deskforex", VERSION = 1;
  const STORES = { trades: "id", accounts: "id", reviews: "key", meta: "key" };
  let dbp = null, fallback = false;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      let req;
      try { req = window.indexedDB && window.indexedDB.open(DB_NAME, VERSION); } catch (e) { req = null; }
      if (!req) { fallback = true; return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        Object.entries(STORES).forEach(([name, key]) => {
          if (db.objectStoreNames.contains(name)) return;
          const s = db.createObjectStore(name, { keyPath: key });
          if (name === "trades") { s.createIndex("accountId", "accountId"); s.createIndex("ticket", "ticket"); }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { fallback = true; resolve(null); };
    });
    // demande au navigateur de ne pas effacer ces donnees quand l'espace manque
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* facultatif */ }
    return dbp;
  }

  // ----- repli localStorage
  const lsKey = (n) => "dfx.db." + n;
  const lsGet = (n) => { try { return JSON.parse(localStorage.getItem(lsKey(n))) || []; } catch (e) { return []; } };
  const lsSet = (n, a) => {
    try { localStorage.setItem(lsKey(n), JSON.stringify(a)); }
    catch (e) { throw new Error("Stockage du navigateur plein ou indisponible : exporte une sauvegarde JSON."); }
  };

  function run(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      let result;
      const r = fn(s);
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("transaction annulée"));
    });
  }

  async function getAll(store) {
    const db = await open();
    return db ? run(db, store, "readonly", (s) => s.getAll()) : lsGet(store);
  }
  async function get(store, key) {
    const db = await open();
    return db ? run(db, store, "readonly", (s) => s.get(key)) : lsGet(store).find((x) => x[STORES[store]] === key);
  }
  async function putMany(store, list) {
    if (!list.length) return;
    const db = await open();
    if (db) return run(db, store, "readwrite", (s) => { list.forEach((o) => s.put(o)); return null; });
    const k = STORES[store], ids = new Set(list.map((x) => x[k]));
    lsSet(store, lsGet(store).filter((x) => !ids.has(x[k])).concat(list));
  }
  const put = (store, obj) => putMany(store, [obj]);
  async function del(store, key) {
    const db = await open();
    if (db) return run(db, store, "readwrite", (s) => s.delete(key));
    lsSet(store, lsGet(store).filter((x) => x[STORES[store]] !== key));
  }
  async function clear(store) {
    const db = await open();
    if (db) return run(db, store, "readwrite", (s) => s.clear());
    lsSet(store, []);
  }

  window.DeskDB = { open, getAll, get, put, putMany, del, clear, STORES, isFallback: () => fallback };
})();
