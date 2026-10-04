// Progressive enhancement for the hub website. Every page works without
// this file; with it, times stay relative, codes copy, the link page notices
// the node arriving, servers are remembered, and live regions redraw.
(function () {
  "use strict";

  // --- relative times ---------------------------------------------------------
  function ago(at) {
    var s = Math.round((Date.now() - at) / 1000);
    if (s < 0) return "in " + span(-s);
    if (s < 45) return "just now";
    return span(s) + " ago";
  }
  function span(s) {
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + " min";
    if (s < 86400) return Math.floor(s / 3600) + " h";
    return Math.floor(s / 86400) + " d";
  }
  function tickTimes() {
    document.querySelectorAll("time[data-ago]").forEach(function (t) {
      var at = Date.parse(t.getAttribute("datetime"));
      if (!isNaN(at)) t.textContent = ago(at);
    });
  }
  tickTimes();
  setInterval(tickTimes, 30000);

  // --- copy buttons (again on a region redrawn in place) ----------------------
  function bindCopies(root) {
    root.querySelectorAll("[data-copy]").forEach(function (b) {
      if (b.hasAttribute("data-copy-bound")) return;
      b.setAttribute("data-copy-bound", "");
      b.addEventListener("click", function () {
        var text = b.getAttribute("data-copy");
        var done = function () { var old = b.textContent; b.textContent = "copied"; setTimeout(function () { b.textContent = old; }, 1500); };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
      });
    });
  }
  bindCopies(document);

  // --- the link page waits for the node ---------------------------------------
  var poll = document.querySelector("[data-poll-nodes]");
  if (poll) {
    var had = Number(poll.getAttribute("data-poll-nodes")) || 0;
    var timer = setInterval(function () {
      fetch("/me/nodes.json", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (j && j.count > had) {
          clearInterval(timer);
          poll.innerHTML = '<p class="good">Your node just connected. Reloading…</p>';
          setTimeout(function () { location.href = "/me"; }, 800);
        }
      }).catch(function () {});
    }, 4000);
  }

  // --- remembered selects (the server you usually meet on) ----------------------
  document.querySelectorAll("select[data-remember]").forEach(function (sel) {
    var key = "hub.remember." + sel.getAttribute("data-remember");
    var explicit = sel.querySelector("option[selected]");
    try {
      var saved = localStorage.getItem(key);
      if (saved && !explicit && sel.querySelector('option[value="' + saved + '"]')) sel.value = saved;
    } catch (e) {}
    sel.addEventListener("change", function () { try { localStorage.setItem(key, sel.value); } catch (e) {} });
  });

  // --- event streams --------------------------------------------------------------
  // A page's stream is closed when the page is hidden (navigated away from, or
  // parked in the back-forward cache) and reopened when it shows again.
  // Left open, Chrome keeps the old pages' streams alive and, at six
  // connections to the host, makes the next page wait for one to free.
  function openStream(url, handlers) {
    if (!window.EventSource) return null;
    var src = null;
    function open() {
      if (src) return;
      src = new EventSource(url);
      src.onmessage = handlers.message;
      if (handlers.open) src.onopen = handlers.open;
    }
    function close() {
      if (!src) return;
      src.close();
      src = null;
    }
    window.addEventListener("pagehide", close);
    window.addEventListener("pageshow", function (e) { if (e.persisted) open(); });
    open();
    return { close: close };
  }
  // The communism page's script (its own block below) keeps its board live with this too.
  window.hubOpenStream = openStream;

  // --- live regions: re-fetch the page and swap the region when the hub says so --
  var live = document.querySelector("[data-live]");
  if (live && window.EventSource) {
    // One refresh at a time; news that arrives during one earns one more afterwards, so the last change is never missed.
    var refreshing = false, again = false;
    var refreshLive = function () {
      if (refreshing) { again = true; return; }
      refreshing = true;
      fetch(location.href, { credentials: "same-origin" }).then(function (r) { return r.text(); }).then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var fresh = doc.querySelector("[data-live]");
        if (fresh) { live.innerHTML = fresh.innerHTML; tickTimes(); }
      }).catch(function () {}).then(function () {
        refreshing = false;
        if (again) { again = false; refreshLive(); }
      });
    };
    openStream(live.getAttribute("data-live"), { message: refreshLive });
  }

  // --- polled regions: a trade in game says in one word whether it changed -------
  // The page asks its state every few seconds while the meeting is under way and
  // redraws the region when it moved; the redrawn region without data-poll ends it.
  var polled = document.querySelector("[data-poll]");
  if (polled) {
    var pollUrl = polled.getAttribute("data-poll");
    var rev = polled.getAttribute("data-rev");
    var pollBusy = false;
    var pollTimer = setInterval(function () {
      if (pollBusy || document.hidden) return;
      pollBusy = true;
      fetch(pollUrl, { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j || j.rev === rev) return;
        rev = j.rev;
        return fetch(location.href, { credentials: "same-origin" }).then(function (r) { return r.text(); }).then(function (html) {
          var fresh = new DOMParser().parseFromString(html, "text/html").querySelector("[data-rev]");
          if (!fresh) return;
          polled.innerHTML = fresh.innerHTML;
          tickTimes();
          bindCopies(polled);
          if (!fresh.getAttribute("data-poll")) clearInterval(pollTimer);
        });
      }).catch(function () {}).then(function () { pollBusy = false; });
    }, 3000);
  }

  // --- signing in with a Realm character: follow the code until the whisper lands --
  var realm = document.querySelector("[data-realm-login]");
  if (realm) {
    var realmBusy = false;
    var realmTimer = setInterval(function () {
      if (realmBusy) return;
      realmBusy = true;
      fetch(realm.getAttribute("data-realm-login"), { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.state === "verified") { clearInterval(realmTimer); location.href = "/auth/realm/finish"; return; }
        // The bot took the code (the whisper line can be shown now), or the code is over: the page says what next.
        var waiting = !!realm.querySelector("[data-realm-wait]");
        if ((j.state === "ready" && waiting) || j.state === "failed" || j.state === "expired" || j.state === "used" || j.state === "none") { clearInterval(realmTimer); location.reload(); }
      }).catch(function () {}).then(function () { realmBusy = false; });
    }, 2000);
  }

  // --- a pool tile named in the link (?give=item) arrives picked -----------------
  (function () {
    var done = false;
    document.querySelectorAll("[data-preselect]").forEach(function (box) {
      if (done) return;
      var id = box.getAttribute("data-preselect");
      if (!id) return;
      var input = box.querySelector('input[data-item="' + id + '"]:not(:disabled)');
      if (!input) return;
      input.checked = true;
      done = true;
      var details = box.closest("details");
      if (details) details.open = true;
      var form = box.closest("form");
      var det = form && form.querySelector("details");
      if (det) det.open = true;
      setTimeout(function () { input.closest(".tile").scrollIntoView({ block: "center", behavior: "smooth" }); }, 50);
    });
  })();

})();

// --- communism page: tray, the pool page's filters and sorts, transact tabs ---
(function () {
  "use strict";
  var page = document.querySelector("[data-communism]");
  if (!page) return;
  var openStream = window.hubOpenStream || function () { return null; };
  var grid = page.querySelector("[data-grid]");
  var tray = page.querySelector("[data-tray]");
  var form = page.querySelector("[data-withdraw-form]");
  var MAX = Number((page.querySelector("[data-tray-max]") || {}).getAttribute ? page.querySelector("[data-tray-max]").getAttribute("data-tray-max") : 8) || 8;
  var picks = []; // { ref, node, nodename, label, sprite }
  var data = { effectLabels: {}, dismantle: [], matSteps: {} };
  try { data = JSON.parse((page.querySelector("[data-communism-data]") || {}).textContent || "{}"); } catch (e) { /* the filters just have less to go on */ }

  // Tiles are checkboxes for the no-script case; with script the tray owns the picks (parseTile disables them).
  // Every tile read once: what the filters and sorts weigh.
  var MAT = ["common", "rare", "legendary", "mythical"];
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function list(v) { return v ? v.split("|") : []; }
  function parseTile(el) {
    var refs = [];
    try { refs = JSON.parse(el.getAttribute("data-refs") || "[]"); } catch (e) { /* no refs: never picked */ }
    var mat = el.getAttribute("data-mat");
    var stats = {};
    (el.getAttribute("data-stats") || "").split(",").forEach(function (kv) { var p = kv.split(":"); if (p[0]) stats[p[0]] = num(p[1]); });
    var classes = el.getAttribute("data-classes");
    var t = {
      el: el, key: el.getAttribute("data-key") || "", refs: refs, group: refs, count: el.querySelector(".stack-count"),
      id: el.getAttribute("data-item") || "", label: el.getAttribute("data-label") || "", text: el.getAttribute("data-name") || "",
      ench: num(el.getAttribute("data-ench")), enchNames: list(el.getAttribute("data-enchnames")), effects: list(el.getAttribute("data-effects")),
      node: el.getAttribute("data-node") || "", nodename: el.getAttribute("data-nodename") || "", sprite: el.getAttribute("data-sprite") || "",
      fp: num(el.getAttribute("data-fp")), mat: mat ? mat.split(",").map(num) : null,
      classes: classes ? classes.split(",") : null, slot: el.getAttribute("data-slot") || "", cat: el.getAttribute("data-cat") || "", stats: stats,
      enchIds: (el.getAttribute("data-enchids") || "").split(",").filter(Boolean).map(num),
      mixed: false,
    };
    t.rarity = Math.min(t.ench, 4);
    // The hover card says all the title did, and more.
    el.removeAttribute("title");
    el.querySelectorAll("input").forEach(function (i) { i.disabled = true; });
    return t;
  }
  var all = (grid ? Array.prototype.slice.call(grid.querySelectorAll(".pool-tile")) : []).map(parseTile);

  function hint(text, bad) {
    var h = page.querySelector("[data-tray-hint]");
    if (!h) return;
    h.textContent = text;
    h.classList.toggle("bad", !!bad);
  }
  var defaultHint = (page.querySelector("[data-tray-hint]") || {}).textContent || "";

  function render() {
    if (!tray || !form) return;
    tray.innerHTML = "";
    var slots = Math.max(8, Math.ceil(picks.length / 4) * 4);
    for (var i = 0; i < slots; i++) {
      var p = picks[i];
      var s = document.createElement(p ? "button" : "span");
      if (p) {
        s.type = "button";
        s.className = "tray-slot filled";
        s.title = p.label + " · " + p.nodename + " · click to take it out";
        if (p.sprite) { var im = document.createElement("span"); im.className = "tile-spr"; im.setAttribute("style", p.sprite); s.appendChild(im); }
        else { var f = document.createElement("span"); f.className = "tile-fallback"; f.textContent = p.label.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase(); s.appendChild(f); }
        var x = document.createElement("span"); x.className = "tray-x"; x.textContent = "×"; s.appendChild(x);
        (function (idx) { s.addEventListener("click", function () { picks.splice(idx, 1); render(); }); })(i);
      } else {
        s.className = "tray-slot empty";
        var m = document.createElement("span"); m.className = "tray-empty-mark"; m.textContent = "+"; s.appendChild(m);
      }
      tray.appendChild(s);
    }
    // The form carries the picks and the node they come from.
    form.innerHTML = "";
    // Each pick names its node with its ref ("node~ref"): refs are unique per node only, and one withdraw may take from several.
    picks.forEach(function (p) { var h = document.createElement("input"); h.type = "hidden"; h.name = "refs"; h.value = p.node + "~" + p.ref; form.appendChild(h); });
    var c = page.querySelector("[data-tray-count]"); if (c) c.textContent = "(" + picks.length + "/" + MAX + ")";
    var nn = page.querySelector("[data-tray-n]"); if (nn) nn.textContent = picks.length ? String(picks.length) : "the picked";
    page.querySelectorAll("[data-submit-withdraw], [data-submit-take]").forEach(function (b) { b.disabled = picks.length === 0; });
    var picked = {}; picks.forEach(function (p) { picked[p.ref] = true; });
    all.forEach(function (t) {
      var n = t.group.filter(function (r) { return picked[r]; }).length;
      t.el.classList.toggle("in-tray", n > 0 && n >= t.group.length);
    });
    if (picks.length) {
      var nodes = []; picks.forEach(function (p) { if (nodes.indexOf(p.nodename) < 0) nodes.push(p.nodename); });
      hint(picks.length + " from " + nodes.join(", ") + (nodes.length > 1 ? " · each node's bot meets you in turn on the server below." : " · the account holding them meets you on the server below."), false);
    } else hint(defaultHint, false);
  }

  if (grid) grid.addEventListener("click", function (e) {
    var el = e.target.closest(".pool-tile");
    if (!el || !grid.contains(el)) return;
    e.preventDefault();
    var t = all.filter(function (x) { return x.el === el; })[0];
    if (!t) return;
    if (el.classList.contains("unclickable")) { hint("That node is offline right now.", true); return; }
    if (picks.length >= MAX) { hint("That is the most one withdraw can take (" + MAX + ").", true); return; }
    var picked = {}; picks.forEach(function (p) { picked[p.ref] = true; });
    var free = t.group.filter(function (r) { return !picked[r]; });
    if (!free.length) { hint("Every one of those is in the tray already.", true); return; }
    picks.push({ ref: free[0], node: t.node, nodename: t.nodename, label: t.label, sprite: t.sprite });
    render();
  });

  // --- filters: the node pool page's, on the tiles' data ---------------------
  var state = {
    q: "", tags: [], node: "",
    cls: null, slot: null, consumable: null,
    mat: { common: 0, rare: 0, legendary: 0, mythical: 0 }, matExact: false,
    feedMin: 0, feedExact: false, enchMin: 0, enchExact: false,
    collapse: false, sort: "feed",
  };
  var vectors = (data.dismantle || []).map(function (v) { return { common: v[0], rare: v[1], legendary: v[2], mythical: v[3] }; });
  var matSteps = data.matSteps || {};

  function passesMin(actual, min, exact) { return exact ? actual === min : min === 0 || actual >= min; }
  function passesMaterials(t) {
    var f = state.mat;
    if (!state.matExact && MAT.every(function (k) { return f[k] === 0; })) return true;
    return MAT.every(function (k, i) { var d = t.mat ? t.mat[i] : 0; return state.matExact ? d === f[k] : d >= f[k]; });
  }
  function matchesTags(tags, t) {
    var anyItem = false, itemOk = false;
    for (var i = 0; i < tags.length; i++) {
      var g = tags[i];
      if (g.kind === "item") { anyItem = true; if (g.id === t.id) itemOk = true; }
      else if (g.kind === "ench") { if (t.enchNames.indexOf(g.name) === -1) return false; }
      else if (t.effects.indexOf(g.key) === -1) return false;
    }
    return !anyItem || itemOk;
  }
  function railFiltered() {
    return all.filter(function (t) {
      if (state.node && t.node !== state.node) return false;
      if (state.cls && !(t.classes && t.slot && (t.classes.indexOf("ALL") !== -1 || t.classes.indexOf(state.cls) !== -1))) return false;
      if (state.slot && t.slot !== state.slot) return false;
      if (state.consumable && t.cat !== state.consumable) return false;
      if (!passesMaterials(t)) return false;
      if (!passesMin(t.fp, state.feedMin, state.feedExact)) return false;
      if (!passesMin(t.ench, state.enchMin, state.enchExact)) return false;
      return true;
    });
  }
  function filtered(rail) {
    var q = state.q;
    return rail.filter(function (t) { return matchesTags(state.tags, t) && (!q || t.text.indexOf(q) !== -1); });
  }

  function apply() {
    if (!grid) return;
    var rail = railFiltered();
    var vis = filtered(rail);
    // Collapse by rarity: one tile per item and rarity on a node, enchants ignored; a click picks any of them.
    var groups = [], byKey = {};
    vis.forEach(function (t) {
      var key = state.collapse ? t.node + "|" + t.id + "|" + t.rarity : t.el.getAttribute("data-refs");
      var g = byKey[key];
      if (!g) { g = { rep: t, members: [], refs: [], fp: t.fp, ench: t.ench, rarity: t.rarity, label: t.label, stats: t.stats }; byKey[key] = g; groups.push(g); }
      g.members.push(t);
      g.refs = g.refs.concat(t.refs);
    });
    var by = state.sort;
    if (by === "feed") groups.sort(function (a, b) { return b.fp - a.fp || a.label.localeCompare(b.label); });
    else if (by === "qty") groups.sort(function (a, b) { return b.refs.length - a.refs.length; });
    else if (by === "rarity") groups.sort(function (a, b) { return b.rarity - a.rarity; });
    else if (by.indexOf("stat:") === 0) { var which = by.slice(5); groups.sort(function (a, b) { return (b.stats[which] || 0) - (a.stats[which] || 0) || a.label.localeCompare(b.label); }); }
    var shown = {};
    groups.forEach(function (g) {
      shown[g.rep.id + "|" + g.rep.el.getAttribute("data-refs")] = true;
      g.rep.group = g.refs;
      g.rep.mixed = g.members.some(function (m) { return m.enchIds.join(",") !== g.rep.enchIds.join(","); });
      if (g.rep.count) { g.rep.count.textContent = "×" + g.refs.length; g.rep.count.hidden = g.refs.length <= 1; }
      g.rep.el.classList.remove("hidden");
      grid.appendChild(g.rep.el);
    });
    all.forEach(function (t) {
      if (shown[t.id + "|" + t.el.getAttribute("data-refs")]) return;
      t.group = t.refs;
      t.mixed = false;
      if (t.count) { t.count.textContent = "×" + t.refs.length; t.count.hidden = t.refs.length <= 1; }
      t.el.classList.add("hidden");
    });
    var n = 0; groups.forEach(function (g) { n += g.refs.length; });
    var e = page.querySelector("[data-empty]"); if (e) e.hidden = n > 0 || !all.length;
    var c = page.querySelector("[data-count-line]"); if (c) c.textContent = n + " item" + (n === 1 ? "" : "s") + (c.getAttribute("data-rest") || "");
    render();
    suggest(rail);
  }

  // The tag search: chips for an item, an enchantment or an effect; the text also narrows the grid as typed.
  var search = page.querySelector("[data-search]");
  var tagBox = page.querySelector("[data-tag-box]");
  var suggestBox = page.querySelector("[data-tag-suggest]");
  var focused = false, cursor = 0, rows = [];
  function tagKey(t) { return t.kind + ":" + (t.id || t.name || t.key); }
  function spriteOf(id) { var t = all.filter(function (x) { return x.id === id; })[0]; return t ? t.sprite : ""; }
  function spriteEl(style) { var s = document.createElement("span"); s.className = "tile-spr tag-spr"; s.setAttribute("style", style); return s; }
  function renderTags() {
    if (!tagBox || !search) return;
    tagBox.querySelectorAll(".tag-chip").forEach(function (c) { c.remove(); });
    state.tags.forEach(function (t, i) {
      var chip = document.createElement("span");
      chip.className = "tag-chip tag-" + t.kind;
      if (t.kind === "item") { var st = spriteOf(t.id); if (st) chip.appendChild(spriteEl(st)); }
      var l = document.createElement("span"); l.className = "tag-chip-label"; l.textContent = t.label; chip.appendChild(l);
      var x = document.createElement("button"); x.type = "button"; x.className = "tag-chip-x"; x.setAttribute("aria-label", "Remove " + t.label); x.textContent = "×";
      x.addEventListener("click", function (e) { e.stopPropagation(); state.tags.splice(i, 1); renderTags(); apply(); search.focus(); });
      chip.appendChild(x);
      tagBox.insertBefore(chip, search);
    });
    search.placeholder = state.tags.length ? "" : "Search items, enchantments or effects…";
  }
  function addTag(t) {
    if (state.tags.some(function (x) { return tagKey(x) === tagKey(t); })) return;
    state.tags.push(t);
    state.q = ""; if (search) search.value = "";
    renderTags(); apply();
    if (search) search.focus();
  }
  function suggest(rail) {
    if (!suggestBox || !search) return;
    var q = state.q, MAXG = 8;
    var nonItem = state.tags.filter(function (t) { return t.kind !== "item"; });
    var taggedItem = {}, taggedEnch = {}, taggedEff = {};
    state.tags.forEach(function (t) { if (t.kind === "item") taggedItem[t.id] = true; else if (t.kind === "ench") taggedEnch[t.name] = true; else taggedEff[t.key] = true; });
    var items = {}, enchants = {}, effects = {};
    rail.forEach(function (t) {
      if (!taggedItem[t.id] && matchesTags(nonItem, t)) items[t.id] = t.label;
      if (!matchesTags(state.tags, t)) return;
      t.enchNames.forEach(function (n) { if (!taggedEnch[n]) enchants[n] = true; });
      t.effects.forEach(function (k) { if (!taggedEff[k]) effects[k] = true; });
    });
    rows = [];
    Object.keys(items).map(function (id) { return { kind: "item", id: id, label: items[id] }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label); })
      .filter(function (r) { return !q || r.label.toLowerCase().indexOf(q) !== -1; }).slice(0, MAXG).forEach(function (r) { rows.push(r); });
    Object.keys(enchants).sort().filter(function (n) { return !q || n.toLowerCase().indexOf(q) !== -1; }).slice(0, MAXG).forEach(function (n) { rows.push({ kind: "ench", name: n, label: n }); });
    Object.keys(effects).sort().map(function (k) { return { kind: "effect", key: k, label: (data.effectLabels || {})[k] || k }; })
      .filter(function (r) { return !q || r.label.toLowerCase().indexOf(q) !== -1 || r.key.toLowerCase().indexOf(q) !== -1; }).slice(0, MAXG).forEach(function (r) { rows.push(r); });
    if (cursor >= rows.length) cursor = 0;
    var open = focused && rows.length > 0 && (q.length > 0 || state.tags.length > 0);
    suggestBox.hidden = !open;
    search.setAttribute("aria-expanded", open ? "true" : "false");
    (page.querySelector("[data-tag-search]") || {}).classList && page.querySelector("[data-tag-search]").classList.toggle("open", open);
    suggestBox.innerHTML = "";
    if (!open) return;
    var lastKind = null;
    rows.forEach(function (r, i) {
      var li = document.createElement("li");
      if (r.kind !== lastKind) { var h = document.createElement("div"); h.className = "tag-suggest-head"; h.textContent = r.kind === "item" ? "Items" : r.kind === "ench" ? "Enchantments" : "Effects"; li.appendChild(h); lastKind = r.kind; }
      var b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", i === cursor ? "true" : "false");
      b.className = "tag-suggest-row tag-" + r.kind + (i === cursor ? " active" : "");
      if (r.kind === "item") { var st = spriteOf(r.id); if (st) b.appendChild(spriteEl(st)); }
      var l = document.createElement("span"); l.textContent = r.label; b.appendChild(l);
      b.addEventListener("mouseenter", function () { cursor = i; suggest(railFiltered()); });
      b.addEventListener("click", function () { addTag(r); });
      li.appendChild(b);
      suggestBox.appendChild(li);
    });
  }
  if (search) {
    search.addEventListener("input", function () { state.q = search.value.trim().toLowerCase(); cursor = 0; apply(); });
    search.addEventListener("focus", function () { focused = true; tagBox && tagBox.classList.add("focused"); suggest(railFiltered()); });
    search.addEventListener("blur", function () { focused = false; tagBox && tagBox.classList.remove("focused"); suggest(railFiltered()); });
    search.addEventListener("keydown", function (e) {
      if (e.key === "Backspace" && search.value === "" && state.tags.length) { e.preventDefault(); state.tags.pop(); renderTags(); apply(); return; }
      if (suggestBox.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); cursor = (cursor + 1) % rows.length; suggest(railFiltered()); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cursor = (cursor - 1 + rows.length) % rows.length; suggest(railFiltered()); }
      else if (e.key === "Enter") { if (rows[cursor]) { e.preventDefault(); addTag(rows[cursor]); } }
      else if (e.key === "Escape") { focused = false; search.blur(); }
    });
  }
  if (tagBox) tagBox.addEventListener("click", function () { search && search.focus(); });
  // Keep the input focused while clicking a row.
  if (suggestBox) suggestBox.addEventListener("mousedown", function (e) { e.preventDefault(); });

  // Node chips.
  page.querySelectorAll("[data-chips]").forEach(function (row) {
    row.addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      state.node = b.getAttribute("data-value") || "";
      row.querySelectorAll(".chip").forEach(function (x) { x.classList.toggle("active", x === b); });
      apply();
    });
  });
  var sort = page.querySelector("[data-sort]");
  if (sort) sort.addEventListener("change", function () { state.sort = sort.value; apply(); });
  var collapse = page.querySelector("[data-collapse]");
  if (collapse) collapse.addEventListener("change", function () { state.collapse = collapse.checked; apply(); });

  // The rail: class and slot combine; a consumable stands alone (each clears the other).
  var railBox = page.querySelector("[data-rail-box]");
  function paintRail() {
    if (!railBox) return;
    railBox.querySelectorAll("[data-rail]").forEach(function (b) {
      var g = b.getAttribute("data-rail"), v = b.getAttribute("data-value");
      var on = g === "class" ? state.cls === v : g === "slot" ? state.slot === v : state.consumable === v;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  if (railBox) railBox.addEventListener("click", function (e) {
    var b = e.target.closest("[data-rail]"); if (!b) return;
    var g = b.getAttribute("data-rail"), v = b.getAttribute("data-value");
    if (g === "class") { state.cls = state.cls === v ? null : v; state.consumable = null; }
    else if (g === "slot") { state.slot = state.slot === v ? null : v; state.consumable = null; }
    else { state.consumable = state.consumable === v ? null : v; state.cls = null; state.slot = null; }
    paintRail(); apply();
  });

  // The sliders. Material sliders snap to real amounts and keep each other feasible (the node's reconcileMat).
  var ORDER = ["common", "rare", "legendary", "mythical"];
  function feasible(f) { return vectors.some(function (it) { return ORDER.every(function (k) { return it[k] >= f[k]; }); }); }
  function prevStep(k, v) { var steps = matSteps[k] || [0]; var i = steps.indexOf(v); return i > 0 ? steps[i - 1] : 0; }
  function floorPositive(items, k) { var min = Infinity; items.forEach(function (it) { if (it[k] > 0) min = Math.min(min, it[k]); }); return min === Infinity ? 0 : min; }
  function allHave(items, k) { return items.length > 0 && items.every(function (it) { return it[k] > 0; }); }
  function reconcile(next, moved) {
    var r = { common: next.common, rare: next.rare, legendary: next.legendary, mythical: next.mythical };
    if (moved === "mythical") { if (r.mythical > 0) { r.common = 0; r.rare = 0; r.legendary = 0; } return r; }
    if (r.mythical > 0) r.mythical = 0;
    var v = r[moved];
    if (v > 0) {
      var vis = vectors.filter(function (it) { return it[moved] >= v; });
      var movedTier = ORDER.indexOf(moved);
      ["common", "rare", "legendary"].forEach(function (j) {
        if (j === moved) return;
        var lower = ORDER.indexOf(j) < movedTier;
        r[j] = lower || allHave(vis, j) ? floorPositive(vis, j) : 0;
      });
    }
    var guard = 0;
    while (!feasible(r) && guard++ < 40) {
      var pick = null;
      ORDER.forEach(function (k) { if (k === moved || r[k] <= 0) return; if (pick === null || r[k] > r[pick]) pick = k; });
      if (pick === null) break;
      r[pick] = prevStep(pick, r[pick]);
    }
    return r;
  }
  function stepsOf(input) { return (input.getAttribute("data-steps") || "0").split(",").map(num); }
  function valueLabel(group, amount) {
    var exact = group === "mat" ? state.matExact : group === "feed" ? state.feedExact : state.enchExact;
    return exact ? "exactly " + amount : amount + " or more";
  }
  function paintSliders() {
    page.querySelectorAll("[data-slider]").forEach(function (input) {
      var g = input.getAttribute("data-slider"), amount;
      if (g === "mat") { var k = input.getAttribute("data-mat"); amount = state.mat[k]; input.value = String(Math.max(0, stepsOf(input).indexOf(amount))); }
      else if (g === "feed") { amount = state.feedMin; input.value = String(Math.max(0, stepsOf(input).indexOf(amount))); }
      else { amount = state.enchMin; input.value = String(amount); }
      var exact = g === "mat" ? state.matExact : g === "feed" ? state.feedExact : state.enchExact;
      input.setAttribute("aria-valuetext", exact ? "exactly " + amount : amount === 0 ? "any" : "at least " + amount);
      var val = input.parentNode.querySelector("[data-exact]");
      if (val) { val.textContent = valueLabel(g, amount); val.setAttribute("aria-pressed", exact ? "true" : "false"); val.title = exact ? "Click to match this amount or more" : "Click to match exactly this amount"; }
    });
  }
  page.querySelectorAll("[data-slider]").forEach(function (input) {
    input.addEventListener("input", function () {
      var g = input.getAttribute("data-slider"), idx = num(input.value);
      if (g === "mat") { var k = input.getAttribute("data-mat"); var next = { common: state.mat.common, rare: state.mat.rare, legendary: state.mat.legendary, mythical: state.mat.mythical }; next[k] = stepsOf(input)[idx] || 0; state.mat = reconcile(next, k); }
      else if (g === "feed") state.feedMin = stepsOf(input)[idx] || 0;
      else state.enchMin = idx;
      paintSliders(); apply();
    });
  });
  page.querySelectorAll("[data-exact]").forEach(function (b) {
    b.addEventListener("click", function () {
      var g = b.getAttribute("data-exact");
      if (g === "mat") state.matExact = !state.matExact; else if (g === "feed") state.feedExact = !state.feedExact; else state.enchExact = !state.enchExact;
      paintSliders(); apply();
    });
  });

  // --- keeping the board current -------------------------------------------------
  // The stream carries the hub's revision; when it passes ours we fetch what changed
  // since the one we hold (a few tiles), or the whole grid when the hub cannot say.
  var rev = num(page.getAttribute("data-rev"));
  var half = page.getAttribute("data-half") || "seasonal";
  var liveUrl = page.getAttribute("data-communism-live");
  var syncing = false, syncAgain = false, syncTimer = null;
  function tileFrom(html) { var tpl = document.createElement("template"); tpl.innerHTML = html; return tpl.content.firstElementChild; }
  function replaceTile(key, html) {
    var el = tileFrom(html);
    if (!el) return;
    var t = parseTile(el);
    var i = -1;
    all.forEach(function (x, j) { if (x.key === key) i = j; });
    if (i >= 0) { all[i].el.replaceWith(el); all[i] = t; } else { grid.appendChild(el); all.push(t); }
  }
  function dropTile(key) {
    all = all.filter(function (t) { if (t.key !== key) return true; t.el.remove(); return false; });
  }
  function prunePicks() {
    var live = {};
    all.forEach(function (t) { t.refs.forEach(function (r) { live[r] = true; }); });
    var before = picks.length;
    picks = picks.filter(function (p) { return live[p.ref]; });
    if (picks.length !== before) hint("Some picked items were taken by someone else and left the tray.", true);
  }
  function applyDelta(d) {
    if (typeof d.full === "string") {
      grid.innerHTML = d.full;
      all = Array.prototype.slice.call(grid.querySelectorAll(".pool-tile")).map(parseTile);
    } else {
      (d.removed || []).forEach(dropTile);
      (d.tiles || []).forEach(function (t) { replaceTile(t.key, t.html); });
    }
    rev = d.rev;
    page.setAttribute("data-rev", String(rev));
    var c = page.querySelector("[data-count-line]"); if (c && d.rest !== undefined) c.setAttribute("data-rest", d.rest);
    var nodes = page.querySelector("[data-nodes]"); if (nodes && d.nodes) nodes.innerHTML = d.nodes;
    var be = page.querySelector("[data-board-empty]"); if (be) be.hidden = all.length > 0;
    if (grid) grid.hidden = all.length === 0;
    prunePicks();
    apply();
  }
  function sync() {
    if (!grid || !liveUrl) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    fetch("/communism/delta?half=" + encodeURIComponent(half) + "&since=" + rev, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && typeof d.rev === "number" && d.rev !== rev) applyDelta(d); })
      .catch(function () {})
      .then(function () { syncing = false; if (syncAgain) { syncAgain = false; sync(); } });
  }
  if (liveUrl && grid) {
    openStream(liveUrl, {
      message: function (e) {
        if (num(e.data) <= rev) return;
        clearTimeout(syncTimer);
        syncTimer = setTimeout(sync, 250);
      },
      // A stream that dropped and came back may have missed revisions: check once.
      open: function () { if (rev > 0) sync(); },
    });
  }

  // --- the hover card: rotmgcommunism's (Vault.tsx TilePortalTip / ItemStats), on /tooltips.json ---
  var RARITY_NAMES = ["common", "uncommon", "rare", "legendary", "divine"];
  var FORGE = [{ key: "common", label: "Common Material" }, { key: "rare", label: "Rare Material" }, { key: "legendary", label: "Legendary Material" }, { key: "mythical", label: "Mythical Material" }];
  var tips = null, tipsLoading = null, tipEl = null, tipFor = null;
  function loadTips() {
    if (tips || tipsLoading) return tipsLoading;
    tipsLoading = fetch("/tooltips.json", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (j) { tips = j; return j; }).catch(function () { tipsLoading = null; return null; });
    return tipsLoading;
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  function round1(n) { return Math.round(n * 10) / 10; }
  function signed(v) { return v >= 0 ? "+" + round1(v) : String(round1(v)); }
  function norm(n) { return n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim(); }
  // Fold the enchantments into the item's numbers: what changed is shown green.
  function applyEnchants(t, ids) {
    var mods = ids.map(function (id) { return tips.mods[String(id)]; }).filter(Boolean);
    var stats = {}, order = [];
    (t.e || []).forEach(function (e) { if (!e.r && !e.pct) { stats[e.s] = { base: e.v, bonus: 0 }; order.push(e.s); } });
    var r = { stats: stats, order: order, dmg: [1, 1], rof: 1, rng: 1, mp: 1, xp: 0, lines: [] };
    mods.forEach(function (m) {
      (m.e || []).forEach(function (e) { if (!stats[e.s]) { stats[e.s] = { base: 0, bonus: 0 }; order.push(e.s); } stats[e.s].bonus += e.v; });
      if (m.dmg) r.dmg = [r.dmg[0] * m.dmg[0], r.dmg[1] * m.dmg[1]];
      if (m.rof) r.rof *= m.rof;
      if (m.rng) r.rng *= m.rng;
      if (m.mp) r.mp *= m.mp;
      if (m.xp) r.xp += m.xp;
      if (m.t) r.lines.push(m.t);
    });
    return r;
  }
  function row(label, value, boosted) {
    var d = el("div", "tip-row");
    d.appendChild(el("span", "tip-label", label));
    var v = el("span", "tip-val" + (boosted ? " tip-boost" : ""));
    if (typeof value === "string" || typeof value === "number") v.textContent = String(value); else v.appendChild(value);
    d.appendChild(v);
    return d;
  }
  function itemStats(name, ids) {
    var t = tips.items[norm(name)];
    if (!t) return null;
    var box = el("div", "tip-stats");
    var kind = el("div", "tip-kind");
    if (t.t) kind.appendChild(el("span", "tip-tier", t.t));
    kind.appendChild(el("span", "", t.k));
    var classes = !t.c || t.c.length === 0 ? null : t.c[0] === "ALL" ? "All classes" : t.c.join(", ");
    if (classes) kind.appendChild(el("span", "tip-classes", classes));
    box.appendChild(kind);
    if (t.d) box.appendChild(el("div", "tip-desc", t.d));
    var ench = applyEnchants(t, ids);
    (t.a || []).forEach(function (a, i) {
      var at = el("div", "tip-attack");
      var lo = Math.round(a.dmg[0] * ench.dmg[0]), hi = Math.round(a.dmg[1] * ench.dmg[1]);
      var dmg = el("span", "", lo === hi ? lo : lo + "–" + hi);
      if (lo !== hi) dmg.appendChild(el("span", "tip-dim", " (avg " + (lo + hi) / 2 + ")"));
      at.appendChild(row(i === 0 ? "Damage" : "Alt damage", dmg, lo !== a.dmg[0] || hi !== a.dmg[1]));
      if (a.shots > 1) { var sh = el("span", "", a.shots); if (a.arc) sh.appendChild(el("span", "tip-dim", " (" + a.arc + "° apart)")); at.appendChild(row("Shots", sh)); }
      if (a.burst) at.appendChild(row("Burst", a.burst));
      var range = round1(a.range * ench.rng), rof = Math.round(a.rof * ench.rof);
      at.appendChild(row("Range", range, range !== a.range));
      if (rof !== 100) at.appendChild(row("Rate of Fire", rof + "%", rof !== a.rof));
      box.appendChild(at);
    });
    (t.p || []).forEach(function (l) { box.appendChild(el("div", "tip-line", l)); });
    // On equip: the item's own stats with every flat enchant bonus, in the item's order, then stats only the enchants add.
    var eq = el("span", "tip-equip"), any = false;
    (t.e || []).forEach(function (e) {
      any = true;
      if (e.r || e.pct) { var x = el("span", "", e.pct ? signed(e.v) + "% " + e.s : signed(e.v) + " " + e.s); if (e.r) x.appendChild(el("span", "tip-dim", " (of " + e.r + ")")); eq.appendChild(x); return; }
      var st = ench.stats[e.s];
      eq.appendChild(el("span", st.bonus ? "tip-boost" : "", signed(st.base + st.bonus) + " " + e.s));
    });
    ench.order.forEach(function (s) {
      if ((t.e || []).some(function (e) { return e.s === s && !e.r && !e.pct; })) return;
      any = true;
      eq.appendChild(el("span", "tip-boost", signed(ench.stats[s].bonus) + " " + s));
    });
    if (any) box.appendChild(row("On Equip", eq));
    if (t.mp !== undefined) box.appendChild(row("MP Cost", Math.round(t.mp * ench.mp), ench.mp !== 1));
    if (t.mpe !== undefined || t.mps !== undefined) box.appendChild(row("MP Cost", [t.mps !== undefined ? t.mps + "/s" : null, t.mpe !== undefined ? t.mpe + " on release" : null].filter(Boolean).join(", ")));
    if (t.cd !== undefined) box.appendChild(row("Cooldown", t.cd + "s"));
    (t.l || []).forEach(function (l) { box.appendChild(el("div", "tip-line", l)); });
    (t.x || []).forEach(function (x) { var d = el("div", "tip-line"); if (x.n) d.appendChild(el("span", "tip-x-name", x.n + ": ")); d.appendChild(document.createTextNode(x.d)); box.appendChild(d); });
    ench.lines.forEach(function (l) { box.appendChild(el("div", "tip-line tip-boost", l)); });
    if (t.set) box.appendChild(el("div", "tip-line tip-dim", "Set: " + t.set));
    if (t.xp !== undefined || ench.xp > 0) box.appendChild(row("XP Bonus", round1((t.xp || 0) + ench.xp) + "%", ench.xp > 0));
    return box;
  }
  function fillTip(t) {
    tipEl.innerHTML = "";
    tipEl.appendChild(el("div", "pool-tile-tip-name", t.label));
    var rarity = RARITY_NAMES[t.rarity];
    tipEl.appendChild(el("div", "pool-tile-tip-rarity rarity-" + rarity, rarity));
    var ids = t.mixed ? [] : t.enchIds;
    if (tips) { var st = itemStats(t.label, ids); if (st) tipEl.appendChild(st); }
    if (t.mat && t.mat.some(function (n) { return n > 0; })) {
      var dm = el("div", "pool-tile-tip-dismantle");
      dm.appendChild(el("span", "pool-tile-tip-dismantle-label", "Dismantle"));
      FORGE.forEach(function (f, i) {
        if (!(t.mat[i] > 0)) return;
        var m = el("span", "pool-tile-tip-dismantle-mat", t.mat[i]);
        var im = el("img"); im.src = "/forge/" + f.key + ".png"; im.alt = f.label; im.title = f.label; m.appendChild(im);
        dm.appendChild(m);
      });
      tipEl.appendChild(dm);
    }
    if (t.fp > 0) {
      var fd = el("div", "pool-tile-tip-feed");
      fd.appendChild(el("span", "pool-tile-tip-feed-label", "Feed Power"));
      fd.appendChild(el("span", "pool-tile-tip-feed-val", t.fp));
      tipEl.appendChild(fd);
    }
    if (t.mixed) tipEl.appendChild(el("div", "pool-tile-tip-bot", "mixed enchantments — stacked by rarity & type"));
    else if (ids.length) {
      var ul = el("ul", "pool-tile-tip-enchants");
      ids.forEach(function (id, i) {
        var li = el("li");
        var im = el("img", "pool-tile-tip-enchant-icon"); im.src = "/enchant-icon/" + id + ".png"; im.alt = ""; im.setAttribute("aria-hidden", "true");
        im.onerror = function () { im.remove(); };
        li.appendChild(im);
        li.appendChild(el("span", "", (tips && tips.enchants[String(id)]) || t.enchNames[i] || "Enchant #" + id));
        ul.appendChild(li);
      });
      tipEl.appendChild(ul);
    }
    var n = t.group.length;
    if (n > 1) tipEl.appendChild(el("div", "pool-tile-tip-bot", "×" + n + " in the pool"));
    // Which bot holds it, and whose node it is, stay private: the meeting names the bot to whoever takes it.
    tipEl.appendChild(el("div", "pool-tile-tip-bot", "on " + t.nodename));
  }
  function placeTip(tile) {
    // Above the tile when there is room for the stat block, else below; kept inside the window sideways.
    var r = tile.getBoundingClientRect();
    var above = r.top > Math.min(420, window.innerHeight * 0.55);
    tipEl.style.top = (above ? r.top - 6 : r.bottom + 6) + "px";
    tipEl.style.transform = above ? "translateY(-100%)" : "none";
    var w = tipEl.offsetWidth;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    tipEl.style.left = left + "px";
  }
  function showTip(t) {
    if (!tipEl) { tipEl = el("div", "pool-tile-tip"); tipEl.setAttribute("role", "tooltip"); document.body.appendChild(tipEl); }
    tipFor = t;
    fillTip(t);
    tipEl.hidden = false;
    placeTip(t.el);
    if (!tips) { var p = loadTips(); if (p) p.then(function () { if (tipFor === t && tips) { fillTip(t); placeTip(t.el); } }); }
  }
  function hideTip() { tipFor = null; if (tipEl) tipEl.hidden = true; }
  if (grid) {
    grid.addEventListener("mouseover", function (e) {
      var tile = e.target.closest && e.target.closest(".pool-tile");
      if (!tile || !grid.contains(tile)) return;
      if (tipFor && tipFor.el === tile) return;
      var t = all.filter(function (x) { return x.el === tile; })[0];
      if (t) showTip(t);
    });
    grid.addEventListener("mouseleave", hideTip);
    grid.addEventListener("scroll", hideTip, { passive: true });
    window.addEventListener("scroll", hideTip, { passive: true });
  }

  // Transact tabs.
  var box = page.querySelector("[data-transact]");
  if (box) box.querySelectorAll("[data-tab]").forEach(function (b) {
    b.addEventListener("click", function () {
      var want = b.getAttribute("data-tab");
      box.querySelectorAll("[data-tab]").forEach(function (x) { x.classList.toggle("active", x === b); });
      box.querySelectorAll("[data-pane]").forEach(function (p) { p.hidden = p.getAttribute("data-pane") !== want; });
    });
  });
  // Deposit size buttons highlight without :has() support.
  box && box.querySelectorAll(".size-btn input").forEach(function (r) {
    r.addEventListener("change", function () { box.querySelectorAll(".size-btn").forEach(function (l) { l.classList.toggle("active", l.querySelector("input").checked); }); });
  });

  paintRail();
  paintSliders();
  renderTags();
  apply();
})();
