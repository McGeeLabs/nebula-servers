const grid = document.getElementById("serverGrid");
const page = window.NEBULA_PAGE || "all";

let CONFIG = null;
let REFRESH_MS = 15000;
let LAST_MERGED = [];
let ACTIVE_TAG = null;

function timeAgo(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Date.now() - t);

  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function deriveStatus(s) {
  // Disabled = hard off
  if (s.enabled === false) {
    return {
      label: "Disabled",
      class: "disabled",
      dot: "disabled"
    };
  }

  // Maintenance = intentional but temporary
  if (s.maintenance === true) {
    return {
      label: "Maintenance",
      class: "maintenance",
      dot: "maintenance"
    };
  }

  if (s.online) {
    return {
      label: "Online",
      class: "online",
      dot: "on"
    };
  }

  return {
    label: "Offline",
    class: "offline",
    dot: "off"
  };
}

function fmtUrl(url) {
  // Pretty display without losing actual href
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function mergeConfigWithStatus(configList, statusMap) {
  return configList.map(cfg => {
    const st = statusMap?.[cfg.id] || {};
    return {
      ...cfg,
      ...st,
      // sensible defaults
      online: st.online ?? false,
      lastCheckAt: st.lastCheckAt ?? null
    };
  });
}

function buildDesc(s) {
  const lines = [];

  if (s.maintenance && s.maintenanceReason) {
    lines.push(
      `Maintenance: <strong>${s.maintenanceReason}</strong>`
    );
  }

  // Version (for everything, if available)
  if (s.version) lines.push(`Version: <strong>${s.version}</strong>`);

  if (s.kind === "game") {
    if (s.players != null && s.maxPlayers != null) {
      lines.push(`Players: <strong>${s.players} / ${s.maxPlayers}</strong>`);
    }
    if (s.ip && s.port) {
      lines.push(`IP: <span class="mono">${s.ip}:${s.port}</span>`);
    }
  } else {
    if (s.type) lines.push(`Type: <strong>${s.type}</strong>`);
    if (s.port != null) lines.push(`Port: <span class="mono">${s.port}</span>`);
    if (s.url) lines.push(`URL: <a class="mono" href="${s.url}" target="_blank" rel="noreferrer">${fmtUrl(s.url)}</a>`);
    if (s.ip && s.port) lines.push(`Host: <span class="mono">${s.ip}:${s.port}</span>`);
  }

  // Last check only (status is shown in footer)
  lines.push(`Last check: ${timeAgo(s.lastCheckAt)}`);

  return lines.join("<br/>");
}

function render(mergedList) {
  grid.innerHTML = "";

  let list = page === "all"
    ? mergedList
    : mergedList.filter(s => s.group === page);

  if (ACTIVE_TAG) {
    list = list.filter(s => (s.tags || []).includes(ACTIVE_TAG));
  }

  const filterEl = document.getElementById("activeFilter");
  if (filterEl) filterEl.textContent = `Filter: ${ACTIVE_TAG ?? "All"}`;


  // Optional: sort online first
  list.sort((a, b) => Number(b.online) - Number(a.online));

  list.forEach(s => {
    const tile = document.createElement("div");

    const status = deriveStatus(s);
    tile.className = `tile ${status.class}`;

    const descHtml = buildDesc(s);

    const isPlaceholderHost = s.ip === "0.0.0.0";
    const copyTarget = (s.ip && s.port && !isPlaceholderHost) ? `${s.ip}:${s.port}` : null;

    tile.innerHTML = `
      <div class="tile-head">
        ${(s.tags || []).map(t => `
          <span class="pill ${ACTIVE_TAG === t ? "active" : ""}" data-tag="${t}">
            ${t}
          </span>
        `).join("")}
      </div>

      <div class="tile-title">${s.name}</div>
      <div class="tile-desc">${descHtml}</div>

      <div class="tile-foot">
        <div class="status">
          <span class="dot ${status.dot}"></span>
          ${status.label}
        </div>

        <div>
          ${s.enabled !== false && s.online && s.kind === "game"
            ? `<a class="button primary join" data-id="${s.id}">Join</a>`
            : ""
          }
          ${copyTarget ? `<button class="button copy" data-copy="${copyTarget}">Copy IP</button>` : ""}
          ${s.url ? `<a class="button" href="${s.url}" target="_blank" rel="noreferrer">Open</a>` : ""}
        </div>
      </div>
    `;

    grid.appendChild(tile);

  });

  // Copy buttons
  document.querySelectorAll("button.copy").forEach(btn => {
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = prev), 900);
    });
  });

  // Join buttons (placeholder for now)
  document.querySelectorAll("a.join").forEach(a => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      alert("Join action not wired yet (next step).");
    });
  });

  // Tag filtering (click pills)
  document.querySelectorAll(".pill[data-tag]").forEach(pill => {
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      const tag = pill.dataset.tag;

      ACTIVE_TAG = (ACTIVE_TAG === tag) ? null : tag;
      render(LAST_MERGED);
    });
  });
}

async function loadJson(path) {
  const url = new URL(path, window.location.href);
  url.searchParams.set("_ts", Date.now().toString()); // cache bust

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  try {
    CONFIG = await loadJson("./servers.config.json");

    const tick = async () => {
      const statusMap = await loadJson("./servers.status.json");
      const nowIso = new Date().toISOString();

    Object.keys(statusMap).forEach(id => {
      statusMap[id].lastCheckAt ??= nowIso;
    });
      LAST_MERGED = mergeConfigWithStatus(CONFIG, statusMap);
      render(LAST_MERGED);


      const el = document.getElementById("lastUpdated");
      if (el) el.textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
    };

    await tick();                // initial render immediately
    setInterval(tick, REFRESH_MS); // refresh every 15s

  } catch (err) {
    console.error(err);
    grid.innerHTML = `
      <div class="tile">
        <div class="tile-title">Data Load Error</div>
        <div class="tile-desc">
          Could not load config/status files.<br/>
          Open DevTools Console for details.
        </div>
      </div>
    `;
  }
}

main();

// Tabs auto-active
(() => {
  const file = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".tab").forEach(a => {
    const href = a.getAttribute("href")?.replace("./", "") || "";
    a.classList.toggle("active", href === file);
  });
})();
