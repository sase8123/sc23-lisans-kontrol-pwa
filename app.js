const state = { session: "", projectRef: "", rows: [], selected: null, deferredInstall: null };
const $ = id => document.getElementById(id);
const API_BASE = "https://llarwagbefhnrpnmrvfu.supabase.co/functions/v1/sc23-lisans-web/";

const labels = {
  id: "Kayıt ID", product: "Ürün", machine_code: "Makine Kodu", customer_name: "Ad Soyad",
  customer_email: "E-posta", computer_name: "Bilgisayar Adı", user_name: "Kullanıcı Adı",
  ip_address: "IP Adresi", city: "Şehir", region: "Bölge", country: "Ülke",
  created_at: "Oluşturulma Tarihi", first_seen_at: "İlk Görülme", last_seen_at: "Son Görülme",
  expires_at: "Lisans Bitişi", licensed: "Lisanslı", revoked: "Pasif", is_admin: "Admin",
  accepted_terms_text: "Kabul Edilen Metin", accepted_terms_hash: "Şartname Hash",
  install_accepted_at: "Kabul Tarihi", terms_version: "Şartname Sürümü", event_type: "Olay Türü",
  event: "Olay", payload: "İşlem Bilgisi", version: "Sürüm", title: "Başlık", hash: "Hash"
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  $("loginForm").addEventListener("submit", unlock);
  $("projectsButton").addEventListener("click", loadProjects);
  $("refreshButton").addEventListener("click", loadRows);
  $("projectSelect").addEventListener("change", selectProject);
  $("tableSelect").addEventListener("change", loadRows);
  $("searchInput").addEventListener("input", renderRows);
  $("pdfButton").addEventListener("click", exportPdf);
  $("mobilePdfButton").addEventListener("click", exportPdf);
  $("licenseTimeButton").addEventListener("click", showLicenseTime);
  $("messageClose").addEventListener("click", () => $("messageDialog").close());
  $("installButton").addEventListener("click", installPwa);
  document.querySelectorAll("[data-license]").forEach(button => button.addEventListener("click", () => updateLicense(button.dataset.license)));
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    state.deferredInstall = event;
    $("installButton").hidden = false;
  });
  window.addEventListener("online", updateOnlineState);
  window.addEventListener("offline", updateOnlineState);
  window.addEventListener("resize", syncActionPlacement);
  window.addEventListener("scroll", syncActionPlacement, { passive: true });
  updateOnlineState();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  syncActionPlacement();
  $("passwordInput").focus();
}

async function unlock(event) {
  event.preventDefault();
  $("loginError").textContent = "";
  try {
    const result = await request("api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("passwordInput").value })
    }, false);
    state.session = result.session;
    $("passwordInput").value = "";
    $("lockView").hidden = true;
    $("appView").hidden = false;
    await loadProjects();
  } catch (error) {
    $("loginError").textContent = error.message || "Program şifresi hatalı.";
  }
}

async function request(path, options = {}, authenticated = true) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (authenticated && state.session) headers.Authorization = `Bearer ${state.session}`;
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw }; }
  if (!response.ok) {
    if (response.status === 401 && authenticated) {
      state.session = "";
      $("appView").hidden = true;
      $("lockView").hidden = false;
    }
    throw new Error(data?.message || `Bağlantı hatası (${response.status})`);
  }
  return data;
}

async function loadProjects() {
  await busy("Supabase projeleri alınıyor...", async () => {
    const projects = await request("api/projects");
    const select = $("projectSelect");
    select.innerHTML = '<option value="">Proje seçin</option>';
    projects.forEach(project => select.add(new Option(`${project.name} (${project.ref})`, project.ref)));
    if (projects.length) {
      select.value = state.projectRef && projects.some(p => p.ref === state.projectRef) ? state.projectRef : projects[0].ref;
      await selectProject();
    }
  });
}

async function selectProject() {
  state.projectRef = $("projectSelect").value;
  if (!state.projectRef) return;
  await busy("Proje kayıt türleri alınıyor...", async () => {
    const tables = await request(`api/tables?projectRef=${encodeURIComponent(state.projectRef)}`);
    const select = $("tableSelect");
    select.innerHTML = "";
    const shownTables = visibleTables(tables);
    tableOptions(shownTables).forEach(item => select.add(new Option(item.label, item.name)));
    if (shownTables.length) await loadRows();
  });
}

async function loadRows() {
  const table = $("tableSelect").value;
  if (!table || !state.projectRef) return;
  await busy("Kayıtlar yenileniyor...", async () => {
    state.rows = await request(`api/rows?projectRef=${encodeURIComponent(state.projectRef)}&table=${encodeURIComponent(table)}`);
    state.selected = null;
    $("detailContent").className = "detail-empty";
    $("detailContent").textContent = "Detayları görmek için bir kayıt seçin.";
    $("licenseActions").hidden = true;
    syncActionPlacement();
    $("recordTitle").textContent = tableTitle(table);
    renderRows();
    renderSummary();
  });
}

function renderRows() {
  const term = $("searchInput").value.trim().toLocaleLowerCase("tr");
  const rows = state.rows.filter(row => !term || JSON.stringify(row).toLocaleLowerCase("tr").includes(term))
    .sort((a, b) => statusRank(runtimeStatus(a)) - statusRank(runtimeStatus(b)) || dateValue(b.last_seen_at || b.created_at) - dateValue(a.last_seen_at || a.created_at));
  const host = $("records");
  host.innerHTML = "";
  rows.forEach(row => {
    const status = runtimeStatus(row);
    const button = document.createElement("button");
    button.className = `record ${statusClass(status)}${state.selected === row ? " selected" : ""}`;
    const title = first(row, "customer_name", "name", "user_name", "machine_code", "product", "id") || "İsimsiz kayıt";
    const subtitle = [row.customer_email, row.computer_name, row.machine_code].filter(Boolean).join(" / ");
    button.innerHTML = `<span class="status">${escapeHtml(status)}</span><span class="record-main"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle || tableTitle($("tableSelect").value))}</span></span><time>${escapeHtml(formatDate(row.last_seen_at || row.created_at))}</time>`;
    button.addEventListener("click", () => selectRow(row));
    host.append(button);
  });
  $("recordCount").textContent = `${rows.length} kayıt`;
  $("emptyState").hidden = rows.length > 0;
}

function renderSummary() {
  const statuses = ["Admin", "Aktif", "Deneme", "Bekleyen", "Süresi Dolan", "Pasif"];
  $("summary").innerHTML = statuses.map(status => `<div class="metric ${statusClass(status)}"><span>${status}</span><strong>${state.rows.filter(row => runtimeStatus(row) === status).length}</strong></div>`).join("");
}

function selectRow(row) {
  state.selected = row;
  renderRows();
  const content = $("detailContent");
  content.className = "";
  const dl = document.createElement("dl");
  dl.className = "detail-fields";
  const preferred = ["customer_name", "customer_email", "machine_code", "computer_name", "user_name", "product", "ip_address", "city", "region", "country", "created_at", "first_seen_at", "last_seen_at", "expires_at", "install_accepted_at", "terms_version", "accepted_terms_hash", "accepted_terms_text"];
  const keys = [...new Set([...preferred.filter(key => key in row), ...Object.keys(row)])];
  keys.forEach(key => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = labels[key] || titleCase(key);
    dd.textContent = displayValue(row[key]);
    dl.append(dt, dd);
  });
  content.replaceChildren(dl);
  $("licenseActions").hidden = !$("tableSelect").value.includes("license_machines");
  syncActionPlacement();
}

async function updateLicense(action) {
  if (!state.selected?.id) return showMessage("Lisans İşlemi", "Seçili kayıtta ID bulunamadı.");
  await busy("Lisans güncelleniyor...", async () => {
    await request("api/license", {
      method: "POST",
      body: JSON.stringify({
        projectRef: state.projectRef,
        table: $("tableSelect").value,
        row: state.selected,
        action
      })
    });
    await loadRows();
  });
}

async function showLicenseTime() {
  if (!state.selected) return;
  await busy("Lisans geçmişi alınıyor...", async () => {
    const result = await request("api/license-history", {
      method: "POST",
      body: JSON.stringify({ projectRef: state.projectRef, row: state.selected })
    });
    showMessage("Lisans Süresi ve Geçmişi", result.text);
  });
}

function exportPdf() {
  if (!state.selected) return showMessage("PDF", "Önce bir kayıt seçin.");
  document.title = `${first(state.selected, "customer_name", "user_name", "computer_name", "machine_code") || "SC23_Kayit"}_SC23_Rapor`;
  window.print();
  setTimeout(() => document.title = "SC23 Lisans Kontrol", 500);
}

async function installPwa() {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt();
  await state.deferredInstall.userChoice;
  state.deferredInstall = null;
  $("installButton").hidden = true;
}

async function busy(message, action) {
  setStatus(message);
  try { await action(); setStatus("Hazır"); }
  catch (error) { setStatus("Hata"); showMessage("SC23 Lisans Kontrol", error.message); }
}

function showMessage(title, content) {
  $("messageTitle").textContent = title;
  $("messageContent").textContent = content;
  $("messageDialog").showModal();
}

function runtimeStatus(row) {
  if (truthy(row.revoked)) return "Pasif";
  if (truthy(row.is_admin)) return "Admin";
  if (row.expires_at && dateValue(row.expires_at) < Date.now()) return "Süresi Dolan";
  if (truthy(row.licensed)) return "Aktif";
  if (row.first_seen_at && dateValue(row.first_seen_at) + 3 * 86400000 > Date.now()) return "Deneme";
  return "Bekleyen";
}
function statusRank(status) { return ["Admin", "Aktif", "Deneme", "Bekleyen", "Süresi Dolan", "Pasif"].indexOf(status); }
function statusClass(status) { return ({ Admin: "admin", Aktif: "active", Deneme: "trial", Bekleyen: "pending", "Süresi Dolan": "expired", Pasif: "revoked" })[status] || ""; }
function syncActionPlacement() {
  const actions = $("licenseActions");
  const mobileSlot = $("mobileActionSlot");
  const mobilePdf = $("mobilePdfButton");
  const detailPanel = $("detailPanel");
  if (!actions || !mobileSlot || !detailPanel) return;
  const isMobile = window.matchMedia("(max-width: 620px)").matches;
  const target = isMobile ? mobileSlot : detailPanel;
  if (actions.parentElement !== target) target.append(actions);
  if (isMobile && mobilePdf && mobilePdf.previousElementSibling !== actions) {
    mobileSlot.insertBefore(actions, mobilePdf);
  }
  if (mobilePdf) mobilePdf.hidden = !(isMobile && !actions.hidden);
  const hasMobileActions = isMobile && !actions.hidden;
  const shouldFloat = hasMobileActions && mobileSlot.getBoundingClientRect().top <= 8;
  document.body.classList.toggle("has-mobile-actions", hasMobileActions);
  document.body.classList.toggle("actions-floating", shouldFloat);
}
function visibleTables(tables) {
  return tables.filter(name => {
    const value = `${name}`.toLocaleLowerCase("tr");
    if (value.startsWith("rpc")) return false;
    if (value.includes("rprcls")) return false;
    if (value.includes("auto_enable")) return false;
    if (value.includes("graphql")) return false;
    return true;
  });
}
function tableOptions(tables) {
  const counts = new Map();
  tables.forEach(name => counts.set(tableTitle(name), (counts.get(tableTitle(name)) || 0) + 1));
  return tables.map(name => {
    const title = tableTitle(name);
    return { name, label: counts.get(title) > 1 ? `${title} (${name})` : title };
  });
}
function tableTitle(name) {
  return ({ sc23_license_machines: "Lisans Makineleri", sc23_license_events: "Lisans Olayları", site_events: "Site Olayları", sc23_terms_archive: "Şartname Arşivi", sc23_sartname_kabulleri: "Şartname Kabulleri", sc23_updates: "Güncellemeler", sc23_lisans_ozet: "Lisans Özeti", sc23_lisans_durumlari: "Lisans Durumları" })[name] || titleCase(name);
}
function first(row, ...keys) { return keys.map(key => row?.[key]).find(value => value !== null && value !== undefined && `${value}`.trim())?.toString() || ""; }
function truthy(value) { return value === true || value === 1 || value === "true"; }
function dateValue(value) { const date = Date.parse(value || ""); return Number.isNaN(date) ? 0 : date; }
function formatDate(value) { const date = dateValue(value); return date ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(date) : ""; }
function displayValue(value) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Evet" : "Hayır";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value)) return formatDate(value);
  return `${value}`;
}
function titleCase(value) { return value.replace(/^sc23_/, "").replaceAll("_", " ").replace(/\b\p{L}/gu, c => c.toLocaleUpperCase("tr")); }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value || ""; return div.innerHTML; }
function setStatus(value) { $("statusText").textContent = value; }
function updateOnlineState() { $("onlineState").textContent = navigator.onLine ? "Çevrimiçi" : "Çevrimdışı"; }
