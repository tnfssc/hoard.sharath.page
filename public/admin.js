(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { token: "", overview: null, offset: 0, files: [], total: 0, session: 0, request: 0, deletion: null };
  const pageSize = 50;
  let searchTimer;
  class SessionEnded extends Error {}

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function bytes(value) {
    if (value === 0) return "0 B";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const power = Math.min(Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)), units.length - 1);
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: power ? 1 : 0 }).format(value / 1024 ** power) + " " + units[power];
  }
  function lifetime(value) {
    const hours = value.match(/^([\d.]+)h(?:0m)?(?:0s)?$/);
    if (hours && Number(hours[1]) % 24 === 0) return Number(hours[1]) / 24 + "d";
    return value.replace(/([hm])0s$/, "$1").replace(/h0m$/, "h");
  }
  function tenantName(tenant) { return tenant === "" ? "Legacy" : tenant; }
  function expiry(value) {
    const remaining = new Date(value) - Date.now();
    if (remaining <= 0) return "Expired";
    if (remaining < 60000) return "< 1 min";
    if (remaining < 3600000) return Math.ceil(remaining / 60000) + " min";
    if (remaining < 86400000) return Math.ceil(remaining / 3600000) + " hours";
    return Math.ceil(remaining / 86400000) + " days";
  }
  function notice(message, tone = "error") {
    $("notice").textContent = message;
    $("notice").dataset.tone = tone;
    $("notice").hidden = !message;
  }
  function busy(button, value, label) {
    if (value) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = label;
    } else if (button.dataset.originalLabel) {
      button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
    button.disabled = value;
    button.setAttribute("aria-busy", String(value));
  }
  async function api(path, options = {}, token = state.token) {
    const session = state.session;
    const response = await fetch(path, {
      ...options, credentials: "omit", cache: "no-store",
      headers: { "X-Admin-Token": token, "Content-Type": "application/json", ...options.headers },
    });
    if (session !== state.session) throw new SessionEnded();
    const data = response.status === 204 ? null : await response.json();
    if (session !== state.session) throw new SessionEnded();
    if (!response.ok) {
      if (response.status === 401 && state.token && token === state.token) {
        signOut();
        $("login-error").textContent = "Your admin token is no longer accepted. Sign in with the current root token.";
        throw new SessionEnded();
      }
      throw new Error(response.status === 401 ? "That token was not accepted. Use the server’s root ADMIN_TOKEN." : data?.error || "The request failed. Please try again.");
    }
    return data;
  }
  function errorText(error) {
    if (error instanceof TypeError) return "Could not reach Hoard. Check your connection and try again.";
    const messages = {
      invalid_default_ttl: "Use a positive default lifetime, such as 72h or 3d.",
      invalid_max_ttl: "Use a positive maximum lifetime, such as 7d.",
      invalid_max_upload_bytes: "Use a positive upload limit in MiB, or leave it empty to inherit the server limit.",
    };
    return messages[error.message.replaceAll(" ", "_")] || error.message;
  }
  function action(label, run, className = "") {
    const button = node("button", "button " + className, label);
    button.type = "button";
    button.addEventListener("click", run);
    return button;
  }
  async function copy(button, value, errorTarget = "notice") {
    const previous = button.textContent;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied ✓";
      button.dataset.state = "success";
      setTimeout(() => { button.textContent = previous; delete button.dataset.state; }, 2500);
    } catch {
      button.dataset.state = "error";
      if (errorTarget === "notice") notice("Clipboard access failed. Open the file and copy its address.");
      else $(errorTarget).textContent = "Clipboard access failed. Select the key and copy it manually.";
    }
  }

  function renderOverview() {
    const d = state.overview;
    $("stat-files").textContent = d.file_count.toLocaleString();
    $("nav-count").textContent = d.file_count.toLocaleString();
    $("stat-bytes").textContent = bytes(d.total_bytes);
    $("stat-tenants").textContent = d.tenant_count.toLocaleString();
    $("stat-expiring").textContent = d.expiring_count.toLocaleString();
    $("last-updated").textContent = "Updated " + new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    for (const id of ["file-tenant", "token-tenant"]) {
      const select = $(id);
      const oldValue = select.value;
      const hadOptions = select.options.length > 0;
      select.replaceChildren();
      if (id === "file-tenant") select.add(new Option("All tenants", "*"));
      for (const t of d.tenants) select.add(new Option(tenantName(t.name), t.name));
      if (hadOptions && [...select.options].some((o) => o.value === oldValue)) select.value = oldValue;
    }
    const noTenants = d.tenants.length === 0;
    $("token-tenant").disabled = noTenants;
    $("token-form").querySelector("[type=submit]").disabled = noTenants;
    $("token-no-tenants").hidden = !noTenants;
    $("tenant-defaults").textContent = "Empty limits inherit " + lifetime(d.default_ttl) + " default, " + lifetime(d.max_ttl) + " maximum, and " + bytes(d.max_upload_bytes) + " per upload.";
    renderTenants();
  }

  function renderFiles() {
    const list = $("file-list");
    list.replaceChildren();
    for (const file of state.files) {
      const row = node("article", "file-row");
      row.setAttribute("aria-label", file.filename);
      const name = node("div", "file-name");
      const extension = file.filename.includes(".") ? file.filename.split(".").pop().slice(0, 5).toUpperCase() : "FILE";
      const icon = node("span", "file-icon", extension);
      icon.setAttribute("aria-hidden", "true");
      icon.dataset.kind = file.content_type.startsWith("video/") ? "video" : file.content_type.startsWith("image/") ? "image" : file.content_type.startsWith("text/") ? "text" : /zip|gzip|tar/.test(file.content_type) ? "archive" : "other";
      const identity = node("div");
      identity.append(node("p", "filename", file.filename), node("p", "file-id", file.id + " · " + new Date(file.uploaded_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })));
      name.append(icon, identity);
      const owner = node("div", "file-owner");
      owner.append(node("strong", "", tenantName(file.tenant)), node("p", "file-uploader", file.uploader || "Unknown uploader"));
      const expires = node("span", "file-expiry", expiry(file.expires_at));
      if (new Date(file.expires_at) - Date.now() <= 86400000) expires.classList.add("soon");
      expires.title = new Date(file.expires_at).toLocaleString();
      const actions = node("div", "file-actions");
      const open = node("a", "button", "Open ↗");
      open.href = file.path;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.setAttribute("aria-label", "Open " + file.filename);
      const copyLink = action("Copy", (event) => copy(event.currentTarget, file.url));
      copyLink.setAttribute("aria-label", "Copy link to " + file.filename);
      const remove = action("×", () => requestDelete("file", file), "delete-button");
      remove.setAttribute("aria-label", "Delete " + file.filename);
      actions.append(open, copyLink, remove);
      row.append(name, owner, node("span", "file-size", bytes(file.size)), expires, actions);
      list.append(row);
    }
    const filtered = $("file-search").value.trim() !== "" || $("file-tenant").value !== "*";
    $("files-summary").textContent = state.total.toLocaleString() + (state.total === 1 ? " active file" : " active files") + (filtered ? " matching your filters." : ". Shared by link, cleared by expiry.");
    $("files-empty").hidden = state.total !== 0;
    $("file-table").hidden = state.total === 0;
    $("empty-heading").textContent = filtered ? "Nothing matches just yet." : "Room for something new.";
    $("empty-copy").textContent = filtered ? "Try another search or look across all tenants." : "Files appear here after your first upload.";
    $("empty-action").textContent = filtered ? "Clear filters" : "Create token";
    $("pagination").hidden = state.total <= pageSize;
    $("page-label").textContent = (state.offset + 1) + "–" + Math.min(state.offset + pageSize, state.total) + " of " + state.total;
    $("previous").disabled = state.offset === 0;
    $("next").disabled = state.offset + pageSize >= state.total;
  }

  async function loadFiles() {
    if (!state.token) return;
    const request = ++state.request;
    const query = new URLSearchParams({ limit: String(pageSize), offset: String(state.offset) });
    if ($("file-search").value.trim()) query.set("q", $("file-search").value.trim());
    if ($("file-tenant").value !== "*") query.set("tenant", $("file-tenant").value);
    $("file-table").setAttribute("aria-busy", "true");
    try {
      const data = await api("/api/admin/files?" + query);
      if (request !== state.request) return;
      // Deleting the last row on a page moves back to the last available page.
      if (!data.files.length && data.total > 0 && state.offset >= data.total) {
        state.offset = Math.floor((data.total - 1) / pageSize) * pageSize;
        return loadFiles();
      }
      state.files = data.files;
      state.total = data.total;
      renderFiles();
    } catch (error) {
      if (!(error instanceof SessionEnded) && request === state.request) notice(errorText(error));
    } finally {
      if (request === state.request) $("file-table").setAttribute("aria-busy", "false");
    }
  }
  async function refresh() {
    notice("");
    const overview = await api("/api/admin/overview");
    state.overview = overview;
    renderOverview();
    await loadFiles();
  }
  function switchView(view) {
    if (!["files", "tenants", "tokens"].includes(view)) view = "files";
    for (const name of ["files", "tenants", "tokens"]) $("view-" + name).hidden = name !== view;
    document.querySelectorAll("[data-view]").forEach((link) => {
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    $("breadcrumb").textContent = view === "tokens" ? "Upload tokens" : view[0].toUpperCase() + view.slice(1);
    document.title = $("breadcrumb").textContent + " · Hoard admin";
  }
  function mintFor(tenant) {
    location.hash = "tokens";
    switchView("tokens");
    if (tenant !== undefined) $("token-tenant").value = tenant;
    $("token-name").focus();
  }
  function newTenant() {
    $("tenant-form").reset();
    $("tenant-error").textContent = "";
    $("tenant-dialog").showModal();
  }
  function renderTenants() {
    const list = $("tenant-list");
    list.replaceChildren();
    for (const tenant of state.overview.tenants) {
      const row = node("article", "tenant-row");
      const top = node("div", "tenant-top");
      const identity = node("div", "tenant-identity");
      const avatar = node("span", "tenant-avatar", tenantName(tenant.name)[0].toUpperCase());
      avatar.setAttribute("aria-hidden", "true");
      const heading = node("div");
      heading.append(node("h3", "", tenantName(tenant.name)), node("p", "file-uploader", tenant.legacy ? "Original single-tenant space" : "/t/" + tenant.name));
      identity.append(avatar, heading);
      const actions = node("div", "tenant-actions");
      actions.append(action("View files", () => {
        $("file-tenant").value = tenant.name;
        $("file-search").value = "";
        state.offset = 0;
        location.hash = "files";
        switchView("files");
        notice("");
        loadFiles();
      }), action("Create token", () => mintFor(tenant.name)));
      if (!tenant.legacy) actions.append(action("Delete", () => requestDelete("tenant", tenant), "delete-button"));
      top.append(identity, actions);
      const meta = node("div", "tenant-meta");
      meta.append(node("span", "", tenant.file_count + " files · " + bytes(tenant.total_bytes)), node("span", "", lifetime(tenant.default_ttl) + " default / " + lifetime(tenant.max_ttl) + " max"), node("span", "", bytes(tenant.max_upload_bytes) + " upload limit"));
      row.append(top, meta);
      list.append(row);
    }
    $("tenants-empty").hidden = state.overview.tenants.length > 0;
  }
  function showSecrets(title, description, values) {
    $("secret-heading").textContent = title;
    $("secret-description").textContent = description;
    $("secret-error").textContent = "";
    $("secret-values").replaceChildren();
    values.forEach(([label, value], index) => {
      const group = node("div", "secret-value");
      const input = node("textarea");
      input.id = "secret-value-" + index;
      input.value = value;
      input.readOnly = true;
      input.spellcheck = false;
      const heading = node("label", "", label);
      heading.htmlFor = input.id;
      group.append(heading, input, action("Copy key", (event) => copy(event.currentTarget, value, "secret-error")));
      $("secret-values").append(group);
    });
    $("secret-dialog").showModal();
  }
  function requestDelete(type, value) {
    state.deletion = { type, value, confirmation: type === "tenant" ? value.name : value.id };
    $("delete-form").reset();
    $("delete-error").textContent = "";
    $("delete-confirm").removeAttribute("aria-invalid");
    $("delete-heading").textContent = type === "tenant" ? "Delete this tenant?" : "Delete this file?";
    $("delete-description").textContent = type === "tenant" ? "This permanently deletes “" + value.name + "”, all its files, and its keys. This cannot be undone." : "“" + value.filename + "” will be removed immediately and its public link will stop working. This cannot be undone.";
    $("delete-label").textContent = "Type “" + state.deletion.confirmation + "” to confirm";
    $("delete-dialog").showModal();
  }
  function signOut() {
    state.token = "";
    state.overview = null;
    state.files = [];
    state.deletion = null;
    state.session++;
    state.request++;
    clearTimeout(searchTimer);
    document.querySelectorAll("dialog").forEach((dialog) => dialog.close());
    $("secret-values").replaceChildren();
    $("file-list").replaceChildren();
    $("tenant-list").replaceChildren();
    $("app").hidden = true;
    $("login").hidden = false;
    document.querySelector(".skip-link").href = "#login-heading";
    $("login-form").reset();
    $("token-form").reset();
    $("login-error").textContent = "";
    $("admin-token").focus();
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const token = $("admin-token").value.trim();
    $("login-error").textContent = "";
    $("admin-token").removeAttribute("aria-invalid");
    busy(button, true, "Opening…");
    try {
      const overview = await api("/api/admin/overview", {}, token);
      state.token = token;
      state.session++;
      state.offset = 0;
      state.overview = overview;
      $("admin-token").value = "";
      $("file-search").value = "";
      $("file-tenant").value = "*";
      $("login").hidden = true;
      $("app").hidden = false;
      document.querySelector(".skip-link").href = "#main";
      notice("");
      renderOverview();
      switchView(location.hash.slice(1));
      $("main").focus();
      await loadFiles();
    } catch (error) {
      if (!(error instanceof SessionEnded)) {
        $("login-error").textContent = errorText(error);
        $("admin-token").setAttribute("aria-invalid", "true");
      }
    } finally { busy(button, false); }
  });
  $("sign-out").addEventListener("click", signOut);
  window.addEventListener("hashchange", () => switchView(location.hash.slice(1)));
  $("refresh").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    busy(button, true, "Refreshing…");
    try { await refresh(); }
    catch (error) { if (!(error instanceof SessionEnded)) notice(errorText(error)); }
    finally { busy(button, false); }
  });
  $("filters").addEventListener("submit", (event) => event.preventDefault());
  $("file-search").addEventListener("input", () => {
    state.request++;
    state.offset = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { notice(""); loadFiles(); }, 250);
  });
  $("file-tenant").addEventListener("change", () => { state.offset = 0; notice(""); loadFiles(); });
  $("previous").addEventListener("click", () => { state.offset = Math.max(0, state.offset - pageSize); loadFiles(); });
  $("next").addEventListener("click", () => { state.offset += pageSize; loadFiles(); });
  $("empty-action").addEventListener("click", () => {
    if ($("file-search").value.trim() || $("file-tenant").value !== "*") {
      $("file-search").value = ""; $("file-tenant").value = "*"; state.offset = 0; loadFiles();
    } else mintFor();
  });
  $("new-tenant").addEventListener("click", newTenant);
  document.querySelectorAll("[data-action='new-tenant']").forEach((button) => button.addEventListener("click", newTenant));
  document.querySelectorAll("[data-action='mint']").forEach((button) => button.addEventListener("click", () => mintFor()));
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  }));
  $("secret-dialog").addEventListener("close", () => $("secret-values").replaceChildren());
  $("delete-dialog").addEventListener("close", () => { state.deletion = null; });
  $("tenant-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    $("tenant-error").textContent = "";
    busy(button, true, "Creating…");
    const input = {
      name: $("tenant-name").value.trim(), default_ttl: $("tenant-ttl").value.trim(),
      max_ttl: $("tenant-max-ttl").value.trim(), max_upload_bytes: $("tenant-max-size").value ? Number($("tenant-max-size").value) * 1024 ** 2 : 0,
    };
    try {
      const result = await api("/api/tenants", { method: "POST", body: JSON.stringify(input) });
      $("tenant-dialog").close();
      showSecrets("Save this tenant’s keys.", "Created “" + result.tenant.name + "”. These secrets are shown once. Store them somewhere safe before closing.", [["Tenant admin token", result.admin_token], ["JWT signing secret", result.jwt_secret]]);
      await refresh();
    } catch (error) {
      if (!(error instanceof SessionEnded)) {
        if ($("tenant-dialog").open) $("tenant-error").textContent = errorText(error);
        else notice("Tenant created, but the dashboard could not refresh. " + errorText(error));
      }
    } finally { busy(button, false); }
  });
  $("token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const tenant = $("token-tenant").value;
    $("token-error").textContent = "";
    busy(button, true, "Creating…");
    try {
      const path = tenant ? "/t/" + encodeURIComponent(tenant) + "/api/tokens" : "/api/tokens";
      const result = await api(path, { method: "POST", body: JSON.stringify({ name: $("token-name").value.trim(), days: Number($("token-days").value) }) });
      showSecrets("Your upload token is ready.", "“" + result.name + "” can upload to " + tenantName(tenant) + " until " + new Date(result.expires_at).toLocaleString() + ". Copy it before closing.", [["Upload token", result.token]]);
    } catch (error) { if (!(error instanceof SessionEnded)) $("token-error").textContent = errorText(error); }
    finally { busy(button, false); }
  });
  $("delete-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const deletion = state.deletion;
    if (!deletion) return;
    if ($("delete-confirm").value !== deletion.confirmation) {
      $("delete-error").textContent = "Type “" + deletion.confirmation + "” exactly to confirm the deletion.";
      $("delete-confirm").setAttribute("aria-invalid", "true");
      $("delete-confirm").focus();
      return;
    }
    const button = event.submitter;
    $("delete-error").textContent = "";
    busy(button, true, "Deleting…");
    let deleted = false;
    try {
      const path = deletion.type === "tenant" ? "/api/tenants/" + encodeURIComponent(deletion.value.name) : "/api/admin/files/" + deletion.value.id + "?" + new URLSearchParams({ tenant: deletion.value.tenant });
      await api(path, { method: "DELETE" });
      deleted = true;
      $("delete-dialog").close();
      await refresh();
    } catch (error) {
      if (!(error instanceof SessionEnded)) {
        if (deleted) notice("Deleted, but the dashboard could not refresh. " + errorText(error));
        else $("delete-error").textContent = errorText(error);
      }
    } finally { busy(button, false); }
  });
})();
