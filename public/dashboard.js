(() => {
  const $ = (id) => document.getElementById(id);
  const state = { snapshot: null, selectedId: null, busy: false, lastSuccess: null };
  const number = (v, d = 1) => v === null || v === undefined || !Number.isFinite(v) ? "Unavailable" : Number(v).toFixed(d);
  const bytes = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return "Unavailable";
    if (v < 1024) return v + " B";
    const units = ["KiB", "MiB", "GiB", "TiB"]; let amount = v, index = -1;
    do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
    return amount.toFixed(1) + " " + units[index];
  };
  const duration = (s) => {
    if (s === null || s === undefined || !Number.isFinite(s)) return "Unavailable";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m";
  };
  const text = (id, value) => { $(id).textContent = value; };
  const meter = (id, value) => {
    const el = $(id);
    const track = el.parentElement;
    const available = value != null && Number.isFinite(value);
    const level = available ? Math.round(Math.max(0, Math.min(100, value))) : 0;
    el.style.width = level + "%";
    track.classList.toggle("meter-unavailable", !available);
    track.classList.toggle("meter-warning", available && level >= 70 && level < 90);
    track.classList.toggle("meter-critical", available && level >= 90);
    if (available) {
      track.setAttribute("aria-valuenow", String(level));
      track.removeAttribute("aria-valuetext");
    } else {
      track.removeAttribute("aria-valuenow");
      track.setAttribute("aria-valuetext", "Metric unavailable");
    }
  };
  function updateHost(h) {
    text("host-cpu", h.cpuPercent == null ? "Warming up" : number(h.cpuPercent) + "%");
    text("host-cpu-detail", h.cpuCount + " logical CPUs · host-wide"); meter("host-cpu-meter", h.cpuPercent);
    text("host-memory", bytes(h.usedMemoryBytes) + " / " + bytes(h.totalMemoryBytes));
    text("host-memory-detail", bytes(h.availableMemoryBytes) + " available · " + number(h.memoryPercent) + "%"); meter("host-memory-meter", h.memoryPercent);
    if (h.dataFilesystem) {
      text("host-disk", bytes(h.dataFilesystem.usedBytes) + " / " + bytes(h.dataFilesystem.totalBytes));
      text("host-disk-detail", bytes(h.dataFilesystem.freeBytes) + " free · " + number(h.dataFilesystem.percent) + "%"); meter("host-disk-meter", h.dataFilesystem.percent);
    } else { text("host-disk", "Unavailable"); text("host-disk-detail", "Filesystem metrics unavailable"); meter("host-disk-meter", null); }
    text("host-load", h.loadAverage.map((v) => number(v, 2)).join(" / "));
    text("host-uptime", "Uptime " + duration(h.uptimeSeconds)); text("host-cpu-count", h.hostname + " · " + h.platform + " " + h.architecture);
  }
  function addCell(row, value, secondary = false) {
    const cell = document.createElement("td"), node = secondary ? document.createElement("span") : document.createElement("strong");
    node.textContent = value; if (secondary) node.className = "cell-secondary"; cell.append(node); row.append(cell); return cell;
  }
  function renderRows() {
    const rows = $("sandbox-rows"); rows.replaceChildren(); if (!state.snapshot) return;
    const query = $("search-filter").value.trim().toLowerCase(), filter = $("status-filter").value;
    const matches = state.snapshot.sandboxes.filter((s) => {
      const haystack = [s.id, s.repository?.fullName, s.workspace?.branch, s.workspace?.commit].filter(Boolean).join(" ").toLowerCase();
      const stopped = ["stopped", "exited", "created", "removed"].includes(s.runtimeState);
      return haystack.includes(query) && (filter === "all" || (filter === "running" && s.runtimeState === "running") || (filter === "stopped" && stopped) || (filter === "unknown" && s.runtimeState !== "running" && !stopped));
    });
    $("table-empty").classList.toggle("hidden", matches.length > 0);
    if (!matches.length) { const row = document.createElement("tr"), cell = document.createElement("td"); cell.colSpan = 8; cell.className = "empty-state"; cell.textContent = "No managed sandboxes are currently recorded."; row.append(cell); rows.append(row); return; }
    for (const s of matches) {
      const row = document.createElement("tr"); row.className = "selectable-row"; row.tabIndex = 0;
      if (s.id === state.selectedId) { row.classList.add("selected-row"); row.setAttribute("aria-selected", "true"); }
      else row.setAttribute("aria-selected", "false");
      row.addEventListener("click", () => selectSandbox(s.id));
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectSandbox(s.id); } });
      const runtime = addCell(row, s.runtimeState); runtime.firstChild.className = "status-pill " + (s.runtimeState === "running" ? "status-running" : ["stopped", "exited", "created", "removed"].includes(s.runtimeState) ? "status-stopped" : "status-unknown");
      const identity = document.createElement("td"), id = document.createElement("strong"), repo = document.createElement("span");
      id.textContent = s.id.slice(0, 8); repo.className = "cell-secondary"; repo.textContent = s.repository?.fullName ?? "Repository unknown"; identity.append(id, repo); row.append(identity);
      const branch = document.createElement("td"), branchName = document.createElement("strong"), commit = document.createElement("span");
      branchName.textContent = s.workspace?.branch ?? "Branch unknown"; commit.className = "cell-secondary mono"; commit.textContent = s.workspace?.commit ? s.workspace.commit.slice(0, 8) : "—"; branch.append(branchName, commit); row.append(branch);
      addCell(row, s.resources.cpuQuotaPercent != null
        ? number(s.resources.cpuQuotaPercent) + "% quota"
        : s.resources.cpuHostPercent != null ? number(s.resources.cpuHostPercent) + "% host"
        : "Unavailable");
      addCell(row, s.resources.memoryCurrentBytes == null ? "Unavailable · " + bytes(s.resources.configuredMemoryBytes) + " configured" : bytes(s.resources.memoryCurrentBytes) + " / " + bytes(s.resources.memoryLimitBytes));
      addCell(row, s.resources.pidsCurrent == null ? "Unavailable / " + (s.resources.configuredPids ?? "Unavailable") : s.resources.pidsCurrent + " / " + (s.resources.pidsLimit ?? "∞"));
      addCell(row, duration(s.uptimeSeconds));
      addCell(row, s.workspace?.dirty == null ? "Unknown" : s.workspace.dirty ? "Modified" : "Clean");
      rows.append(row);
    }
  }
  function detailItem(label, value, mono = false) {
    const box = document.createElement("div"), title = document.createElement("span"), content = document.createElement("strong");
    box.className = "detail-item"; title.className = "metric-label"; title.textContent = label; content.textContent = value;
    if (mono) content.classList.add("mono"); box.append(title, content); return box;
  }
  function selectSandbox(id) {
    state.selectedId = id; renderRows();
    const s = state.snapshot?.sandboxes.find((item) => item.id === id); if (!s) return;
    const content = $("detail-content"); content.replaceChildren();
    const values = [
      ["Sandbox ID", s.id, true], ["Repository", s.repository?.fullName ?? "Unknown"], ["Branch", s.workspace?.branch ?? "Unknown"],
      ["Commit", s.workspace?.commit ?? "Unknown", true], ["Lifecycle", s.lifecycleStatus], ["Runtime", s.runtimeState],
      ["CPU / host", s.resources.cpuHostPercent == null ? "Unavailable" : number(s.resources.cpuHostPercent) + "%"],
      ["CPU / quota", s.resources.cpuQuotaPercent == null ? "Unavailable" : number(s.resources.cpuQuotaPercent) + "%"],
      ["CPU quota cores", s.resources.cpuQuotaCores == null ? "Unavailable · " + (s.resources.configuredCpuMilli == null ? "limit unavailable" : s.resources.configuredCpuMilli + "m configured") : number(s.resources.cpuQuotaCores, 2) + " cores"],
      ["Memory", bytes(s.resources.memoryCurrentBytes) + " / " + bytes(s.resources.memoryLimitBytes)],
      ["Configured memory", bytes(s.resources.configuredMemoryBytes)],
      ["Configured PID limit", String(s.resources.configuredPids ?? "Unavailable")],
      ["Memory limit use", s.resources.memoryPercent == null ? "Unavailable" : number(s.resources.memoryPercent) + "%"],
      ["PIDs", (s.resources.pidsCurrent ?? "Unavailable") + " / " + (s.resources.pidsLimit ?? "Unavailable")],
      ["Workspace disk", bytes(s.resources.workspaceDiskBytes) + (s.resources.workspaceDiskStatus === "partial" ? " · partial scan" : s.resources.workspaceDiskStatus === "unavailable" ? " · unavailable" : "")],
      ["Network RX / TX", s.resources.networkStatus === "available" ? bytes(s.resources.networkRxBytes) + " / " + bytes(s.resources.networkTxBytes) : "Unavailable"],
      ["Cgroup metrics", s.resources.metricStatus],
      ["Runtime sample", state.snapshot.sources.runtime.sampledAt ? new Date(state.snapshot.sources.runtime.sampledAt).toLocaleTimeString() : "Unavailable"],
      ["Working tree", s.workspace?.dirty == null ? "Unknown" : s.workspace.dirty ? "Modified" : "Clean"],
      ["Workspace metadata", s.workspace?.status ?? "Not linked"],
      ["Staged changes", s.workspace?.stagedChanges == null ? "Unavailable" : String(s.workspace.stagedChanges)],
      ["Untracked files", s.workspace?.untrackedFiles == null ? "Unavailable" : String(s.workspace.untrackedFiles)],
      ["Uptime", duration(s.uptimeSeconds)], ["Created", new Date(s.createdAt).toLocaleString()], ["Last update", new Date(s.updatedAt).toLocaleString()],
    ];
    for (const [label, value, mono] of values) content.append(detailItem(label, value, mono));
  }
  function renderHistory(id, samples, metric, maximum, formatTooltip) {
    const chart = $(id); chart.replaceChildren();
    for (const sample of samples.slice(-60)) {
      const value = sample[metric];
      const valid = value !== null && value !== undefined && Number.isFinite(value);
      const level = valid ? Math.max(2, Math.min(100, (value / Math.max(1, maximum)) * 100)) : 0;
      const bar = document.createElement("span");
      bar.className = valid ? "chart-bar" : "chart-bar chart-bar-unavailable";
      bar.style.height = (valid ? level : 2) + "%";
      const timestamp = Number.isFinite(sample.sampledAt)
        ? new Date(sample.sampledAt).toLocaleString()
        : "Time unavailable";
      const tooltip = valid ? formatTooltip(value) + " · " + timestamp : "Metric unavailable · " + timestamp;
      bar.title = tooltip;
      bar.setAttribute("aria-label", tooltip);
      chart.append(bar);
    }
  }
  async function updateHistory() {
    try {
      const response = await fetch("/dashboard/api/history", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("History request failed");
      const history = await response.json();
      const memoryValues = history.host.map((sample) => sample.memoryBytes);
      const maximum = Math.max(1, ...memoryValues.filter((value) => Number.isFinite(value)));
      renderHistory("cpu-history", history.host, "cpuPercent", 100, (value) => number(value) + "% CPU");
      renderHistory("memory-history", history.host, "memoryBytes", maximum, (value) => bytes(value) + " memory used");
      text("cpu-history-state", history.host.length < 2 ? "Collecting CPU baseline" : "Last 30 minutes");
      text("memory-history-state", history.host.length ? "Last 30 minutes" : "Collecting samples");
    } catch { text("cpu-history-state", "History unavailable"); text("memory-history-state", "History unavailable"); }
  }

  async function refresh(force = false) {
    if (state.busy) return; state.busy = true; $("refresh-button").disabled = true;
    try {
      const response = await fetch(force ? "/dashboard/api/overview?refresh=1" : "/dashboard/api/overview", { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) { window.location.assign("/dashboard/auth/login"); return; }
      if (!response.ok) throw new Error("Dashboard request failed");
      state.snapshot = await response.json(); state.lastSuccess = new Date(); updateHost(state.snapshot.host); renderRows();
      await updateHistory();
      if (state.selectedId) selectSandbox(state.selectedId);
      const partial = state.snapshot.warnings.length > 0;
      const indicator = $("connection-state");
      indicator.classList.toggle("hidden", !partial);
      indicator.classList.remove("partial-indicator-error");
      indicator.title = partial ? "Partial data" : "";
      indicator.setAttribute("aria-label", partial ? "Partial data" : "Complete data");
      const statusDetails = $("data-status"); statusDetails.classList.toggle("hidden", !state.snapshot.warnings.length);
      $("data-status").setAttribute("aria-label", "Data warnings: " + state.snapshot.warnings.length);
      const warningList = $("data-status-list"); warningList.replaceChildren();
      for (const warning of state.snapshot.warnings) { const item = document.createElement("li"); item.textContent = warning; warningList.append(item); }
      text("last-updated", "Updated " + state.lastSuccess.toLocaleTimeString() + " · " + state.snapshot.summary.managedSandboxCount + " managed");
    } catch {
      $("connection-state").classList.remove("hidden");
      $("connection-state").classList.add("partial-indicator-error");
      $("connection-state").title = "Data unavailable";
      $("connection-state").setAttribute("aria-label", "Data unavailable");
      text("last-updated", state.lastSuccess ? "Last successful update " + state.lastSuccess.toLocaleTimeString() : "Dashboard data unavailable");
    } finally { state.busy = false; $("refresh-button").disabled = false; }
  }
  $("refresh-button").addEventListener("click", () => refresh(true));
  $("search-filter").addEventListener("input", renderRows);
  $("status-filter").addEventListener("change", renderRows);
  refresh(true); window.setInterval(() => refresh(false), 15000);
})();
