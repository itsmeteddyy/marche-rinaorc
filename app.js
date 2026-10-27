// Marché Rinaorc: reads the team's shared store (Supabase) live and computes everything in the page.
// Reading needs nothing; writing (shopping list, notes) needs the team code, checked by the store.
(() => {
  const API = "https://ywhabfjcqghbtkjgbppb.supabase.co/rest/v1";
  const KEY = "sb_publishable_yjwT8YidpXAsj4fmw9HSUw_oQi2-TcJ"; // public key: reads only, writes are code-checked
  const DEAL = 0.75, FEW = 3, PAGE = 1000, AUTO_MS = 60000;
  const STATUS = [["todo", "À acheter"], ["mine", "Je m'en occupe"], ["done", "Acheté"]];
  const TABS = ["plans", "hdv", "boutique", "argent", "liste", "equipe"];
  const S = {
    products: [], byKey: new Map(), listings: new Map(), achats: [], notes: [], lastScan: null, nListings: 0,
    tab: "plans", q: "", type: "all", dealsOnly: false, sort: "discount", hdvLimit: 150, listFilter: "open",
    open: null, loading: false, loadedAt: null, error: null, balances: null, balanceDay: new Map(), balanceError: null,
    code: store("marche.code") || "", pseudo: store("marche.pseudo") || "",
  };

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    catch { return null; }
  }
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
  function rc(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return nf2.format(n / 1e9) + " Md";
    if (a >= 1e6) return nf2.format(n / 1e6) + " M";
    if (a >= 1e5) return nf2.format(n / 1e3) + " k";
    return a < 100 ? nf2.format(n) : nf0.format(n);
  }
  const full = (n) => (n == null ? "" : nf2.format(n) + " RinaCoins");
  function pct(x) { const p = Math.round(x * 100); return (p > 0 ? "+" : p < 0 ? "−" : "") + Math.abs(p) + " %"; }
  const pad = (n) => String(n).padStart(2, "0");
  function when(iso) {
    const d = new Date(iso); if (!iso || isNaN(d)) return "";
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} à ${pad(d.getHours())} h ${pad(d.getMinutes())}`;
  }
  function since(iso) {
    const d = new Date(iso); if (!iso || isNaN(d)) return "";
    const min = Math.round((Date.now() - d) / 60000);
    if (min < 1) return "à l'instant"; if (min < 60) return `il y a ${min} min`;
    const h = Math.round(min / 60); if (h < 24) return `il y a ${h} h`;
    return `le ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  }
  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  function matches(p) {
    if (S.type !== "all" && p.type !== S.type) return false;
    if (!S.q) return true;
    const q = norm(S.q);
    if (norm(p.name).includes(q) || norm(p.variant).includes(q)) return true;
    return (S.listings.get(p.k) || []).some((l) => norm(l.seller).includes(q));
  }
  function nameCell(p) {
    return el("td", null,
      el("span", { class: "ttl", text: p.name }), " ",
      p.type === "Custom" ? el("span", { class: "chip custom", text: "Custom" }) : null,
      p.variant ? el("span", { class: "sub", text: p.variant, title: p.variant }) : null);
  }
  function td(text, cls, title) { return el("td", { class: cls, text, title }); }
  const rowAttrs = (k) => ({ class: "click", tabindex: 0, onclick: () => openSheet(k), onkeydown: (e) => { if (e.key === "Enter") openSheet(k); } });

  // ---------- store access ----------
  async function read(path) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const r = await fetch(`${API}/${path}`, { headers: { apikey: KEY, Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" } });
      if (!r.ok) throw new Error(`lecture ${path.split("?")[0]} : ${r.status}`);
      const rows = await r.json();
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }
  async function rpc(fn, body) {
    const r = await fetch(`${API}/rpc/${fn}`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) { let m = text; try { m = JSON.parse(text).message; } catch {} throw new Error(m || `erreur ${r.status}`); }
    return text ? JSON.parse(text) : null;
  }

  async function loadAll() {
    if (S.loading) return;
    S.loading = true; setRefreshing(true);
    try {
      const [listings, shop, achats, notes, scans] = await Promise.all([
        read("listings_active?select=key,product,item,item_id,type,variant,count,price,unit,lots,seller,ends_at,last_seen&order=unit.asc"),
        read("shop_prices?select=product,item,item_id,type,variant,buy,sell,no_buyback,seen"),
        read("achats?select=*&order=created_at.desc"),
        read("notes?select=*&order=created_at.asc"),
        read("scans?select=kind,scanned_by,listings,complete,gone,at&order=at.desc&limit=1"),
        loadBalances(),
      ]);
      build(listings, shop);
      S.achats = achats; S.notes = notes; S.lastScan = scans[0] || null;
      S.error = null; S.loadedAt = new Date();
    } catch (e) {
      S.error = "Les prix n'ont pas pu être chargés (" + e.message + "). Vérifie ta connexion puis clique Actualiser.";
    } finally {
      S.loading = false; setRefreshing(false);
      renderMeta(); renderAll(); if (S.open) renderSheet();
    }
  }

  // Team money: never fails the rest of the page (the tables may not exist yet).
  async function loadBalances() {
    try {
      const day = encodeURIComponent(new Date(Date.now() - 864e5).toISOString());
      const [rows, hist] = await Promise.all([
        read("balances?select=player,amount,shown,updated_at&order=amount.desc"),
        read(`balance_history?select=player,amount,at&at=gte.${day}&order=at.asc`),
      ]);
      S.balances = rows.map((r) => ({ player: r.player, amount: +r.amount, shown: r.shown, at: r.updated_at }));
      S.balanceDay = new Map();
      for (const h of hist) if (!S.balanceDay.has(h.player)) S.balanceDay.set(h.player, +h.amount);
      S.balanceError = null;
    } catch (e) {
      S.balances = null; S.balanceError = e.message;
    }
  }

  // Same rules as the mod's HdvAnalysis: identical lots count one by one; a deal is a best unit price at or below
  // 75 % of the median with at least 3 listings.
  function build(listings, shop) {
    const products = new Map();
    const product = (k, row) => {
      if (!products.has(k)) products.set(k, { k, name: row.item, type: row.type || "Normal", variant: row.variant || "", id: row.item_id, hdv: null, shop: null });
      return products.get(k);
    };
    const byProduct = new Map();
    S.listings = new Map();
    for (const l of listings) {
      product(l.product, l);
      if (!byProduct.has(l.product)) byProduct.set(l.product, []);
      for (let i = 0; i < Math.max(1, l.lots || 1); i++) byProduct.get(l.product).push(l);
      if (!S.listings.has(l.product)) S.listings.set(l.product, []);
      S.listings.get(l.product).push({ count: l.count, price: +l.price, unit: +l.unit, lots: l.lots || 1, seller: l.seller, endsAt: l.ends_at, lastSeen: l.last_seen });
    }
    for (const [k, rows] of byProduct) {
      const units = rows.map((r) => +r.unit).sort((a, b) => a - b);
      const n = units.length, mid = Math.floor(n / 2);
      const median = n % 2 ? units[mid] : (units[mid - 1] + units[mid]) / 2;
      const best = units[0];
      const cheapest = rows.reduce((a, b) => (+b.unit < +a.unit ? b : a));
      products.get(k).hdv = {
        n, sellers: new Set(rows.map((r) => r.seller)).size, best, median, high: units[n - 1], bestSeller: cheapest.seller,
        margin: n >= 2 ? units[1] - best : null, deal: n >= FEW && best <= median * DEAL, discount: median > 0 ? best / median - 1 : 0,
      };
    }
    for (const s of shop) product(s.product, s).shop = { buy: s.buy == null ? null : +s.buy, sell: s.sell == null ? null : +s.sell, noBuyback: s.no_buyback };
    S.products = [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
    S.byKey = products;
    S.nListings = listings.reduce((t, l) => t + Math.max(1, l.lots || 1), 0);
  }

  // ---------- header ----------
  function setRefreshing(on) { const b = $("refresh"); b.disabled = on; b.textContent = on ? "Actualisation…" : "Actualiser"; }
  function renderMeta() {
    const meta = $("meta");
    if (S.error) { meta.textContent = S.error; return; }
    const scan = S.lastScan ? `dernier scan ${since(S.lastScan.at)}${S.lastScan.scanned_by ? " par " + S.lastScan.scanned_by : ""}` : "aucun scan pour l'instant";
    meta.textContent = `Skyblock · ${scan} · ${nf0.format(S.nListings)} annonces en vente`;
    $("c-plans").textContent = S.products.filter((p) => p.hdv && p.hdv.deal).length;
    $("access").textContent = S.code ? `Équipe : ${S.pseudo || "toi"}` : "Accès équipe";
  }

  // ---------- views ----------
  function renderAll() { renderPlans(); renderHdv(); renderShop(); renderMoney(); renderList(); renderTeam(); }

  function renderPlans() {
    const box = $("plans"); box.replaceChildren();
    const deals = S.products.filter((p) => p.hdv && p.hdv.deal && matches(p)).sort((a, b) => a.hdv.discount - b.hdv.discount);
    if (!deals.length) { box.append(el("div", { class: "empty", text: S.q ? "Aucune bonne affaire pour cette recherche." : "Aucune bonne affaire dans les annonces en vente." })); return; }
    for (const p of deals) {
      const h = p.hdv;
      const fill = Math.max(4, Math.min(100, Math.round((h.best / h.median) * 100)));
      box.append(el("article", { class: "card" },
        el("div", null, el("div", { class: "name", text: p.name }), p.type === "Custom" ? el("span", { class: "chip custom", text: "Custom" }) : null),
        p.variant ? el("div", { class: "variant", text: p.variant, title: p.variant }) : null,
        el("div", { class: "price" }, el("b", { text: rc(h.best), title: full(h.best) }), el("span", { class: "unit", text: "/ unité" }), el("span", { class: "drop", text: pct(h.discount) })),
        el("div", { class: "bar", title: `Prix habituel : ${full(h.median)}` }, el("i", { style: `width:${fill}%` })),
        el("div", { class: "facts" }, el("span", { text: `Habituel ${rc(h.median)}` }), el("span", { text: `${h.n} annonces` }), el("span", { text: `chez ${h.bestSeller}` })),
        el("div", { class: "actions" },
          el("button", { class: "btn", onclick: () => openSheet(p.k), text: "Voir la fiche" }),
          el("button", { class: "btn primary", onclick: () => addToList(p), text: "À acheter" }))));
    }
  }

  function renderHdv() {
    const body = $("hdvRows"); body.replaceChildren(); $("hdvMore").replaceChildren();
    const sorts = {
      discount: (a, b) => a.hdv.discount - b.hdv.discount, n: (a, b) => b.hdv.n - a.hdv.n,
      "best-asc": (a, b) => a.hdv.best - b.hdv.best, "best-desc": (a, b) => b.hdv.best - a.hdv.best,
      name: (a, b) => a.name.localeCompare(b.name, "fr"),
    };
    const rows = S.products.filter((p) => p.hdv && matches(p) && (!S.dealsOnly || p.hdv.deal)).sort(sorts[S.sort]);
    if (!rows.length) { body.append(el("tr", null, el("td", { colspan: 6, class: "empty", text: "Rien ne correspond." }))); return; }
    for (const p of rows.slice(0, S.hdvLimit)) {
      const h = p.hdv;
      body.append(el("tr", rowAttrs(p.k), nameCell(p), td(String(h.n), "r num"), td(rc(h.best), "r num", full(h.best)),
        td(rc(h.median), "r num", full(h.median)), el("td", { class: "r num" + (h.deal ? " good" : ""), text: h.n >= FEW ? pct(h.discount) : "—" }), td(h.bestSeller)));
    }
    if (rows.length > S.hdvLimit) $("hdvMore").append(el("button", { class: "btn", text: `Afficher ${Math.min(150, rows.length - S.hdvLimit)} de plus (${rows.length} en tout)`, onclick: () => { S.hdvLimit += 150; renderHdv(); } }));
  }

  function renderShop() {
    const body = $("shopRows"); body.replaceChildren();
    const rows = S.products.filter((p) => p.shop && matches(p));
    if (!rows.length) { body.append(el("tr", null, el("td", { colspan: 4, class: "empty", text: S.products.length ? "Rien ne correspond." : "Aucun prix de boutique relevé pour l'instant." }))); return; }
    for (const p of rows) {
      const s = p.shop;
      body.append(el("tr", rowAttrs(p.k), nameCell(p), td(s.buy != null ? rc(s.buy) : "—", "r num", full(s.buy)),
        td(s.sell != null ? rc(s.sell) : s.noBuyback ? "non racheté" : "—", "r num", full(s.sell)), td(p.hdv ? rc(p.hdv.best) : "—", "r num", p.hdv ? full(p.hdv.best) : "")));
    }
  }

  function moneyRows(id, rows, cells, empty) {
    const body = $(id); body.replaceChildren();
    if (!rows.length) { body.append(el("tr", null, el("td", { colspan: 6, class: "empty", text: empty }))); return; }
    for (const p of rows) body.append(el("tr", rowAttrs(p.k), nameCell(p), ...cells(p)));
  }
  function renderMoney() {
    const ps = S.products.filter(matches);
    const none = "Aucun écart de ce genre dans les annonces en vente.";
    moneyRows("m1", ps.filter((p) => p.hdv && p.shop && p.shop.sell != null && p.hdv.best < p.shop.sell).sort((x, y) => (y.shop.sell - y.hdv.best) - (x.shop.sell - x.hdv.best)),
      (p) => [td(rc(p.hdv.best), "r num", full(p.hdv.best)), td(rc(p.shop.sell), "r num", full(p.shop.sell)), td("+" + rc(p.shop.sell - p.hdv.best), "r num good"), td(p.hdv.bestSeller)], none);
    moneyRows("m2", ps.filter((p) => p.hdv && p.shop && p.shop.buy != null && p.hdv.n >= FEW && p.shop.buy < p.hdv.median).sort((x, y) => (y.hdv.median - y.shop.buy) - (x.hdv.median - x.shop.buy)),
      (p) => [td(rc(p.shop.buy), "r num", full(p.shop.buy)), td(rc(p.hdv.median), "r num", full(p.hdv.median)), td("+" + rc(p.hdv.median - p.shop.buy), "r num good")], none);
    moneyRows("m3", ps.filter((p) => p.hdv && p.hdv.n >= FEW && p.hdv.margin && p.hdv.margin / p.hdv.best >= 0.25).sort((x, y) => y.hdv.margin - x.hdv.margin).slice(0, 60),
      (p) => [td(rc(p.hdv.best), "r num", full(p.hdv.best)), td(rc(p.hdv.best + p.hdv.margin), "r num", full(p.hdv.best + p.hdv.margin)), td("+" + rc(p.hdv.margin), "r num good"), td(String(p.hdv.n), "r num")], none);
  }

  // ---------- team money ----------
  const signed = (d) => (d > 0 ? "+" : d < 0 ? "−" : "") + rc(Math.abs(d));
  function renderTeam() {
    const body = $("teamRows"); body.replaceChildren();
    const rows = S.balances || [];
    const total = rows.reduce((t, r) => t + r.amount, 0);
    const dayDiff = rows.reduce((t, r) => t + r.amount - (S.balanceDay.get(r.player) ?? r.amount), 0);
    $("teamTotal").textContent = rows.length ? rc(total) : "—"; $("teamTotal").title = rows.length ? full(total) : "";
    $("teamDay").textContent = rows.length ? signed(dayDiff) : "—";
    $("teamDay").className = dayDiff > 0 ? "good" : dayDiff < 0 ? "down" : "";
    $("teamCount").textContent = rows.length;
    if (!rows.length) {
      const text = S.balances === null && S.balanceError
        ? "Les soldes ne sont pas encore activés : lance outils/supabase/soldes.sql dans Supabase."
        : "Aucun solde reçu : il arrive dès qu'un joueur avec le mod et le code d'équipe est sur le serveur.";
      body.append(el("tr", null, el("td", { colspan: 5, class: "empty", text })));
      return;
    }
    for (const r of rows) {
      const d = r.amount - (S.balanceDay.get(r.player) ?? r.amount);
      body.append(el("tr", null,
        el("td", null, el("span", { class: "who" },
          el("img", { src: `https://mc-heads.net/avatar/${encodeURIComponent(r.player)}/36`, alt: "", loading: "lazy", width: 18, height: 18 }),
          el("span", { class: "ttl", text: r.player }))),
        td(rc(r.amount), "r num", full(r.amount)),
        td(d ? signed(d) : "=", "r num " + (d > 0 ? "good" : d < 0 ? "down" : "")),
        td(total > 0 ? Math.round((r.amount / total) * 100) + " %" : "—", "r num"),
        td(since(r.at), null, when(r.at))));
    }
  }

  // ---------- team: shopping list and notes ----------
  function notice(text) { $("listNotice").replaceChildren(el("div", { class: "notice", text })); }
  async function write(fn, body, after) {
    if (!S.code) { openAccess("Pour écrire, entre d'abord le code d'équipe."); return false; }
    try { await rpc(fn, { code: S.code, ...body }); }
    catch (e) {
      if (/code/i.test(e.message)) { S.code = ""; store("marche.code", null); openAccess("Le code d'équipe a été refusé : entre-le à nouveau."); }
      else { notice("Échec : " + e.message); setTab("liste", true); }
      return false;
    }
    if (after) await after();
    return true;
  }
  async function reloadTeam() {
    try {
      [S.achats, S.notes] = await Promise.all([read("achats?select=*&order=created_at.desc"), read("notes?select=*&order=created_at.asc")]);
    } catch {}
    renderList(); if (S.open) renderSheet();
  }
  function addToList(p, target, qty) {
    return write("achat_add", { product: p.k, name: p.name, variant: p.variant || "", type: p.type,
      target: target ?? (p.hdv ? p.hdv.best : null), qty: qty || null, author: S.pseudo || "?" }, reloadTeam);
  }

  function renderList() {
    const box = $("list");
    $("c-liste").textContent = S.achats.filter((a) => a.status !== "done").length;
    if (!S.code) notice("Tout le monde peut lire la liste. Pour ajouter ou cocher, clique « Accès équipe » et entre le code d'équipe.");
    else $("listNotice").replaceChildren();
    const items = S.achats.filter((a) => S.listFilter === "all" || (S.listFilter === "done" ? a.status === "done" : a.status !== "done"))
      .sort((a, b) => (a.status === "done") - (b.status === "done") || (b.created_at || "").localeCompare(a.created_at || ""));
    box.replaceChildren();
    if (!items.length) {
      box.append(el("div", { class: "empty", text: S.listFilter === "done" ? "Rien d'acheté pour l'instant." : "La liste est vide. Ouvre la fiche d'un produit, ou clique « À acheter » sur un bon plan." }));
      return;
    }
    for (const a of items) {
      const p = S.byKey.get(a.product);
      box.append(el("div", { class: "item" + (a.status === "done" ? " done" : "") },
        el("div", { class: "what" },
          el("button", { text: a.name, onclick: () => openSheet(a.product) }),
          a.variant ? el("span", { class: "line2", text: a.variant }) : null,
          el("div", { class: "line2" },
            a.target != null ? el("span", { class: "num", text: `cible ${rc(+a.target)} / u` }) : null,
            a.qty ? el("span", { class: "num", text: `× ${nf0.format(a.qty)}` }) : null,
            p && p.hdv ? el("span", { class: "num", text: `HDV dès ${rc(p.hdv.best)}` }) : null,
            a.status === "mine" && a.taken_by ? el("span", { text: `pris par ${a.taken_by}` }) : null,
            el("span", { text: `ajouté par ${a.added_by} ${since(a.created_at)}` }))),
        el("div", { class: "status" },
          ...STATUS.map(([v, label]) => el("button", { "aria-pressed": String(a.status === v), text: label,
            onclick: () => a.status !== v && write("achat_status", { achat: a.id, new_status: v, author: S.pseudo || "?" }, reloadTeam) })),
          el("button", { class: "del", text: "Retirer", title: "Retirer de la liste", onclick: () => write("achat_remove", { achat: a.id }, reloadTeam) }))));
    }
  }

  // ---------- team access ----------
  function openAccess(message) {
    S.open = "__access__";
    const code = el("input", { id: "teamCode", type: "password", autocomplete: "off", value: S.code });
    const pseudo = el("input", { id: "teamPseudo", type: "text", maxlength: "40", value: S.pseudo, placeholder: "ton pseudo Minecraft" });
    const status = el("div", { class: "notice", text: message || "Le code d'équipe permet d'ajouter à la liste et d'écrire des notes. Il reste sur cet appareil." });
    const form = el("form", { class: "add", onsubmit: async (e) => {
      e.preventDefault();
      const c = code.value.trim(), ps = pseudo.value.trim();
      if (!c || !ps) { status.textContent = "Entre le code et ton pseudo."; return; }
      status.textContent = "Vérification…";
      let ok = false;
      try { ok = await rpc("code_ok", { code: c }); } catch (err) { status.textContent = "Vérification impossible : " + err.message; return; }
      if (!ok) { status.textContent = "Code refusé. Demande-le à ton équipe."; return; }
      S.code = c; S.pseudo = ps; store("marche.code", c); store("marche.pseudo", ps);
      renderMeta(); renderAll(); closeSheet();
    } },
      el("label", { for: "teamPseudo" }, "Pseudo", pseudo),
      el("label", { for: "teamCode" }, "Code d'équipe", code),
      el("button", { class: "btn primary", type: "submit", text: "Valider" }));
    const out = S.code ? el("button", { class: "btn small", text: "Oublier le code sur cet appareil", onclick: () => {
      S.code = ""; store("marche.code", null); renderMeta(); renderAll(); closeSheet(); } }) : null;
    $("sheet").replaceChildren(el("header", null, el("button", { class: "btn small close", text: "Fermer", onclick: closeSheet }), el("h2", { text: "Accès équipe" })), status, form, out);
    $("sheet").hidden = false; $("scrim").hidden = false;
  }

  // ---------- product sheet ----------
  function openSheet(k) { S.open = k; renderSheet(); $("sheet").hidden = false; $("scrim").hidden = false; }
  function closeSheet() { S.open = null; $("sheet").hidden = true; $("scrim").hidden = true; }
  $("scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.open) closeSheet(); });

  function renderSheet() {
    if (S.open === "__access__") return;
    const p = S.byKey.get(S.open);
    if (!p) { closeSheet(); return; }
    const h = p.hdv, s = p.shop;
    const listings = S.listings.get(p.k) || [];
    const notes = S.notes.filter((n) => n.product === p.k);
    const hints = [];
    if (h && s && s.sell != null && h.best < s.sell) hints.push(`Acheté ${rc(h.best)} à l'HDV, revendu ${rc(s.sell)} à la boutique : +${rc(s.sell - h.best)} par unité.`);
    if (h && s && s.buy != null && h.n >= FEW && s.buy < h.median) hints.push(`La boutique le vend ${rc(s.buy)}, il s'échange autour de ${rc(h.median)} entre joueurs.`);
    if (h && h.deal) hints.push(`Le moins cher est ${pct(h.discount)} sous le prix habituel.`);
    const stats = el("div", { class: "stats" },
      ...[["Meilleur / u", h ? rc(h.best) : "—", h && full(h.best)], ["Habituel", h ? rc(h.median) : "—", h && full(h.median)], ["Plus haut", h ? rc(h.high) : "—", h && full(h.high)],
        ["Annonces", h ? String(h.n) : "0"], ["Vendeurs", h ? String(h.sellers) : "0"],
        ["Boutique", s ? `${s.buy != null ? rc(s.buy) : "—"} / ${s.sell != null ? rc(s.sell) : s.noBuyback ? "non" : "—"}` : "—", "Achat / rachat"]]
        .map(([k, v, t]) => el("div", { title: t || null }, el("span", { text: k }), el("b", { text: v }))));
    const listTable = listings.length ? el("div", { class: "tablebox" }, el("table", null,
      el("thead", null, el("tr", null, el("th", { text: "Qté" }), el("th", { class: "r", text: "Prix du lot" }), el("th", { class: "r", text: "/ u" }), el("th", { text: "Vendeur" }), el("th", { text: "Fin" }))),
      el("tbody", null, listings.map((l) => el("tr", null, td((l.lots > 1 ? `${l.lots} × ` : "") + l.count, "num"), td(rc(l.price), "r num", full(l.price)),
        td(rc(l.unit), "r num", full(l.unit)), td(l.seller), td(when(l.endsAt)))))))
      : el("div", { class: "empty", text: "Aucune annonce en vente en ce moment." });
    const target = el("input", { id: "addTarget", type: "number", min: "0", step: "any", value: h ? String(+h.best.toFixed(2)) : "" });
    const qty = el("input", { id: "addQty", type: "number", min: "1", step: "1", placeholder: "—" });
    const add = el("form", { class: "add", onsubmit: async (e) => {
      e.preventDefault();
      const button = e.target.querySelector("button");
      if (await addToList(p, target.value === "" ? null : Number(target.value), qty.value === "" ? null : Number(qty.value))) button.textContent = "Ajouté ✓";
    } },
      el("label", { for: "addTarget" }, "Prix cible / u", target), el("label", { for: "addQty" }, "Quantité", qty),
      el("button", { class: "btn primary", type: "submit", text: "Ajouter à la liste" }));
    const noteText = el("textarea", { id: "noteText", maxlength: "2000", placeholder: "Une info pour l'équipe : prix visé, vendeur fiable, à surveiller…" });
    const notesBox = el("div", { class: "notes" },
      notes.length ? notes.map((n) => el("div", { class: "note" }, el("p", { text: n.body }),
        el("div", { class: "by" }, el("span", { text: `${n.author} · ${since(n.created_at)}` }),
          S.code && n.author === S.pseudo ? el("button", { class: "btn small", text: "Supprimer", onclick: () => write("note_remove", { note: n.id }, reloadTeam) }) : null)))
        : el("div", { class: "empty", text: "Pas encore de note sur ce produit." }),
      el("form", { onsubmit: async (e) => { e.preventDefault(); const t = noteText.value.trim(); if (!t) return;
          if (await write("note_add", { product: p.k, body: t, author: S.pseudo || "?" }, reloadTeam)) noteText.value = ""; } },
        noteText, el("div", { class: "more" }, el("button", { class: "btn", type: "submit", text: "Publier la note" }))));
    $("sheet").replaceChildren(
      el("header", null,
        el("button", { class: "btn small close", text: "Fermer", onclick: closeSheet }),
        el("h2", { text: p.name }),
        el("div", null, el("span", { class: "chip" + (p.type === "Custom" ? " custom" : ""), text: p.type }), " ",
          h && h.deal ? el("span", { class: "chip deal", text: "Bonne affaire" }) : null, " ", el("span", { class: "chip", text: p.id })),
        p.variant ? el("div", { class: "variant", text: p.variant.split(" · ").join("\n") }) : null),
      stats,
      hints.length ? el("div", { class: "hint" }, hints.map((t) => el("div", { text: t }))) : null,
      el("section", null, el("h3", { text: "Mettre sur la liste d'achats" }), add),
      el("section", null, el("h3", { text: `Annonces en vente (${listings.length})` }), listTable),
      el("section", null, el("h3", { text: "Notes de l'équipe" }), notesBox));
  }

  // ---------- controls ----------
  function setTab(t, push) {
    if (!TABS.includes(t)) t = "plans";
    S.tab = t;
    for (const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    for (const v of document.querySelectorAll("[data-view]")) v.hidden = v.dataset.view !== t;
    if (push) { try { history.replaceState(null, "", "#" + t); } catch {} }
  }
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => setTab(b.dataset.tab, true));
  let qTimer;
  $("q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value.trim(); S.hdvLimit = 150; renderAll(); }, 120); });
  for (const seg of document.querySelectorAll('[data-filter="type"]')) seg.addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v; if (!v) return;
    S.type = v;
    for (const s of document.querySelectorAll('[data-filter="type"] button')) s.setAttribute("aria-pressed", String(s.dataset.v === v));
    renderAll();
  });
  $("dealsOnly").addEventListener("change", (e) => { S.dealsOnly = e.target.checked; renderHdv(); });
  $("hdvSort").addEventListener("change", (e) => { S.sort = e.target.value; renderHdv(); });
  $("listFilter").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v; if (!v) return;
    S.listFilter = v;
    for (const s of $("listFilter").querySelectorAll("button")) s.setAttribute("aria-pressed", String(s.dataset.v === v));
    renderList();
  });
  $("refresh").addEventListener("click", loadAll);
  $("access").addEventListener("click", () => openAccess());
  setInterval(() => { if (document.visibilityState === "visible") loadAll(); }, AUTO_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.loadedAt && Date.now() - S.loadedAt > AUTO_MS) loadAll(); });

  setTab(location.hash.replace("#", ""), false);
  renderAll();
  loadAll();
})();
