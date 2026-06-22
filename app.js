const state = { session: "", projectRef: "", rows: [], selected: null, deferredInstall: null, termsArchive: {} };
let placementFrame = 0;
const $ = id => document.getElementById(id);
const API_BASE = "https://llarwagbefhnrpnmrvfu.supabase.co/functions/v1/sc23-lisans-web/";

const labels = {
  __runtime_status: "Durum", __runtime_status_detail: "Durum Açıklaması",
  id: "Kayıt ID", product: "Ürün", machine_code: "Makine Kodu", customer_name: "Ad Soyad",
  customer_email: "E-posta", computer_name: "Bilgisayar Adı", user_name: "Kullanıcı Adı",
  ip_address: "IP Adresi", city: "Şehir", region: "Bölge", country: "Ülke",
  created_at: "Oluşturulma Tarihi", first_seen_at: "İlk Görülme", last_seen_at: "Son Görülme",
  expires_at: "Lisans Bitişi", licensed: "Lisanslı", revoked: "Pasif", is_admin: "Admin",
  accepted_terms_text: "Kabul Edilen Metin", accepted_terms_hash: "Şartname Hash",
  install_accepted_at: "Kabul Tarihi", terms_version: "Şartname Sürümü", event_type: "Olay Türü",
  event: "Olay", payload: "İşlem Bilgisi", version: "Sürüm", app_version: "Uygulama Sürümü",
  last_license_check_app_version: "Son Kontrol Sürümü", os_version: "İşletim Sistemi",
  client_version: "İstemci Sürümü", program_version: "Program Sürümü", title: "Başlık", hash: "Hash"
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  $("loginForm").addEventListener("submit", unlock);
  $("projectsButton").addEventListener("click", loadProjects);
  $("refreshButton").addEventListener("click", loadRows);
  $("projectSelect").addEventListener("change", selectProject);
  $("tableSelect").addEventListener("change", loadRows);
  $("searchInput").addEventListener("input", renderRows);
  $("recordPdfButton").addEventListener("click", exportPdf);
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
  window.addEventListener("resize", scheduleActionPlacement);
  window.addEventListener("load", () => setTimeout(scheduleActionPlacement, 120));
  updateOnlineState();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  scheduleActionPlacement();
  if (!window.matchMedia("(max-width: 620px), (pointer: coarse)").matches) {
    $("passwordInput").focus();
  }
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
    const shownTables = visibleTables(withVirtualTables(tables));
    const options = tableOptions(shownTables);
    options.forEach(item => select.add(new Option(item.label, item.name)));
    const preferred = options.find(item => isLicenseManagementTable(item.name)) || options.find(item => isLicenseTable(item.name)) || options[0];
    if (preferred) select.value = preferred.name;
    if (shownTables.length) await loadRows();
  });
}

async function loadRows() {
  const table = $("tableSelect").value;
  if (!table || !state.projectRef) return;
  await busy("Kayıtlar yenileniyor...", async () => {
    const apiTable = queryTableName(table);
    const rows = await request(`api/rows?projectRef=${encodeURIComponent(state.projectRef)}&table=${encodeURIComponent(apiTable)}`);
    state.rows = isTermsAcceptanceTable(table) ? rows.filter(isTermsAcceptanceRow) : rows;
    state.selected = null;
    $("detailContent").className = "detail-empty";
    $("detailContent").textContent = "Detayları görmek için bir kayıt seçin.";
    $("licenseActions").hidden = true;
    $("recordActions").hidden = true;
    scheduleActionPlacement();
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

async function selectRow(row) {
  state.selected = row;
  if (isTermsAcceptanceTable($("tableSelect").value) || isTermsAcceptanceRow(row)) {
    await ensureTermsAcceptedText(row);
  }
  renderRows();
  const content = $("detailContent");
  content.className = "";
  const dl = document.createElement("dl");
  dl.className = "detail-fields";
  const isLicenseMachine = isLicenseTable($("tableSelect").value);
  if (isLicenseMachine) {
    appendDetailField(dl, labels.__runtime_status, runtimeStatus(row));
    appendDetailField(dl, labels.__runtime_status_detail, runtimeStatusDetail(row));
  }
  const preferred = isTermsAcceptanceTable($("tableSelect").value) || isTermsAcceptanceRow(row)
    ? termsAcceptanceKeys()
    : ["customer_name", "customer_email", "machine_code", "computer_name", "user_name", "product", "app_version", "last_license_check_app_version", "os_version", "version", "client_version", "program_version", "ip_address", "city", "region", "country", "created_at", "first_seen_at", "last_seen_at", "expires_at", "install_accepted_at", "terms_version", "accepted_terms_hash", "accepted_terms_text"];
  const keys = [...new Set([...preferred.filter(key => key in row), ...Object.keys(row)])];
  keys.forEach(key => appendDetailField(dl, labels[key] || titleCase(key), displayValue(row[key])));
  content.replaceChildren(dl);
  $("licenseActions").hidden = !isLicenseTable($("tableSelect").value);
  $("recordActions").hidden = false;
  scheduleActionPlacement();
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

async function exportPdf() {
  if (!state.selected) return showMessage("PDF", "Önce bir kayıt seçin.");
  const table = $("tableSelect").value;
  const isTermsReport = isTermsAcceptanceTable(table) || isTermsAcceptanceRow(state.selected);
  if (isTermsReport) await ensureTermsAcceptedText(state.selected);
  const title = isTermsReport ? "Şartname Kabul Raporu" : `${tableTitle(table)} Raporu`;
  const fileTitle = `${first(state.selected, "customer_name", "user_name", "computer_name", "machine_code") || "SC23_Kayit"}_SC23_Rapor`;
  const reportRows = cleanPdfRows(isTermsReport ? termsAcceptanceReportRows(state.selected) : genericReportRows(state.selected));
  const rows = reportRows.length
    ? reportRows.map(item => `<tr><th>${escapeHtml(item.label)}</th><td>${escapeHtml(item.value)}</td></tr>`).join("")
    : `<tr><th>Bilgi</th><td>Bu kayıtta PDF'e aktarılacak dolu bilgi bulunamadı.</td></tr>`;
  const popup = window.open("", "_blank", "width=900,height=1100");
  if (!popup) {
    showMessage("PDF", "Tarayıcı yeni pencereyi engelledi. Açılır pencereye izin verip tekrar deneyin.");
    return;
  }
  popup.document.open();
  popup.document.write(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(fileTitle)}</title><style>
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #0f172a; font-family: Arial, "Segoe UI", sans-serif; font-size: 12px; line-height: 1.42; }
    header { border-bottom: 2px solid #0f766e; padding-bottom: 12px; margin-bottom: 16px; }
    h1 { margin: 0 0 5px; font-size: 22px; }
    .meta { color: #64748b; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
    tr { page-break-inside: avoid; }
    th, td { vertical-align: top; text-align: left; border-bottom: 1px solid #e2e8f0; padding: 8px 7px; }
    th { width: 34%; color: #475569; font-weight: 700; background: #f8fafc; }
    td { white-space: pre-wrap; overflow-wrap: anywhere; }
    @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  </style></head><body><header><h1>${escapeHtml(title)}</h1><div class="meta">SC23 Lisans Kontrol - ${escapeHtml(new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date()))}</div></header><table>${rows}</table><script>window.onload=()=>{document.title=${JSON.stringify(fileTitle)};setTimeout(()=>window.print(),120)};<\/script></body></html>`);
  popup.document.close();
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
  if (truthy(first(row, "revoked", "is_revoked", "disabled", "is_disabled", "passive", "is_passive"))) return "Pasif";
  if (truthy(first(row, "is_admin", "admin"))) return "Admin";
  const expiresAt = first(row, "expires_at", "license_expires_at", "valid_until", "expiry_date", "expires");
  if (expiresAt && dateValue(expiresAt) < Date.now()) return "Süresi Dolan";
  if (truthy(first(row, "licensed", "is_licensed", "active", "is_active", "license_active"))) return "Aktif";
  if (row.first_seen_at && dateValue(row.first_seen_at) + 3 * 86400000 > Date.now()) return "Deneme";
  return "Bekleyen";
}
function runtimeStatusDetail(row) {
  const lastCheck = first(row, "last_license_check_at");
  const control = lastCheck
    ? `AutoCAD kontrol var - Son kontrol: ${formatDate(lastCheck)}`
    : "AutoCAD kontrol yok";
  const description = ({
    Admin: "Admin lisansı",
    Aktif: "Aktif lisans",
    Deneme: "3 günlük deneme",
    Bekleyen: "Onay bekliyor",
    "Süresi Dolan": "Lisans süresi dolmuş",
    Pasif: "Pasif / iptal edilmiş"
  })[runtimeStatus(row)] || runtimeStatus(row);
  return `${description} - ${control}`;
}
function appendDetailField(host, label, value) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value;
  host.append(dt, dd);
}
function statusRank(status) { return ["Admin", "Aktif", "Deneme", "Bekleyen", "Süresi Dolan", "Pasif"].indexOf(status); }
function statusClass(status) { return ({ Admin: "admin", Aktif: "active", Deneme: "trial", Bekleyen: "pending", "Süresi Dolan": "expired", Pasif: "revoked" })[status] || ""; }
function scheduleActionPlacement() {
  if (placementFrame) return;
  placementFrame = requestAnimationFrame(() => {
    placementFrame = 0;
    syncActionPlacement();
  });
}
function syncActionPlacement() {
  if ($("appView")?.hidden) return;
  const actions = $("licenseActions");
  const mobileSlot = $("mobileActionSlot");
  const recordActions = $("recordActions");
  const detailPanel = $("detailPanel");
  if (!actions || !recordActions || !mobileSlot || !detailPanel) return;
  const isMobile = window.matchMedia("(max-width: 620px)").matches;
  const target = isMobile ? mobileSlot : detailPanel;
  if (actions.parentElement !== target) target.append(actions);
  if (recordActions.parentElement !== target) target.append(recordActions);
  if (isMobile && recordActions.previousElementSibling !== actions) target.append(recordActions);
  const hasMobileActions = isMobile && (!actions.hidden || !recordActions.hidden);
  document.body.classList.toggle("has-mobile-actions", hasMobileActions);
  document.body.classList.remove("actions-floating");
}
function withVirtualTables(tables) {
  const result = [...new Set(tables)];
  if (result.includes("sc23_license_machines") && !result.includes("sc23_sartname_kabulleri")) {
    const index = result.indexOf("sc23_license_machines");
    result.splice(index + 1, 0, "sc23_sartname_kabulleri");
  }
  return result;
}
function queryTableName(table) {
  return isTermsAcceptanceTable(table) ? "sc23_license_machines" : table;
}
function isTermsAcceptanceTable(table) {
  const value = `${table}`.toLocaleLowerCase("tr");
  return value.includes("sartname_kabul") || value.includes("şartname_kabul") || value.includes("terms_accept");
}
function isTermsAcceptanceRow(row) {
  return !!firstDeep(row,
    "install_accepted_at", "accepted_at", "kabul_tarihi", "sartlari_kabul_tarihi",
    "terms_hash", "accepted_terms_hash", "acceptedTermsHash", "sartname_hash"
  );
}
function isLicenseTable(table) {
  const value = `${table}`.toLocaleLowerCase("tr");
  if (["event", "history", "log", "status", "summary", "archive", "terms", "sartname", "şartname", "kabul", "accept", "update", "guncelle", "güncelle"]
    .some(part => value.includes(part))) return false;
  return value.includes("license_machine")
    || value.includes("license_device")
    || isLicenseManagementTable(value)
    || (value.includes("license") && value.includes("management"))
    || (value.includes("lisans") && (value.includes("yonetim") || value.includes("yönetim")))
    || value.includes("lisans_makine")
    || value.includes("lisans_cihaz")
    || ["device", "devices", "machine", "machines", "cihaz", "cihazlar", "makine", "makineler", "license", "licenses", "lisans", "lisanslar"].includes(value)
    || ["_devices", "_machines", "_cihazlar", "_makineler"].some(suffix => value.endsWith(suffix));
}
function isLicenseManagementTable(table) {
  const value = `${table}`.toLocaleLowerCase("tr");
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return (normalized.includes("lisans") && (normalized.includes("yonetim") || value.includes("yÃ¶netim") || value.includes("yönetim")))
    || (normalized.includes("license") && normalized.includes("management"));
}
function termsAcceptanceKeys() {
  return [
    "install_accepted_at", "accepted_at", "kabul_tarihi", "first_seen_at", "created_at",
    "last_license_check_at", "last_seen_at", "product", "customer_name", "full_name", "name",
    "customer_email", "email", "machine_code", "computer_name", "user_name", "ip_address", "ip",
    "city", "sehir", "region", "country", "country_code", "timezone", "latitude", "longitude",
    "terms_version", "accepted_terms_version", "version", "terms_hash", "accepted_terms_hash",
    "hash", "accepted_terms_text", "accepted_text", "terms_text", "content", "body", "text", "id"
  ];
}
function termsAcceptanceReportRows(row) {
  const fields = [
    ["Kabul Tarihi", firstDeep(row, "kabul_tarihi", "install_accepted_at", "accepted_at", "sartlari_kabul_tarihi", "created_at")],
    ["Kurulum Tarihi", firstDeep(row, "first_seen_at", "created_at", "kurulum_tarihi")],
    ["Son Lisans Kontrolü", firstDeep(row, "last_license_check_at", "last_seen_at", "son_lisans_kontrol_tarihi")],
    ["Ürün", firstDeep(row, "product", "urun")],
    ["Ad Soyad", firstDeep(row, "customer_name", "customerName", "full_name", "name", "kullanici_adi", "musteri", "ad_soyad")],
    ["E-posta", firstDeep(row, "customer_email", "customerEmail", "email", "e_posta", "eposta")],
    ["Makine Kodu", firstDeep(row, "machine_code", "makine_kodu")],
    ["Bilgisayar Adı", firstDeep(row, "computer_name", "computerName", "bilgisayar_adi", "bilgisayar")],
    ["Windows Kullanıcısı", firstDeep(row, "user_name", "userName", "windows_kullanicisi", "kullanici")],
    ["IP Adresi", firstDeep(row, "ip_address", "ipAddress", "ip", "ip_adresi")],
    ["Şehir / İl", firstDeep(row, "city", "sehir", "il")],
    ["Bölge", firstDeep(row, "region", "bolge")],
    ["Ülke", firstDeep(row, "country", "ulke")],
    ["Ülke Kodu", firstDeep(row, "country_code", "countryCode", "ulke_kodu")],
    ["Saat Dilimi", firstDeep(row, "timezone", "saat_dilimi")],
    ["Enlem", firstDeep(row, "latitude", "enlem")],
    ["Boylam", firstDeep(row, "longitude", "boylam")],
    ["Şartname Versiyonu", firstDeep(row, "terms_version", "accepted_terms_version", "acceptedTermsVersion", "version", "sartname_versiyonu")],
    ["Şartname Hash", firstDeep(row, "terms_hash", "accepted_terms_hash", "acceptedTermsHash", "hash", "sartname_hash")],
    ["Kabul Edilen Metin", termsAcceptedText(row)],
    ["Olay ID", firstDeep(row, "olay_id", "event_id", "id")]
  ];
  const used = new Set();
  fields.forEach(([label]) => used.add(label));
  const rows = fields.filter(([, value]) => `${value || ""}`.trim()).map(([label, value]) => ({ label, value: displayValue(value) }));
  genericReportRows(row).forEach(item => {
    if (!used.has(item.label) && item.value !== "-" && item.value.length < 900) rows.push(item);
  });
  return rows;
}
function genericReportRows(row) {
  return Object.keys(row).map(key => ({ label: labels[key] || titleCase(key), value: displayValue(row[key]) }));
}
function cleanPdfRows(rows) {
  return rows.filter(item => {
    const value = `${item.value || ""}`.trim();
    return value && value !== "-" && value !== "{}" && value !== "[]";
  });
}
function termsAcceptedText(row) {
  return firstDeep(row,
    "kabul_edilen_tam_metin", "accepted_terms_text", "accepted_text", "acceptedText",
    "terms_text", "sartname_tam_metni", "content", "body", "text"
  );
}
function firstDeep(row, ...keys) {
  const direct = first(row, ...keys);
  if (direct) return direct;
  const payload = payloadObject(row);
  return payload ? first(payload, ...keys) : "";
}
function payloadObject(row) {
  const payload = row?.payload;
  if (!payload) return null;
  if (typeof payload === "object") return payload;
  try { return JSON.parse(payload); } catch { return null; }
}
async function ensureTermsAcceptedText(row) {
  if (!row || termsAcceptedText(row)) return;
  const archive = await termsArchiveRows();
  if (!archive.length) return;
  const best = archive
    .map(item => ({ item, score: termsMatchScore(row, item) }))
    .filter(match => match.score > 0 && termsAcceptedText(match.item))
    .sort((a, b) => b.score - a.score || dateValue(b.item.created_at || b.item.updated_at) - dateValue(a.item.created_at || a.item.updated_at))[0]?.item;
  const source = best || archive.find(item => termsAcceptedText(item));
  const text = source ? termsAcceptedText(source) : "";
  if (text) {
    row.accepted_terms_text = text;
    row.terms_archive_source = first(source, "id", "terms_version", "version", "hash", "terms_hash") || "Şartname arşivi";
  }
}
async function termsArchiveRows() {
  const projectRef = state.projectRef;
  if (!projectRef) return [];
  if (state.termsArchive[projectRef]) return state.termsArchive[projectRef];
  const tables = ["sc23_terms_archive", "sc23_sartname_arsivi"];
  const rows = [];
  for (const table of tables) {
    try {
      const result = await request(`api/rows?projectRef=${encodeURIComponent(projectRef)}&table=${encodeURIComponent(table)}`);
      result.forEach(item => rows.push({ ...item, _archive_table: table }));
    } catch {
      // Some projects may not have both archive table names.
    }
  }
  state.termsArchive[projectRef] = rows;
  return rows;
}
function termsMatchScore(row, archiveRow) {
  const rowProduct = firstDeep(row, "product", "urun").toLocaleLowerCase("tr");
  const arcProduct = firstDeep(archiveRow, "product", "urun").toLocaleLowerCase("tr");
  const rowVersion = firstDeep(row, "terms_version", "accepted_terms_version", "acceptedTermsVersion", "version", "sartname_versiyonu");
  const arcVersion = firstDeep(archiveRow, "terms_version", "accepted_terms_version", "version", "sartname_versiyonu");
  const rowHash = firstDeep(row, "terms_hash", "accepted_terms_hash", "acceptedTermsHash", "hash", "sartname_hash");
  const arcHash = firstDeep(archiveRow, "terms_hash", "accepted_terms_hash", "hash", "sartname_hash");
  let score = 0;
  if (rowHash && arcHash && rowHash === arcHash) score += 100;
  if (rowVersion && arcVersion && rowVersion === arcVersion) score += 40;
  if (rowProduct && arcProduct && rowProduct === arcProduct) score += 20;
  if (!rowHash && !rowVersion && rowProduct && arcProduct === rowProduct) score += 5;
  return score;
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
  return [...tables]
    .sort((a, b) => tableRank(a) - tableRank(b) || tableTitle(a).localeCompare(tableTitle(b), "tr") || a.localeCompare(b))
    .map(name => ({ name, label: tableTitle(name) }));
}
function tableRank(name) {
  const value = `${name}`.toLocaleLowerCase("tr");
  if (isLicenseManagementTable(value)) return -10;
  if (isLicenseTable(value)) return 0;
  if (value.includes("event") || value.includes("olay")) return 1;
  if (isTermsAcceptanceTable(value)) return 2;
  if (value.includes("terms") || value.includes("sartname") || value.includes("şartname")) return 3;
  if (value.includes("update") || value.includes("guncelle") || value.includes("güncelle")) return 4;
  return 10;
}
function tableTitle(name) {
  const known = {
    sc23_license_machines: "Lisans Makineleri",
    sc23_license_events: "Lisans Olayları",
    site_events: "Site Olayları",
    sc23_terms_archive: "Şartname Metin Arşivi",
    sc23_sartname_kabulleri: "Şartname Kabul Kayıtları",
    sc23_updates: "Program Güncellemeleri",
    sc23_lisans_ozet: "Lisans Özeti",
    sc23_lisans_durumlari: "Lisans Durumları"
  };
  if (known[name]) return known[name];
  const value = `${name}`.toLocaleLowerCase("tr");
  if (value.includes("sartname") || value.includes("şartname") || value.includes("terms")) {
    if (value.includes("kabul") || value.includes("accept")) return "Şartname Kabul Kayıtları";
    if (value.includes("archive") || value.includes("arsiv") || value.includes("arşiv")) return "Şartname Metin Arşivi";
    return "Şartname Kayıtları";
  }
  if (value.includes("update") || value.includes("guncelle") || value.includes("güncelle")) {
    if (value.includes("event") || value.includes("log") || value.includes("history")) return "Güncelleme Olayları";
    if (value.includes("file") || value.includes("package") || value.includes("release")) return "Güncelleme Dosyaları";
    return "Program Güncellemeleri";
  }
  return titleCase(name);
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
