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
  let editing = null;
  let qrUrl = "";

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
      if (val.clients || val.create || val.resetTraffic || val.delete) {
        out[sid] = {
          clients: val.clients || {},
          create: val.create || [],
          resetTraffic: val.resetTraffic || [],
          delete: val.delete || [],
        };
        continue;
      }
      out[sid] = { clients: {}, create: [], resetTraffic: [], delete: [] };
      for (const [email, patch] of Object.entries(val)) {
        if (email.startsWith("_")) continue;
        out[sid].clients[email] = patch;
      }
    }
    return out;
  }

  function ensureServer(sid) {
    if (!overrides[sid]) {
      overrides[sid] = { clients: {}, create: [], resetTraffic: [], delete: [] };
    }
    return overrides[sid];
  }

  function saveOverrides() {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
    updatePendingBar();
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function verifyPassword(password) {
    const salt = b64ToBytes(authConfig.salt);
    const expected = b64ToBytes(authConfig.hash);
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: authConfig.iterations, hash: "SHA-256" },
      key, 256
    );
    const got = new Uint8Array(bits);
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
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
      const slice = {};
      if (Object.keys(clients).length) slice.clients = clients;
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
    const [m, s1, s2] = await Promise.all([
      fetch(`data/manifest.json?t=${ts}`).then((r) => r.json()),
      fetch(`data/shm137.json?t=${ts}`).then((r) => r.json()),
      fetch(`data/evka.json?t=${ts}`).then((r) => r.json()),
    ]);
    manifest = m;
    servers = { shm137: s1, evka: s2 };
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

  function renderInbounds() {
    const grid = $("inboundChips");
    grid.innerHTML = "";
    for (const ib of servers[activeServer].inbounds || []) {
      const el = document.createElement("div");
      el.className = "inbound-card";
      el.innerHTML = `
        <div class="port">:${ib.port}</div>
        <div class="name">${esc(ib.remark)}</div>
        <div class="meta">${esc(ib.protocol)}${ib.enable ? "" : " · выкл"}</div>
        <span class="net-badge">${esc(ib.network || "tcp")} · ${esc(ib.security || "none")}</span>
      `;
      grid.appendChild(el);
    }
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
      renderInbounds();
      renderClients();
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
    return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  }

  async function pushOverrides(token, repo) {
    const { payload, count } = pendingPayload();
    if (!count) { toast("Нет изменений", true); return; }
    const path = "data/overrides.json";
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    let sha;
    const getRes = await fetch(api, { headers: ghHeaders(token) });
    if (getRes.ok) sha = (await getRes.json()).sha;
    const putRes = await fetch(api, {
      method: "PUT",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ message: "portal: apply changes", content, sha }),
    });
    if (!putRes.ok) throw new Error((await putRes.json().catch(() => ({}))).message || putRes.statusText);
    toast("Отправлено! Применение ~1 мин");
  }

  async function triggerSync(token, repo) {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/sync-data.yml/dispatches`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error("Не удалось запустить синк");
    }
    toast("Синк запущен. Обнови страницу через 1–2 мин");
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
    authConfig = await fetch("auth.json").then((r) => r.json());
    if (sessionStorage.getItem(SESSION_KEY) === "1") {
      try { await enterApp(); } catch (e) { toast("Ошибка загрузки: " + e.message, true); }
    }

    $("loginBtn").onclick = async () => {
      const pw = $("password").value;
      $("loginError").textContent = "";
      try {
        if (!(await verifyPassword(pw))) { $("loginError").textContent = "Неверный пароль"; return; }
        sessionStorage.setItem(SESSION_KEY, "1");
        await enterApp();
      } catch (e) { $("loginError").textContent = e.message; }
    };
    $("password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });

    $("logoutBtn").onclick = () => { sessionStorage.removeItem(SESSION_KEY); location.reload(); };
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
      if (!token) { $("githubModal").classList.add("open"); return; }
      try { await pushOverrides(token, repo); } catch (e) { toast(e.message, true); }
    };

    $("syncGithubBtn").onclick = async () => {
      const { token, repo } = getGhCreds();
      if (!token) { $("githubModal").classList.add("open"); return; }
      try { await triggerSync(token, repo); } catch (e) { toast(e.message, true); }
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
