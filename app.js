/* VPN Portal — static dual-server dashboard with password gate */
(() => {
  "use strict";

  const SESSION_KEY = "vpn-portal-session";
  const OVERRIDES_KEY = "vpn-portal-overrides";
  const GH_REPO_KEY = "vpn-portal-gh-repo";

  const $ = (id) => document.getElementById(id);

  let authConfig = null;
  let manifest = null;
  let servers = {};
  let overrides = loadOverrides();
  let activeServer = "shm137";
  let editing = null;

  function loadOverrides() {
    try {
      return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || "{}");
    } catch {
      return {};
    }
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
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: authConfig.iterations, hash: "SHA-256" },
      key,
      256
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

  function fmtExpiry(ms) {
    if (!ms) return "∞";
    const d = new Date(ms);
    if (ms < Date.now()) return `истёк ${d.toLocaleDateString("ru-RU")}`;
    return d.toLocaleDateString("ru-RU");
  }

  function dateInputFromMs(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }

  function msFromDateInput(val) {
    if (!val) return 0;
    return new Date(val + "T23:59:59").getTime();
  }

  function mergedClient(serverId, client) {
    const o = (overrides[serverId] || {})[client.email] || {};
    return {
      ...client,
      enable: o.enable !== undefined ? o.enable : client.enable,
      totalGB: o.totalGB !== undefined ? o.totalGB : client.totalGB,
      expiryTime: o.expiryTime !== undefined ? o.expiryTime : client.expiryTime,
      note: o.note || "",
      _changed: Boolean(o._changed),
    };
  }

  function pendingChanges() {
    const out = { updatedAt: new Date().toISOString(), servers: {} };
    let count = 0;
    for (const [sid, emails] of Object.entries(overrides)) {
      const rows = {};
      for (const [email, patch] of Object.entries(emails || {})) {
        if (!patch._changed) continue;
        const { _changed, note, ...serverPatch } = patch;
        rows[email] = { ...serverPatch, note: note || "" };
        count++;
      }
      if (Object.keys(rows).length) out.servers[sid] = rows;
    }
    return { payload: out, count };
  }

  function updatePendingBar() {
    const { count } = pendingChanges();
    const bar = $("pendingBar");
    if (count > 0) {
      bar.classList.add("show");
      $("pendingCount").textContent = ` — ${count} клиент(ов)`;
    } else {
      bar.classList.remove("show");
    }
  }

  async function loadData() {
    const [m, s1, s2] = await Promise.all([
      fetch("data/manifest.json").then((r) => r.json()),
      fetch("data/shm137.json").then((r) => r.json()),
      fetch("data/evka.json").then((r) => r.json()),
    ]);
    manifest = m;
    servers = { shm137: s1, evka: s2 };
  }

  function renderTabs() {
    const tabs = $("serverTabs");
    tabs.innerHTML = "";
    for (const meta of manifest.servers) {
      const btn = document.createElement("button");
      btn.className = "tab" + (meta.id === activeServer ? " active" : "");
      btn.textContent = meta.label;
      btn.onclick = () => {
        activeServer = meta.id;
        renderAll();
      };
      tabs.appendChild(btn);
    }
  }

  function renderStats() {
    const s = servers[activeServer];
    const clients = s.clients || [];
    const enabled = clients.filter((c) => mergedClient(activeServer, c).enable).length;
    const st = s.status || {};
    $("stats").innerHTML = `
      <div class="stat"><div class="label">Клиенты</div><div class="value">${clients.length}</div></div>
      <div class="stat"><div class="label">Активные</div><div class="value">${enabled}</div></div>
      <div class="stat"><div class="label">Инбаунды</div><div class="value">${(s.inbounds || []).length}</div></div>
      <div class="stat"><div class="label">x-ui</div><div class="value">${st.xui || "?"}</div></div>
    `;
    $("syncMeta").textContent = `${s.label} · ${s.host} · обновлено ${s.exportedAt || "—"}`;
  }

  function renderInbounds() {
    const chips = $("inboundChips");
    chips.innerHTML = "";
    for (const ib of servers[activeServer].inbounds || []) {
      const el = document.createElement("div");
      el.className = "chip";
      el.innerHTML = `<span class="port">:${ib.port}</span> ${ib.remark} · ${ib.protocol}${ib.enable ? "" : " (off)"}`;
      chips.appendChild(el);
    }
  }

  function renderClients() {
    const q = ($("search").value || "").trim().toLowerCase();
    const list = $("clientList");
    list.innerHTML = "";
    const rows = (servers[activeServer].clients || [])
      .map((c) => mergedClient(activeServer, c))
      .filter((c) => !q || c.email.toLowerCase().includes(q))
      .sort((a, b) => a.email.localeCompare(b.email));

    if (!rows.length) {
      list.innerHTML = '<div class="card">Ничего не найдено</div>';
      return;
    }

    for (const c of rows) {
      const card = document.createElement("div");
      card.className = "card" + (!c.enable ? " disabled" : "") + (c._changed ? " changed" : "");
      card.innerHTML = `
        <div class="card-head">
          <div>
            <div class="name">${escapeHtml(c.email)}</div>
            <div class="submeta">${c.upHuman} ↑ · ${c.downHuman} ↓ · срок: ${fmtExpiry(c.expiryTime)}</div>
            ${c.note ? `<div class="submeta">📝 ${escapeHtml(c.note)}</div>` : ""}
          </div>
          <div class="badges">
            <span class="badge ${c.enable ? "on" : "off"}">${c.enable ? "ON" : "OFF"}</span>
            ${c._changed ? '<span class="badge edit">изменён</span>' : ""}
          </div>
        </div>
        <div class="grid4">
          <div class="cell"><div class="k">Лимит</div><div class="v">${c.totalGB ? c.totalGB + " GB" : "∞"}</div></div>
          <div class="cell"><div class="k">IP лимит</div><div class="v">${c.limitIp || "∞"}</div></div>
          <div class="cell"><div class="k">subId</div><div class="v">${escapeHtml(c.subId || "—")}</div></div>
          <div class="cell"><div class="k">Трафик</div><div class="v">${c.upHuman} / ${c.downHuman}</div></div>
        </div>
        ${c.subUrl ? `<div class="linktext" title="${escapeHtml(c.subUrl)}">${escapeHtml(c.subUrl)}</div>` : ""}
        <div class="btn-row">
          <button data-edit="${escapeHtml(c.email)}">Изменить</button>
          <button data-copy="${escapeHtml(c.subUrl || "")}">Копировать sub</button>
          <button data-toggle="${escapeHtml(c.email)}">${c.enable ? "Выключить" : "Включить"}</button>
        </div>
      `;
      list.appendChild(card);
    }

    list.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.onclick = () => openEdit(btn.dataset.edit);
    });
    list.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.onclick = () => {
        if (!btn.dataset.copy) return toast("Нет ссылки", true);
        navigator.clipboard.writeText(btn.dataset.copy).then(() => toast("Скопировано"));
      };
    });
    list.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.onclick = () => {
        const email = btn.dataset.toggle;
        const base = servers[activeServer].clients.find((x) => x.email === email);
        const cur = mergedClient(activeServer, base);
        patchClient(email, { enable: !cur.enable });
      };
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function patchClient(email, patch) {
    if (!overrides[activeServer]) overrides[activeServer] = {};
    const prev = overrides[activeServer][email] || {};
    overrides[activeServer][email] = { ...prev, ...patch, _changed: true };
    saveOverrides();
    renderClients();
  }

  function openEdit(email) {
    const base = servers[activeServer].clients.find((x) => x.email === email);
    const c = mergedClient(activeServer, base);
    editing = { serverId: activeServer, email };
    $("editTitle").textContent = email;
    $("editSubtitle").textContent = servers[activeServer].label;
    $("editEnable").value = String(c.enable);
    $("editTotalGB").value = c.totalGB || 0;
    $("editExpiry").value = dateInputFromMs(c.expiryTime);
    $("editNote").value = c.note || "";
    $("editModal").classList.add("open");
  }

  function closeEdit() {
    editing = null;
    $("editModal").classList.remove("open");
  }

  function renderAll() {
    renderTabs();
    renderStats();
    renderInbounds();
    renderClients();
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

  async function pushToGithub(token, repo) {
    const { payload } = pendingChanges();
    if (!Object.keys(payload.servers).length) {
      toast("Нет изменений", true);
      return;
    }
    const path = "data/overrides.json";
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    let sha;
    const getRes = await fetch(api, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
    if (getRes.ok) sha = (await getRes.json()).sha;
    const putRes = await fetch(api, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "portal: apply client overrides", content, sha }),
    });
    if (!putRes.ok) {
      const err = await putRes.json().catch(() => ({}));
      throw new Error(err.message || putRes.statusText);
    }
    localStorage.setItem(GH_REPO_KEY, repo);
    toast("Отправлено! Action применит изменения (~1 мин)");
    $("githubModal").classList.remove("open");
  }

  async function enterApp() {
    $("loginScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    await loadData();
    const savedRepo = localStorage.getItem(GH_REPO_KEY);
    if (savedRepo) $("ghRepo").value = savedRepo;
    renderAll();
  }

  async function init() {
    authConfig = await fetch("auth.json").then((r) => r.json());
    const session = sessionStorage.getItem(SESSION_KEY);
    if (session === "1") {
      try {
        await enterApp();
      } catch (e) {
        toast("Ошибка загрузки данных: " + e.message, true);
      }
    }

    $("loginBtn").onclick = async () => {
      const pw = $("password").value;
      $("loginError").textContent = "";
      try {
        if (!(await verifyPassword(pw))) {
          $("loginError").textContent = "Неверный пароль";
          return;
        }
        sessionStorage.setItem(SESSION_KEY, "1");
        await enterApp();
      } catch (e) {
        $("loginError").textContent = e.message;
      }
    };
    $("password").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("loginBtn").click();
    });

    $("logoutBtn").onclick = () => {
      sessionStorage.removeItem(SESSION_KEY);
      location.reload();
    };
    $("search").oninput = () => renderClients();
    $("refreshBtn").onclick = () => location.reload();

    $("editCancel").onclick = closeEdit;
    $("editSave").onclick = () => {
      if (!editing) return;
      patchClient(editing.email, {
        enable: $("editEnable").value === "true",
        totalGB: parseInt($("editTotalGB").value, 10) || 0,
        expiryTime: msFromDateInput($("editExpiry").value),
        note: $("editNote").value.trim(),
      });
      closeEdit();
      toast("Сохранено локально");
    };

    $("saveLocalBtn").onclick = () => toast("Изменения в браузере сохранены");
    $("exportChangesBtn").onclick = () => {
      const { payload, count } = pendingChanges();
      if (!count) return toast("Нет изменений", true);
      downloadJson("vpn-portal-changes.json", payload);
      toast("Файл скачан");
    };
    $("discardBtn").onclick = () => {
      if (!confirm("Отменить все локальные изменения?")) return;
      overrides = {};
      localStorage.removeItem(OVERRIDES_KEY);
      updatePendingBar();
      renderClients();
      toast("Отменено");
    };

    $("applyGithubBtn").onclick = () => $("githubModal").classList.add("open");
    $("ghCancel").onclick = () => $("githubModal").classList.remove("open");
    $("ghSubmit").onclick = async () => {
      try {
        await pushToGithub($("ghToken").value.trim(), $("ghRepo").value.trim());
      } catch (e) {
        toast(e.message, true);
      }
    };

    $("copySubBtn").onclick = () => {
      const rows = servers[activeServer].clients || [];
      if (!rows.length) return;
      const first = rows[0];
      if (first.subUrl) navigator.clipboard.writeText(first.subUrl).then(() => toast("Sub скопирован"));
    };
  }

  init();
})();
