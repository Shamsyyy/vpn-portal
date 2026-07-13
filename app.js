/* VPN Portal v2 — shm137 + evka */
(() => {
  "use strict";

  const SESSION_KEY = "vpn-portal-session";
  const OVERRIDES_KEY = "vpn-portal-overrides";
  const GH_REPO_KEY = "vpn-portal-gh-repo";
  const GH_TOKEN_KEY = "vpn-portal-gh-token";
  const DEFAULT_REPO = "Shamsyyy/vpn-portal";

  const $ = (id) => document.getElementById(id);

  let authConfig = null;
  let manifest = null;
  let servers = {};
  let overrides = migrateOverrides(loadOverrides());
  let activeServer = "all";
  let viewMode = "clients";
  let editing = null;
  let editingInbound = null;
  let qrUrl = "";
  let probes = {};

  function loadOverrides() {
    try {
      return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function migrateOverrides(raw) {
    const out = {};
    for (const [sid, val] of Object.entries(raw)) {
      if (!val || typeof val !== "object") continue;
      if (val.clients || val.create || val.resetTraffic || val.delete || val.inbounds) {
        out[sid] = {
          clients: val.clients || {},
          inbounds: val.inbounds || {},
          create: val.create || [],
          resetTraffic: val.resetTraffic || [],
          delete: val.delete || [],
        };
        continue;
      }
      out[sid] = { clients: {}, inbounds: {}, create: [], resetTraffic: [], delete: [] };
      for (const [email, patch] of Object.entries(val)) {
        if (email.startsWith("_")) continue;
        out[sid].clients[email] = patch;
      }
    }
    return out;
  }

  function ensureServer(sid) {
    if (!overrides[sid]) {
      overrides[sid] = { clients: {}, inbounds: {}, create: [], resetTraffic: [], delete: [] };
    }
    return overrides[sid];
  }

  function saveOverrides() {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
    updatePendingBar();
  }

  function pruneEmptyServers() {
    for (const [sid, bucket] of Object.entries(overrides)) {
      const empty =
        !Object.keys(bucket.clients || {}).length &&
        !Object.keys(bucket.inbounds || {}).length &&
        !(bucket.create || []).length &&
        !(bucket.resetTraffic || []).length &&
        !(bucket.delete || []).length;
      if (empty) delete overrides[sid];
    }
  }

  /** Remove from local queue exactly what was submitted to GitHub Actions. */
  function clearSubmittedOverrides(payload) {
    for (const [sid, slice] of Object.entries(payload.servers || {})) {
      const bucket = ensureServer(sid);
      if (slice.clients) {
        for (const email of Object.keys(slice.clients)) {
          const patch = bucket.clients[email];
          if (!patch) continue;
          if (patch.note) bucket.clients[email] = { note: patch.note };
          else delete bucket.clients[email];
        }
      }
      if (slice.inbounds) {
        for (const ibId of Object.keys(slice.inbounds)) {
          delete bucket.inbounds[ibId];
        }
      }
      if (slice.resetTraffic?.length) {
        bucket.resetTraffic = bucket.resetTraffic.filter((e) => !slice.resetTraffic.includes(e));
      }
      if (slice.delete?.length) {
        bucket.delete = bucket.delete.filter((e) => !slice.delete.includes(e));
      }
      if (slice.create?.length) {
        const sent = new Set(slice.create.map((x) => (x.email || x)));
        bucket.create = bucket.create.filter((x) => !sent.has(x.email || x));
      }
    }
    pruneEmptyServers();
    saveOverrides();
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function setLoginError(msg, type = "error") {
    const el = $("loginError");
    el.textContent = msg || "";
    el.className = "login-error" + (msg ? " show" : "") + (type === "ok" ? " ok" : "");
  }

  function shakeLogin() {
    document.querySelector(".login-card")?.classList.add("shake");
    setTimeout(() => document.querySelector(".login-card")?.classList.remove("shake"), 500);
  }

  async function loadAuthConfig() {
    if (!window.isSecureContext) {
      throw new Error("Вход доступен только по HTTPS. Откройте сайт через github.io");
    }
    if (!window.crypto?.subtle) {
      throw new Error("Браузер не поддерживает проверку пароля. Попробуйте Chrome или Firefox");
    }
    const res = await fetch(`auth.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Не удалось загрузить настройки входа (HTTP ${res.status})`);
    }
    const cfg = await res.json();
    if (!cfg?.salt || !cfg?.hash || !cfg?.iterations) {
      throw new Error("Файл auth.json повреждён или устарел");
    }
    return cfg;
  }

  async function verifyPassword(password) {
    const salt = b64ToBytes(authConfig.salt);
    const expected = b64ToBytes(authConfig.hash);
    const iterations = Number(authConfig.iterations) || 120000;
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      keyMaterial,
      256
    );
    const got = new Uint8Array(bits);
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
  }

  async function attemptLogin() {
    const pw = $("password").value;
    const btn = $("loginBtn");
    setLoginError("");

    if (!pw) {
      setLoginError("Введите пароль");
      shakeLogin();
      $("password").focus();
      return;
    }

    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = "Проверка…";

    try {
      if (!authConfig) authConfig = await loadAuthConfig();
      const ok = await verifyPassword(pw);
      if (!ok) {
        setLoginError("Некорректный пароль. Проверьте раскладку, Caps Lock и лишние пробелы");
        shakeLogin();
        $("password").focus();
        $("password").select();
        return;
      }
      sessionStorage.setItem(SESSION_KEY, "1");
      setLoginError("Пароль верный, загрузка…", "ok");
      await enterApp();
    } catch (e) {
      setLoginError(e.message || "Ошибка входа");
      shakeLogin();
    } finally {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }

  function toast(msg, isErr = false) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show" + (isErr ? " err" : "");
    setTimeout(() => el.classList.remove("show"), 3200);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtExpiry(ms) {
    if (!ms) return "∞";
    const d = new Date(ms);
    if (ms < Date.now()) return `истёк ${d.toLocaleDateString("ru-RU")}`;
    return d.toLocaleDateString("ru-RU");
  }

  function fmtUptime(sec) {
    if (!sec) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    if (d > 0) return `${d}д ${h}ч`;
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}ч ${m}м` : `${m}м`;
  }

  function dateInputFromMs(ms) {
    if (!ms) return "";
    return new Date(ms).toISOString().slice(0, 10);
  }

  function msFromDateInput(val) {
    if (!val) return 0;
    return new Date(val + "T23:59:59").getTime();
  }

  function mergedClient(serverId, client) {
    const o = ensureServer(serverId).clients[client.email] || {};
    const deleted = ensureServer(serverId).delete.includes(client.email);
    return {
      ...client,
      enable: o.enable !== undefined ? o.enable : client.enable,
      totalGB: o.totalGB !== undefined ? o.totalGB : client.totalGB,
      expiryTime: o.expiryTime !== undefined ? o.expiryTime : client.expiryTime,
      limitIp: o.limitIp !== undefined ? o.limitIp : client.limitIp,
      note: o.note || "",
      _changed: Boolean(o._changed),
      _deleted: deleted,
      _reset: ensureServer(serverId).resetTraffic.includes(client.email),
    };
  }

  function pendingPayload() {
    const out = { updatedAt: new Date().toISOString(), servers: {} };
    let count = 0;
    for (const [sid, bucket] of Object.entries(overrides)) {
      const clients = {};
      for (const [email, patch] of Object.entries(bucket.clients || {})) {
        if (!patch._changed) continue;
        const { _changed, note, ...rest } = patch;
        clients[email] = { ...rest, note: note || "" };
        count++;
      }
      const inbounds = {};
      for (const [ibId, patch] of Object.entries(bucket.inbounds || {})) {
        if (!patch._changed) continue;
        const { _changed, ...rest } = patch;
        inbounds[ibId] = rest;
        count++;
      }
      const slice = {};
      if (Object.keys(clients).length) slice.clients = clients;
      if (Object.keys(inbounds).length) slice.inbounds = inbounds;
      if (bucket.resetTraffic?.length) { slice.resetTraffic = [...bucket.resetTraffic]; count += bucket.resetTraffic.length; }
      if (bucket.delete?.length) { slice.delete = [...bucket.delete]; count += bucket.delete.length; }
      if (bucket.create?.length) { slice.create = [...bucket.create]; count += bucket.create.length; }
      if (Object.keys(slice).length) out.servers[sid] = slice;
    }
    return { payload: out, count };
  }

  function updatePendingBar() {
    const { count } = pendingPayload();
    $("pendingBar").classList.toggle("show", count > 0);
    $("pendingCount").textContent = count ? `(${count})` : "";
  }

  async function loadData() {
    const ts = Date.now();
    const fetchJson = (url) =>
      fetch(url, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r.json();
      });
    const fetchOptional = (url) =>
      fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const [m, s1, s2, p1, p2] = await Promise.all([
      fetchJson(`data/manifest.json?t=${ts}`),
      fetchJson(`data/shm137.json?t=${ts}`),
      fetchJson(`data/evka.json?t=${ts}`),
      fetchOptional(`data/probes/shm137.json?t=${ts}`),
      fetchOptional(`data/probes/evka.json?t=${ts}`),
    ]);
    manifest = m;
    servers = { shm137: s1, evka: s2 };
    probes = { shm137: p1, evka: p2 };
    for (const s of manifest.servers || []) {
      if (s.label?.includes("router")) s.label = s.id;
    }
    for (const id of Object.keys(servers)) {
      if (servers[id].label?.includes("router")) servers[id].label = id;
    }
  }

  function serverTotals(s) {
    if (s.totals) return s.totals;
    const clients = s.clients || [];
    let up = 0, down = 0, online = 0;
    for (const c of clients) {
      up += c.up || 0;
      down += c.down || 0;
      if (c.online) online++;
    }
    return {
      up, down,
      upHuman: formatBytes(up),
      downHuman: formatBytes(down),
      online,
      enabled: clients.filter((c) => c.enable).length,
    };
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
      if (n < 1024) return unit === "B" ? `${n} B` : `${n.toFixed(1)} ${unit}`;
      n /= 1024;
    }
    return `${n.toFixed(1)} PB`;
  }

  function serverAccent(id) {
    return id === "evka" ? "var(--evka)" : "var(--shm)";
  }

  function renderTabs() {
    const tabs = $("serverTabs");
    tabs.innerHTML = "";
    const items = [{ id: "all", label: "Обзор" }, ...(manifest.servers || [])];
    for (const meta of items) {
      const btn = document.createElement("button");
      btn.className = "tab" + (meta.id === activeServer ? " active" : "");
      btn.dataset.id = meta.id;
      btn.textContent = meta.label || meta.id;
      btn.onclick = () => { activeServer = meta.id; renderAll(); };
      tabs.appendChild(btn);
    }
  }

  function renderOverview() {
    const panel = $("overviewPanel");
    const isOverview = activeServer === "all";
    panel.classList.toggle("hidden", !isOverview);
    $("serverPanel").classList.toggle("hidden", isOverview);
    if (!isOverview) return;

    panel.innerHTML = "";
    for (const meta of manifest.servers || []) {
      const s = servers[meta.id];
      const t = serverTotals(s);
      const st = s.status || {};
      const memPct = st.memTotalMb ? Math.round((st.memUsedMb / st.memTotalMb) * 100) : 0;
      const card = document.createElement("div");
      card.className = "overview-card glass";
      card.style.setProperty("--card-accent", serverAccent(meta.id));
      card.innerHTML = `
        <h2>${esc(meta.label || meta.id)}</h2>
        <div class="host">${esc(s.host)} · ${esc(s.exportedAt || "")}</div>
        <div class="mini-stats">
          <div class="mini-stat"><div class="k">Клиенты</div><div class="v">${t.enabled ?? "—"}/${(s.clients || []).length}</div></div>
          <div class="mini-stat"><div class="k">Онлайн</div><div class="v">${t.online ?? 0}</div></div>
          <div class="mini-stat"><div class="k">Скачано</div><div class="v" style="font-size:16px">${esc(t.downHuman || "—")}</div></div>
          <div class="mini-stat"><div class="k">Отдано</div><div class="v" style="font-size:16px">${esc(t.upHuman || "—")}</div></div>
        </div>
        <div class="status-pill ${st.xui === "active" ? "ok" : "bad"}">
          <span class="dot"></span> x-ui ${esc(st.xui || "?")} · RAM ${memPct}% · uptime ${fmtUptime(st.uptimeSec)}
        </div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn sm primary" data-goto="${meta.id}">Открыть</button>
        </div>
      `;
      card.querySelector("[data-goto]").onclick = () => {
        activeServer = meta.id;
        renderAll();
      };
      panel.appendChild(card);
    }
    $("syncMeta").textContent = `Обновлено ${manifest.updatedAt || "—"}`;
  }

  function renderServerHero() {
    const s = servers[activeServer];
    const st = s.status || {};
    const memPct = st.memTotalMb ? Math.min(100, Math.round((st.memUsedMb / st.memTotalMb) * 100)) : 0;
    $("serverHero").innerHTML = `
      <div>
        <h2>${esc(s.label || activeServer)}</h2>
        <div class="sub">${esc(s.host)} · подписка ${esc(s.subBase || "")}</div>
      </div>
      <div class="mem-bar">
        <div class="row"><span>RAM</span><span>${st.memUsedMb || 0} / ${st.memTotalMb || 0} MB</span></div>
        <div class="mem-track"><div class="mem-fill" style="width:${memPct}%"></div></div>
      </div>
      <div class="status-pill ${st.xui === "active" ? "ok" : "bad"}">
        <span class="dot"></span> ${esc(st.xui)} · ${fmtUptime(st.uptimeSec)}
      </div>
    `;
    $("syncMeta").textContent = `${s.label} · обновлено ${s.exportedAt || "—"}`;
  }

  function renderStats() {
    const s = servers[activeServer];
    const t = serverTotals(s);
    const clients = s.clients || [];
    $("stats").innerHTML = `
      <div class="stat"><div class="label">Клиенты</div><div class="value">${clients.length}</div><div class="hint">всего</div></div>
      <div class="stat"><div class="label">Онлайн</div><div class="value">${t.online ?? 0}</div><div class="hint">сейчас</div></div>
      <div class="stat"><div class="label">Скачано</div><div class="value" style="font-size:18px">${esc(t.downHuman || "0")}</div><div class="hint">всего ↓</div></div>
      <div class="stat"><div class="label">Отдано</div><div class="value" style="font-size:18px">${esc(t.upHuman || "0")}</div><div class="hint">всего ↑</div></div>
    `;
  }

  function mergedInbound(serverId, inbound) {
    const o = ensureServer(serverId).inbounds[String(inbound.id)] || {};
    return {
      ...inbound,
      remark: o.remark !== undefined ? o.remark : inbound.remark,
      enable: o.enable !== undefined ? o.enable : inbound.enable,
      _changed: Boolean(o._changed),
    };
  }

  function patchInbound(ibId, patch) {
    const bucket = ensureServer(activeServer);
    const key = String(ibId);
    bucket.inbounds[key] = { ...(bucket.inbounds[key] || {}), ...patch, _changed: true };
    saveOverrides();
    renderInboundList();
    updatePendingBar();
  }

  function probeResultFor(serverId, email) {
    const data = probes[serverId];
    if (!data?.results) return null;
    return data.results.find((r) => r.email === email) || null;
  }

  function renderViewTabs() {
    document.querySelectorAll(".view-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewMode);
    });
    $("clientsView").classList.toggle("hidden", viewMode !== "clients");
    $("inboundsView").classList.toggle("hidden", viewMode !== "inbounds");
    $("probesView").classList.toggle("hidden", viewMode !== "probes");
  }

  function renderInboundList() {
    const grid = $("inboundList");
    const rows = (servers[activeServer].inbounds || []).map((ib) => mergedInbound(activeServer, ib));
    if (!rows.length) {
      grid.innerHTML = '<div class="empty-state">Нет инбаундов</div>';
      return;
    }
    grid.innerHTML = "";
    for (const ib of rows) {
      const el = document.createElement("div");
      el.className = "inbound-card" + (!ib.enable ? " disabled" : "") + (ib._changed ? " changed" : "");
      const extras = [
        ib.sni ? `SNI ${ib.sni}` : "",
        ib.dest ? `dest ${ib.dest}` : "",
        ib.xhttpPath ? `path ${ib.xhttpPath}` : "",
      ].filter(Boolean).join(" · ");
      el.innerHTML = `
        <div class="port">:${ib.port}</div>
        <div class="name">${esc(ib.remark)}</div>
        <div class="meta">${esc(ib.protocol)} · id ${ib.id}${ib.enable ? "" : " · выкл"}</div>
        <span class="net-badge">${esc(ib.network || "tcp")} · ${esc(ib.security || "none")}</span>
        ${extras ? `<div class="meta" style="margin-top:8px">${esc(extras)}</div>` : ""}
        ${ib._changed ? '<span class="badge edit" style="margin-top:8px">изменён</span>' : ""}
        <div class="btn-row" style="margin-top:12px">
          <button class="btn sm" data-ib-edit="${ib.id}">Изменить</button>
          <button class="btn sm" data-ib-toggle="${ib.id}">${ib.enable ? "Выкл" : "Вкл"}</button>
        </div>
      `;
      grid.appendChild(el);
    }
    grid.querySelectorAll("[data-ib-edit]").forEach((b) => b.onclick = () => openInboundEdit(Number(b.dataset.ibEdit)));
    grid.querySelectorAll("[data-ib-toggle]").forEach((b) => {
      const id = Number(b.dataset.ibToggle);
      const base = servers[activeServer].inbounds.find((x) => x.id === id);
      b.onclick = () => patchInbound(id, { enable: !mergedInbound(activeServer, base).enable });
    });
  }

  function openInboundEdit(ibId) {
    const base = servers[activeServer].inbounds.find((x) => x.id === ibId);
    if (!base) return;
    const ib = mergedInbound(activeServer, base);
    editingInbound = { serverId: activeServer, id: ibId };
    $("inboundTitle").textContent = `:${ib.port} · ${ib.remark}`;
    $("inboundSubtitle").textContent = servers[activeServer].label;
    $("inboundEnable").value = String(ib.enable);
    $("inboundPort").value = String(ib.port);
    $("inboundRemark").value = ib.remark || "";
    $("inboundDetails").innerHTML = `
      <div class="cell"><div class="k">Протокол</div><div class="v">${esc(ib.protocol)}</div></div>
      <div class="cell"><div class="k">Сеть</div><div class="v">${esc(ib.network)}</div></div>
      <div class="cell"><div class="k">Security</div><div class="v">${esc(ib.security || "—")}</div></div>
      <div class="cell"><div class="k">Tag</div><div class="v">${esc(ib.tag || "—")}</div></div>
    `;
    $("inboundModal").classList.add("open");
  }

  function renderProbes() {
    const list = $("probeList");
    const probeData = probes[activeServer];
    const clients = (servers[activeServer].clients || []).slice().sort((a, b) => a.email.localeCompare(b.email));
    $("probeMeta").textContent = probeData?.probedAt
      ? `Последний пинг: ${probeData.probedAt}${probeData.fullTunnel === false ? " (только xHTTP)" : ""}`
      : "Пинг ещё не запускался — нажми «Пинг всех VPN»";

    if (!clients.length) {
      list.innerHTML = '<div class="empty-state">Нет клиентов</div>';
      return;
    }

    list.innerHTML = "";
    for (const c of clients) {
      const pr = probeResultFor(activeServer, c.email);
      const ok = pr?.ok;
      const card = document.createElement("div");
      card.className = "card" + (pr ? (ok ? " probe-ok" : " probe-bad") : "");
      const tunnels = (pr?.tunnels || []).map((t) => {
        const st = t.tunnel_ok ? "ok" : "bad";
        const lat = t.latency_ms != null ? `${t.latency_ms} ms` : "—";
        return `<span class="tunnel-chip ${st}">:${t.port} ${esc(t.type || "")} ${lat}</span>`;
      }).join("");
      card.innerHTML = `
        <div class="card-head">
          <div>
            <div class="name">${esc(c.email)}</div>
            <div class="submeta">${pr ? esc(pr.summary || (ok ? "OK" : "FAIL")) : "Нет данных"}</div>
            ${pr?.issues?.length ? `<div class="submeta probe-issues">${esc(pr.issues.join("; "))}</div>` : ""}
          </div>
          <div class="badges">
            ${pr ? `<span class="badge ${ok ? "on" : "off"}">${ok ? "OK" : "FAIL"}</span>` : ""}
            ${pr ? `<span class="badge edit">${pr.tunnels_ok ?? 0}/${pr.tunnels_total ?? 0}</span>` : ""}
          </div>
        </div>
        ${tunnels ? `<div class="tunnel-row">${tunnels}</div>` : ""}
        <div class="btn-row">
          <button class="btn sm primary" data-probe-one="${esc(c.email)}">Пинг</button>
        </div>
      `;
      list.appendChild(card);
    }
    list.querySelectorAll("[data-probe-one]").forEach((b) => {
      b.onclick = async () => {
        try { await triggerProbe(activeServer, b.dataset.probeOne, "1"); }
        catch (e) { toast(e.message || "Ошибка пинга", true); }
      };
    });
  }

  async function triggerProbe(serverId, email = "all", fullTunnel = "1") {
    const { token, repo } = getGhCreds();
    if (!token || token.startsWith("••")) {
      $("githubModal").classList.add("open");
      toast("Нужен GitHub token — открой ⚙", true);
      return;
    }
    const label = email === "all" ? "всех VPN" : email;
    toast(`Запуск пинга ${label}…`);
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/probe-vpn.yml/dispatches`,
      {
        method: "POST",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          ref: "main",
          inputs: { server: serverId, email, full_tunnel: fullTunnel },
        }),
      }
    );
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(ghErrorMessage(err, res.status));
    }
    const mins = email === "all" ? "2–4" : "1–2";
    toast(`Пинг запущен (~${mins} мин). Потом ↻ Синк или «Обновить данные»`);
  }

  function renderInbounds() {
    renderInboundList();
  }

  function getFilteredClients() {
    const q = ($("search").value || "").trim().toLowerCase();
    const filter = $("filterSelect").value;
    const sort = $("sortSelect").value;
    let rows = (servers[activeServer].clients || [])
      .map((c) => mergedClient(activeServer, c))
      .filter((c) => !c._deleted);

    if (q) rows = rows.filter((c) => c.email.toLowerCase().includes(q));
    if (filter === "online") rows = rows.filter((c) => c.online);
    if (filter === "enabled") rows = rows.filter((c) => c.enable);
    if (filter === "disabled") rows = rows.filter((c) => !c.enable);
    if (filter === "changed") rows = rows.filter((c) => c._changed || c._reset);

    rows.sort((a, b) => {
      if (sort === "traffic") return (b.up + b.down) - (a.up + a.down);
      if (sort === "expiry") return (a.expiryTime || 9e15) - (b.expiryTime || 9e15);
      return a.email.localeCompare(b.email);
    });
    return rows;
  }

  function trafficPct(c) {
    if (!c.totalGB) return Math.min(100, (c.down / (50 * 1024 ** 3)) * 100);
    const cap = c.totalGB * 1024 ** 3;
    return Math.min(100, (c.down / cap) * 100);
  }

  function renderClients() {
    const list = $("clientList");
    const rows = getFilteredClients();
    if (!rows.length) {
      list.innerHTML = '<div class="empty-state">Клиенты не найдены</div>';
      return;
    }

    list.innerHTML = "";
    for (const c of rows) {
      const pct = trafficPct(c);
      const card = document.createElement("div");
      card.className = "card" + (!c.enable ? " disabled" : "") + (c._changed || c._reset ? " changed" : "");
      card.innerHTML = `
        <div class="card-head">
          <div>
            <div class="name-row">
              ${c.online ? '<span class="online-dot" title="онлайн"></span>' : ""}
              <div class="name">${esc(c.email)}</div>
            </div>
            <div class="submeta">↑ ${esc(c.upHuman)} · ↓ ${esc(c.downHuman)} · срок ${fmtExpiry(c.expiryTime)}</div>
            ${c.note ? `<div class="submeta">📝 ${esc(c.note)}</div>` : ""}
          </div>
          <div class="badges">
            ${c.online ? '<span class="badge online">online</span>' : ""}
            <span class="badge ${c.enable ? "on" : "off"}">${c.enable ? "ON" : "OFF"}</span>
            ${c._changed ? '<span class="badge edit">изменён</span>' : ""}
            ${c._reset ? '<span class="badge edit">сброс трафика</span>' : ""}
          </div>
        </div>
        <div class="traffic-bar">
          <div class="row"><span>Трафик ↓</span><span>${c.totalGB ? pct.toFixed(0) + "% лимита" : "безлимит"}</span></div>
          <div class="traffic-track"><div class="traffic-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="grid4">
          <div class="cell"><div class="k">Лимит</div><div class="v">${c.totalGB ? c.totalGB + " GB" : "∞"}</div></div>
          <div class="cell"><div class="k">IP</div><div class="v">${c.limitIp || "∞"}</div></div>
          <div class="cell"><div class="k">Инбаунды</div><div class="v">${(servers[activeServer].inbounds || []).length}</div></div>
          <div class="cell"><div class="k">subId</div><div class="v">${esc((c.subId || "").slice(0, 8))}…</div></div>
        </div>
        ${c.subUrl ? `<div class="linktext" title="${esc(c.subUrl)}">${esc(c.subUrl)}</div>` : ""}
        <div class="btn-row">
          <button class="btn sm" data-copy="${esc(c.subUrl || "")}">Копировать</button>
          <button class="btn sm" data-qr="${esc(c.subUrl || "")}" data-name="${esc(c.email)}">QR</button>
          <button class="btn sm" data-edit="${esc(c.email)}">Изменить</button>
          <button class="btn sm" data-probe-client="${esc(c.email)}">Пинг</button>
          <button class="btn sm" data-toggle="${esc(c.email)}">${c.enable ? "Выкл" : "Вкл"}</button>
          <button class="btn sm" data-reset="${esc(c.email)}">Сброс ↓</button>
          <button class="btn sm danger" data-del="${esc(c.email)}">Удалить</button>
        </div>
      `;
      list.appendChild(card);
    }

    bindClientButtons(list);
  }

  function bindClientButtons(list) {
    list.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => openEdit(b.dataset.edit));
    list.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => {
      if (!b.dataset.copy) return toast("Нет ссылки", true);
      navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Скопировано"));
    });
    list.querySelectorAll("[data-qr]").forEach((b) => b.onclick = () => openQr(b.dataset.qr, b.dataset.name));
    list.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = () => {
      const email = b.dataset.toggle;
      const base = servers[activeServer].clients.find((x) => x.email === email);
      patchClient(email, { enable: !mergedClient(activeServer, base).enable });
    });
    list.querySelectorAll("[data-reset]").forEach((b) => b.onclick = () => {
      if (!confirm(`Сбросить трафик ${b.dataset.reset}?`)) return;
      const bucket = ensureServer(activeServer);
      if (!bucket.resetTraffic.includes(b.dataset.reset)) {
        bucket.resetTraffic.push(b.dataset.reset);
        saveOverrides();
        renderClients();
        toast("Сброс добавлен в очередь");
      }
    });
    list.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
      if (!confirm(`Удалить клиента ${b.dataset.del}?`)) return;
      const bucket = ensureServer(activeServer);
      if (!bucket.delete.includes(b.dataset.del)) {
        bucket.delete.push(b.dataset.del);
        saveOverrides();
        renderClients();
        toast("Удаление в очереди");
      }
    });
    list.querySelectorAll("[data-probe-client]").forEach((b) => {
      b.onclick = async () => {
        try { await triggerProbe(activeServer, b.dataset.probeClient, "1"); }
        catch (e) { toast(e.message || "Ошибка пинга", true); }
      };
    });
  }

  function patchClient(email, patch) {
    const bucket = ensureServer(activeServer);
    bucket.clients[email] = { ...(bucket.clients[email] || {}), ...patch, _changed: true };
    saveOverrides();
    renderClients();
    if (activeServer !== "all") renderStats();
  }

  function openEdit(email) {
    const base = servers[activeServer].clients.find((x) => x.email === email);
    const c = mergedClient(activeServer, base);
    editing = { serverId: activeServer, email };
    $("editTitle").textContent = email;
    $("editSubtitle").textContent = servers[activeServer].label;
    $("editEnable").value = String(c.enable);
    $("editTotalGB").value = c.totalGB || 0;
    $("editLimitIp").value = c.limitIp || 0;
    $("editExpiry").value = dateInputFromMs(c.expiryTime);
    $("editNote").value = c.note || "";
    $("editModal").classList.add("open");
  }

  function openQr(url, name) {
    if (!url) return toast("Нет ссылки", true);
    qrUrl = url;
    $("qrTitle").textContent = name || "Подписка";
    $("qrUrl").textContent = url;
    const canvas = $("qrCanvas");
    const size = 240;
    if (typeof qrcode === "function") {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      const n = qr.getModuleCount();
      const cell = size / n;
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "#000000";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect(c * cell, r * cell, cell, cell);
        }
      }
    }
    $("qrModal").classList.add("open");
  }

  function renderAll() {
    renderTabs();
    renderOverview();
    if (activeServer !== "all") {
      renderServerHero();
      renderStats();
      renderViewTabs();
      if (viewMode === "clients") renderClients();
      else if (viewMode === "inbounds") renderInboundList();
      else if (viewMode === "probes") renderProbes();
    }
    updatePendingBar();
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function ghHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function jsonToBase64(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function waitForWorkflow(token, repo, workflowFile, startedAtMs, timeoutMs = 240000) {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=8`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(url, { headers: ghHeaders(token) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(ghErrorMessage(err, res.status));
      }
      const data = await res.json();
      const run = (data.workflow_runs || []).find(
        (r) => new Date(r.created_at).getTime() >= startedAtMs - 8000
      );
      if (run) {
        if (run.status === "completed") {
          if (run.conclusion === "success") return run;
          throw new Error(`Операция не удалась (${run.conclusion}). Смотри Actions в GitHub.`);
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("Таймаут ожидания GitHub Actions (4 мин). Проверь Actions и нажми ↻ Синк позже.");
  }

  async function reloadDataUntilFresh(before, maxAttempts = 12) {
    for (let i = 0; i < maxAttempts; i++) {
      await loadData();
      const fresh =
        (manifest?.updatedAt && manifest.updatedAt !== before.manifestAt) ||
        (servers.shm137?.exportedAt && servers.shm137.exportedAt !== before.shmAt) ||
        (servers.evka?.exportedAt && servers.evka.exportedAt !== before.evkaAt);
      if (fresh) return true;
      await new Promise((r) => setTimeout(r, 6000));
    }
    await loadData();
    return false;
  }

  function dataSnapshot() {
    return {
      manifestAt: manifest?.updatedAt || "",
      shmAt: servers.shm137?.exportedAt || "",
      evkaAt: servers.evka?.exportedAt || "",
    };
  }

  function setBusyButton(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
      btn.dataset.prevLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = busyLabel;
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevLabel || btn.textContent;
    }
  }

  function ghErrorMessage(err, status) {
    const msg = err?.message || "";
    if (status === 401 || status === 403) {
      return "Токен GitHub неверный или нет прав repo/workflow. Создай новый classic token.";
    }
    if (status === 409 || msg.includes("does not match")) {
      return "Конфликт версии файла на GitHub. Повтори через 2 сек или нажми ещё раз.";
    }
    return msg || `Ошибка GitHub (HTTP ${status})`;
  }

  async function pushOverridesViaWorkflow(token, repo, payload) {
    const b64 = jsonToBase64(payload);
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/apply-changes.yml/dispatches`,
      {
        method: "POST",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main", inputs: { payload_b64: b64 } }),
      }
    );
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(ghErrorMessage(err, res.status));
    }
  }

  async function pushOverridesViaContents(token, repo, payload) {
    const path = "data/overrides.json";
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    const content = jsonToBase64(payload);
    const message = "portal: apply client changes";

    for (let attempt = 0; attempt < 3; attempt++) {
      let sha = null;
      const getRes = await fetch(`${api}?ref=main`, { headers: ghHeaders(token) });
      if (getRes.ok) sha = (await getRes.json()).sha;
      else if (getRes.status !== 404) {
        const err = await getRes.json().catch(() => ({}));
        throw new Error(ghErrorMessage(err, getRes.status));
      }

      const body = { message, content, branch: "main" };
      if (sha) body.sha = sha;

      const putRes = await fetch(api, {
        method: "PUT",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (putRes.ok) return;
      const err = await putRes.json().catch(() => ({}));
      if (putRes.status === 409 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw new Error(ghErrorMessage(err, putRes.status));
    }
  }

  async function pushOverrides(token, repo) {
    const { payload, count } = pendingPayload();
    if (!count) {
      toast("Нет изменений", true);
      return;
    }
    if (!token || token.startsWith("••")) {
      throw new Error("GitHub token не задан. Открой ⚙ и вставь ghp_…");
    }

    const before = dataSnapshot();
    const startedAt = Date.now();

    try {
      await pushOverridesViaWorkflow(token, repo, payload);
    } catch {
      await pushOverridesViaContents(token, repo, payload);
    }

    toast("Применение на серверах…");
    await waitForWorkflow(token, repo, "apply-changes.yml", startedAt);
    clearSubmittedOverrides(payload);
    const fresh = await reloadDataUntilFresh(before);
    renderAll();
    toast(fresh ? "Изменения применены, данные обновлены" : "Применено. Если данные старые — ↻ Синк через минуту");
  }

  async function triggerSync(token, repo) {
    const before = dataSnapshot();
    const startedAt = Date.now();
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/sync-data.yml/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(ghErrorMessage(err, res.status) || "Не удалось запустить синк");
    }
    toast("Синк запущен…");
    await waitForWorkflow(token, repo, "sync-data.yml", startedAt);
    const fresh = await reloadDataUntilFresh(before);
    renderAll();
    toast(fresh ? "Данные синхронизированы" : "Синк завершён. Обнови страницу через минуту, если даты не изменились");
  }

  function getGhCreds() {
    return {
      token: sessionStorage.getItem(GH_TOKEN_KEY) || $("ghToken").value.trim(),
      repo: localStorage.getItem(GH_REPO_KEY) || $("ghRepo").value.trim() || DEFAULT_REPO,
    };
  }

  async function enterApp() {
    $("loginScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    await loadData();
    const savedRepo = localStorage.getItem(GH_REPO_KEY) || DEFAULT_REPO;
    $("ghRepo").value = savedRepo;
    if (sessionStorage.getItem(GH_TOKEN_KEY)) $("ghToken").value = "••••••••";
    renderAll();
  }

  async function init() {
    try {
      authConfig = await loadAuthConfig();
    } catch (e) {
      setLoginError(e.message || "Ошибка загрузки auth.json");
    }

    if (sessionStorage.getItem(SESSION_KEY) === "1") {
      try { await enterApp(); } catch (e) { toast("Ошибка загрузки: " + e.message, true); }
    }

    $("loginBtn").onclick = () => attemptLogin();
    $("password").addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });

    $("togglePassword").onclick = () => {
      const input = $("password");
      const btn = $("togglePassword");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Скрыть" : "Показать";
      btn.title = show ? "Скрыть пароль" : "Показать пароль";
      btn.setAttribute("aria-label", btn.title);
    };

    $("logoutBtn").onclick = () => { sessionStorage.removeItem(SESSION_KEY); location.reload(); };

    document.querySelectorAll(".view-tab").forEach((btn) => {
      btn.onclick = () => {
        viewMode = btn.dataset.view || "clients";
        renderAll();
      };
    });

    $("probeAllBtn").onclick = async () => {
      if (activeServer === "all") { toast("Выберите сервер", true); return; }
      try { await triggerProbe(activeServer, "all", "1"); }
      catch (e) { toast(e.message || "Ошибка пинга", true); }
    };
    $("probeRefreshBtn").onclick = async () => {
      try {
        await loadData();
        renderProbes();
        toast("Данные обновлены");
      } catch (e) {
        toast(e.message || "Ошибка загрузки", true);
      }
    };

    $("inboundCancel").onclick = () => $("inboundModal").classList.remove("open");
    $("inboundSave").onclick = () => {
      if (!editingInbound) return;
      patchInbound(editingInbound.id, {
        enable: $("inboundEnable").value === "true",
        remark: $("inboundRemark").value.trim(),
      });
      $("inboundModal").classList.remove("open");
      toast("Сохранено — нажми «Применить на серверах»");
    };

    $("search").oninput = () => renderClients();
    $("filterSelect").onchange = () => renderClients();
    $("sortSelect").onchange = () => renderClients();

    $("editCancel").onclick = () => $("editModal").classList.remove("open");
    $("editSave").onclick = () => {
      if (!editing) return;
      patchClient(editing.email, {
        enable: $("editEnable").value === "true",
        totalGB: parseInt($("editTotalGB").value, 10) || 0,
        limitIp: parseInt($("editLimitIp").value, 10) || 0,
        expiryTime: msFromDateInput($("editExpiry").value),
        note: $("editNote").value.trim(),
      });
      $("editModal").classList.remove("open");
      toast("Сохранено");
    };

    $("addClientBtn").onclick = () => {
      if (activeServer === "all") { toast("Выберите сервер", true); return; }
      $("addServerLabel").textContent = servers[activeServer].label;
      $("addEmail").value = "";
      $("addModal").classList.add("open");
    };
    $("addCancel").onclick = () => $("addModal").classList.remove("open");
    $("addSave").onclick = () => {
      const email = $("addEmail").value.trim();
      if (!email) return toast("Введите имя", true);
      const bucket = ensureServer(activeServer);
      if (!bucket.create.some((x) => (x.email || x) === email)) {
        bucket.create.push({ email });
        saveOverrides();
        toast("Клиент добавлен в очередь");
      }
      $("addModal").classList.remove("open");
    };

    $("qrClose").onclick = () => $("qrModal").classList.remove("open");
    $("qrCopy").onclick = () => navigator.clipboard.writeText(qrUrl).then(() => toast("Скопировано"));

    $("exportChangesBtn").onclick = () => {
      const { payload, count } = pendingPayload();
      if (!count) return toast("Нет изменений", true);
      downloadJson("vpn-portal-changes.json", payload);
      toast("Скачан");
    };

    $("discardBtn").onclick = () => {
      if (!confirm("Отменить все изменения?")) return;
      overrides = {};
      localStorage.removeItem(OVERRIDES_KEY);
      saveOverrides();
      renderAll();
      toast("Отменено");
    };

    $("applyGithubBtn").onclick = async () => {
      const { token, repo } = getGhCreds();
      if (!token || token.startsWith("••")) {
        $("githubModal").classList.add("open");
        toast("Нужен GitHub token — открой ⚙", true);
        return;
      }
      const btn = $("applyGithubBtn");
      setBusyButton(btn, true, "Применение…");
      try {
        await pushOverrides(token, repo);
      } catch (e) {
        toast(e.message || "Ошибка применения", true);
      } finally {
        setBusyButton(btn, false);
      }
    };

    $("syncGithubBtn").onclick = async () => {
      const { token, repo } = getGhCreds();
      if (!token || token.startsWith("••")) {
        $("githubModal").classList.add("open");
        toast("Нужен GitHub token — открой ⚙", true);
        return;
      }
      const btn = $("syncGithubBtn");
      setBusyButton(btn, true, "Синк…");
      try {
        await triggerSync(token, repo);
      } catch (e) {
        toast(e.message || "Ошибка синка", true);
      } finally {
        setBusyButton(btn, false);
      }
    };

    $("settingsBtn").onclick = () => $("githubModal").classList.add("open");
    $("ghCancel").onclick = () => $("githubModal").classList.remove("open");
    $("ghSubmit").onclick = () => {
      const token = $("ghToken").value.trim();
      const repo = $("ghRepo").value.trim() || DEFAULT_REPO;
      if (token && !token.startsWith("••")) sessionStorage.setItem(GH_TOKEN_KEY, token);
      localStorage.setItem(GH_REPO_KEY, repo);
      $("githubModal").classList.remove("open");
      toast("Сохранено");
    };
  }

  init();
})();
