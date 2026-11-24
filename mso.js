// MSO (shift supervisor) view: every unit of the MSO's agency, citywide.
// The database only returns this agency's units (row-level security). The MSO can
// set any of the agency's units in service / out of service / on a special event.

import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles, TRAUMA_LABELS, etaLeftSeconds, countUp, movementLine, arrivalLine } from "./eta.js";
import { createMap, addMarker, pin } from "./gmaps.js";
import { effectiveService, serviceText, setService, durationPicker, clock, timeLeft } from "./service.js";

const STALE_AFTER_S = 150;
const HIDE_ARRIVED_AFTER_S = 7200;
const IGNORE_ENROUTE_AFTER_S = 3600;
const RELOAD_EVERY_MS = 30000;
const CITY_CENTER = { lat: 47.6062, lng: -122.3321 }; // Seattle
const MSO_ETA_REFRESH_MS = 60000; // refresh the MSO's own ETA while a unit is selected
const SHIFT_WINDOW_H = 24;        // in-service units silent longer than this are dropped
const IDLE_STALE_S = 6 * 60;      // available unit hasn't checked in for 3 missed check-ins

const $ = (id) => document.getElementById(id);

// ---- Sign in ----
const account = await signIn("mso");
$("title").textContent = `MSO · ${account.agency_id}`;
$("board").hidden = false;
$("signout").hidden = false;
$("signout").onclick = signOut;

const { data: hospitalRows } = await db.from("hospitals").select("*").order("name");
const hospitals = new Map((hospitalRows ?? []).map((h) => [h.id, h]));

// ---- Map: all hospitals + all active units ----
const map = await createMap($("map"), CITY_CENTER, 12);
const hospMarkers = new Map(); // hospital_id -> { marker, el }
const unitMarkers = new Map(); // unit_id -> marker
const lines = new Map();       // unit_id -> { line, key } line to destination

if (map) {
  for (const h of hospitals.values()) {
    const el = pin(h.name, "hosp");
    hospMarkers.set(h.id, { marker: addMarker(map, { lat: h.lat, lng: h.lng }, el, h.name), el });
  }
}

// ---- Data ----
let units = new Map();
let agencyUnitIds = []; // every rig unit in this agency, reporting or not

// Selected unit (MSO's own ETA panel)
let selectedId = null;
let selTimer = null;
let selBusy = false;
let youMarker = null;
let selLine = null;


async function loadAll() {
  const [u, a] = await Promise.all([
    db.from("units").select("*"),   // row-level security: this agency's units only
    db.rpc("agency_units"),
  ]);
  if (u.error) return setConn(`Error: ${u.error.message}`, false);
  units = new Map(u.data.map((r) => [r.unit_id, r]));
  if (!a.error) agencyUnitIds = a.data.map((x) => x.unit_id);
  render();
}

db.channel("mso-feed")
  .on("postgres_changes", { event: "*", schema: "public", table: "units" }, (payload) => {
    if (payload.new?.unit_id) units.set(payload.new.unit_id, payload.new);
    render();
  })
  .subscribe((status) => {
    setConn(status === "SUBSCRIBED" ? "Live" : status, status === "SUBSCRIBED");
    if (status === "SUBSCRIBED") loadAll();
  });
setInterval(loadAll, RELOAD_EVERY_MS);

function timing(r) {
  const ageS = (Date.now() - Date.parse(r.updated_at)) / 1000;
  return { ageS, leftS: etaLeftSeconds(r) };
}

const secondsSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : Infinity);

// What the MSO should show this unit as, or null if it's not on the board
function category(r, ageS) {
  if (r.status === "enroute" && ageS < IGNORE_ENROUTE_AFTER_S) return r.phase === "onscene" ? "onscene" : "transporting";
  if (r.status === "arrived" && ageS < HIDE_ARRIVED_AFTER_S) return "arrived";
  const st = effectiveService(r);
  if (st === "special_event") return "special";
  const recent = Math.min(secondsSince(r.last_seen_at), secondsSince(r.service_changed_at)) < SHIFT_WINDOW_H * 3600;
  if (st === "in_service" && recent) return "available";
  return null;
}
const ORDER = { transporting: 0, onscene: 1, arrived: 2, special: 3, available: 4 };

function activeRows() {
  return [...units.values()]
    .map((r) => { const t = timing(r); return { r, ...t, cat: category(r, t.ageS) }; })
    .filter((x) => x.cat)
    .sort((a, b) => {
      if (ORDER[a.cat] !== ORDER[b.cat]) return ORDER[a.cat] - ORDER[b.cat];
      if (a.cat === "available" || a.cat === "special") return byUnit(a.r.unit_id, b.r.unit_id);
      return a.leftS - b.leftS;
    });
}
const byUnit = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Every other unit in the agency: out of service, or not in service today
function notInServiceUnits(rows) {
  const active = new Set(rows.map((x) => x.r.unit_id));
  const ids = new Set([...agencyUnitIds, ...units.keys()]);
  return [...ids].filter((id) => !active.has(id)).sort(byUnit);
}

// The unit's row, or a placeholder for a unit that has never reported
const getUnit = (id) => units.get(id) ?? { unit_id: id };
const agoText = (sec) => sec < 90 ? `${Math.round(sec)}s ago` : sec < 5400 ? `${Math.round(sec / 60)} min ago`
  : `${Math.round(sec / 3600)} h ago`;

const hospName = (id) => hospitals.get(id)?.name ?? id;

// ---- Rendering ----
const cardEls = new Map(); // unit_id -> { card, eta, phase, meta }

function render() {
  const rows = activeRows();
  if (selectedId) updateSelInfo();
  renderSummary(rows);

  const list = $("units");
  list.replaceChildren();
  cardEls.clear();
  if (!rows.length) list.append(el("p", "sub", "No units in service."));

  for (const { r, cat } of rows) {
    const idle = cat === "available" || cat === "special";
    const trauma = !idle && r.trauma_level;
    const card = el("div", `card ${idle ? cat : r.status}${trauma ? ` trauma-${r.trauma_level}` : ""} clickable`);
    const top = el("div", "cardtop");
    top.append(el("div", "unit", r.unit_id));
    if (trauma) top.append(el("span", `badge ${r.trauma_level}`, TRAUMA_LABELS[r.trauma_level]));
    if (r.shadow) top.append(el("span", "badge shadow", "SHADOW"));
    const eta = el("div", "eta");
    const phase = el("div", "phase");
    const meta = el("div", "sub");
    if (idle) card.append(top, eta, phase, meta);
    else card.append(top, el("div", "dest", `→ ${hospName(r.hospital_id)}`), eta, phase, meta);
    card.classList.toggle("selected", r.unit_id === selectedId);
    card.onclick = () => selectUnit(r.unit_id, true);
    list.append(card);
    cardEls.set(r.unit_id, { card, eta, phase, meta });
  }
  // Everyone else in the agency (tap to put in service / special event)
  const others = notInServiceUnits(rows);
  if (others.length) {
    const box = el("div", "oos");
    box.append(el("div", "sub oos-title", `Out of service / not in service (${others.length})`));
    for (const id of others) {
      const r = getUnit(id);
      const why = effectiveService(r) === "out_of_service" && r.out_of_service_at
        ? `out of service since ${clock(r.out_of_service_at)}${r.service_changed_by && r.service_changed_by !== id ? ` (by ${r.service_changed_by})` : ""}`
        : "not in service today";
      const line = el("div", `oosline clickable${id === selectedId ? " selected" : ""}`);
      line.append(el("strong", null, id), el("span", "sub", ` · ${why}`));
      line.onclick = () => selectUnit(id, true);
      box.append(line);
    }
    list.append(box);
  }

  tick();
  renderMap(rows);
}

function renderSummary(rows) {
  const box = $("summary");
  box.replaceChildren();
  const enroute = rows.filter((x) => x.cat === "transporting" || x.cat === "onscene");
  const n = (c) => rows.filter((x) => x.cat === c).length;
  box.append(el("div", "sumline", `${rows.length} in service`));
  box.append(el("div", "sub sumcounts",
    `${n("available")} available · ${n("onscene")} on scene · ` +
    `${n("transporting")} transporting · ${n("arrived")} at hospital` +
    (n("special") ? ` · ${n("special")} special event` : "")));

  for (const h of hospitals.values()) {
    const inbound = enroute.filter((x) => x.r.hospital_id === h.id);
    const atHosp = rows.filter((x) => x.cat === "arrived" && x.r.hospital_id === h.id);
    if (!inbound.length && !atHosp.length) continue;
    const next = inbound.filter((x) => x.r.phase !== "onscene").sort((a, b) => a.leftS - b.leftS)[0];
    const line = el("div", "hospline");
    line.append(el("strong", null, h.name));
    line.append(el("span", "sub",
      ` ${inbound.length} inbound · ${atHosp.length} at hospital` +
      (next ? ` · next ${next.r.unit_id} ${formatEta(next.leftS)}` : "")));
    box.append(line);
  }

  // Hospital map labels show the inbound count
  for (const [id, { el: label }] of hospMarkers) {
    const n = enroute.filter((x) => x.r.hospital_id === id).length;
    label.textContent = n ? `${hospName(id)} · ${n} inbound` : hospName(id);
  }
}

function tick() {
  for (const [id, { card, eta, phase, meta }] of cardEls) {
    const r = units.get(id);
    if (!r) continue;
    const { ageS, leftS } = timing(r);
    const cat = category(r, ageS);
    if (cat === "special") {
      const seen = secondsSince(r.last_seen_at);
      eta.textContent = "Special event";
      phase.textContent = `UNTIL ${clock(r.special_event_until)} · ${timeLeft(r.special_event_until)} left`;
      phase.className = "phase special";
      meta.textContent =
        (r.service_changed_by ? `Set by ${r.service_changed_by} · ` : "") +
        (r.last_seen_at ? `last seen ${agoText(seen)}` : "no location yet");
      continue;
    }
    if (cat === "available") {
      const seen = secondsSince(r.last_seen_at);
      const quiet = seen > IDLE_STALE_S;
      card.classList.toggle("stale", quiet);
      eta.textContent = "Available";
      phase.textContent = "IN SERVICE";
      phase.className = "phase available";
      meta.textContent =
        (r.in_service_since ? `In service since ${clock(r.in_service_since)} · ` : "") +
        (r.last_seen_at ? `last seen ${agoText(seen)}${quiet ? " · NO SIGNAL?" : ""}` : "no location yet");
      continue;
    }
    const radioOnly = r.eta_source === "radio" && !r.transport_id;
    const stale = r.status === "enroute" && !radioOnly && ageS > STALE_AFTER_S;
    card.classList.toggle("stopped-care", r.status === "enroute" && r.motion_state === "stopped_care");
    card.classList.toggle("stale", stale);

    if (r.status === "arrived") {
      eta.textContent = "ARRIVED";
      const a = arrivalLine(r);
      phase.textContent = a.text;
      phase.className = a.cls;
      meta.textContent = "";
      continue;
    }
    const onScene = r.phase === "onscene";
    const line = movementLine(r);
    eta.textContent = onScene ? "On scene" : r.eta_seconds == null ? "ETA ?" : formatEta(leftS);
    phase.textContent = onScene ? `${line.text} · ${formatEta(leftS)} away` : line.text;
    phase.className = line.cls;
    const ls = r.driving_mode === "ls" || (r.driving_mode !== "normal" && r.default_mode === "ls");
    const modeText = onScene ? "" : r.driving_mode === "ls" ? " · lights & sirens"
      : r.driving_mode === "normal" ? " · no lights & sirens"
      : ls ? " · lights & sirens (assumed)" : "";
    meta.textContent =
      `${formatMiles(r.distance_m)}${modeText} · updated ${Math.round(ageS)}s ago` +
      `${r.eta_source === "estimate" ? " · rough estimate" : ""}` +
      `${stale ? " · NO SIGNAL?" : ""}`;
  }
}
setInterval(tick, 1000);
setInterval(render, 15000);

function renderMap(rows) {
  if (!map) return;
  const shown = rows.filter((x) => x.r.lat != null).map((x) => x.r);
  const ids = new Set(shown.map((r) => r.unit_id));
  for (const [id, m] of unitMarkers) if (!ids.has(id)) { m.map = null; unitMarkers.delete(id); }
  for (const [id, l] of lines) if (!ids.has(id)) { l.line.setMap(null); lines.delete(id); }

  for (const r of shown) {
    const pos = { lat: r.lat, lng: r.lng };
    const state = category(r, timing(r).ageS) ?? "available";
    const idle = state === "available" || state === "special";
    const cls = `unit ${state}${!idle && r.trauma_level ? ` ${r.trauma_level}` : ""}`;
    const selCls = r.unit_id === selectedId ? " selected" : "";
    const m = unitMarkers.get(r.unit_id);
    if (m) { m.position = pos; m.content.className = `pin ${cls}${selCls}`; }
    else {
      const marker = addMarker(map, pos, pin(r.unit_id, `${cls}${selCls}`), r.unit_id);
      marker.addListener("click", () => selectUnit(r.unit_id, false));
      unitMarkers.set(r.unit_id, marker);
    }

    // Line from an en-route unit to its destination: the road route when we have it,
    // otherwise a dashed straight line
    const h = hospitals.get(r.hospital_id);
    const old = lines.get(r.unit_id);
    if (r.status !== "enroute" || idle || !h) {
      if (old) { old.line.setMap(null); lines.delete(r.unit_id); }
      continue;
    }
    const color = r.trauma_level === "full" ? "#e53935" : r.trauma_level === "modified" ? "#ef6c00"
      : state === "onscene" ? "#f9a825" : "#64b5f6";
    // Only redraw when the route or color changes (avoids flicker)
    const key = `${r.route_polyline ?? `${r.lat},${r.lng}`}|${color}`;
    if (old?.key === key) continue;
    if (old) old.line.setMap(null);
    lines.set(r.unit_id, { line: routeLine(r.route_polyline, [pos, { lat: h.lat, lng: h.lng }], color, 4), key });
  }
}

// Solid line along the encoded road route, or a dashed straight line as a fallback
function routeLine(encoded, fallbackPath, color, weight) {
  let path = null;
  try {
    if (encoded) path = google.maps.geometry.encoding.decodePath(encoded);
  } catch (e) { console.warn("Couldn't decode route", e); }
  if (path?.length) {
    return new google.maps.Polyline({ map, path, strokeColor: color, strokeOpacity: 0.85, strokeWeight: weight });
  }
  return new google.maps.Polyline({ map, path: fallbackPath, strokeOpacity: 0, icons: dashes(color) });
}

function dashes(color) {
  return [{
    icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: color, scale: 3 },
    offset: "0",
    repeat: "14px",
  }];
}

// ---- Selected unit: status controls + the MSO's own ETA to it ----

function selectUnit(unitId, pan) {
  const r = getUnit(unitId);
  selectedId = unitId;
  if (pan && map && r.lat != null) { map.panTo({ lat: r.lat, lng: r.lng }); map.setZoom(14); }
  $("sel").hidden = false;
  $("sel-unit").textContent = r.unit_id;
  $("sel-normal").textContent = "--";
  $("sel-ls").textContent = "--";
  $("sel-picker").hidden = true;
  if (selLine) { selLine.setMap(null); selLine = null; }
  updateSelInfo();
  render();
  clearInterval(selTimer);
  selTimer = null;
  if (r.lat != null) {
    selTimer = setInterval(refreshMsoEta, MSO_ETA_REFRESH_MS);
    refreshMsoEta();
  }
}

// Status buttons in the panel
for (const b of document.querySelectorAll("[data-svc]")) {
  b.onclick = () => {
    if (b.dataset.svc === "special_event") { $("sel-picker").hidden = !$("sel-picker").hidden; return; }
    changeSelService(b.dataset.svc);
  };
}
$("sel-picker").append(durationPicker((minutes) => changeSelService("special_event", minutes)));

async function changeSelService(status, minutes = null) {
  const unitId = selectedId;
  if (!unitId) return;
  $("sel-picker").hidden = true;
  $("sel-svc-msg").textContent = "Saving…";
  const err = await setService(unitId, status, minutes);
  $("sel-svc-msg").textContent = err ? `Couldn't change status: ${err}` : "";
  loadAll();
}

function closeSel() {
  selectedId = null;
  clearInterval(selTimer);
  selTimer = null;
  $("sel").hidden = true;
  if (selLine) { selLine.setMap(null); selLine = null; }
  if (youMarker) { youMarker.map = null; youMarker = null; }
  render();
}
$("sel-close").onclick = closeSel;
$("sel-refresh").onclick = () => refreshMsoEta();

function updateSelInfo() {
  const r = getUnit(selectedId);
  const cat = r.updated_at ? category(r, timing(r).ageS) : null;
  const st = effectiveService(r);
  $("sel-svc-text").textContent =
    `Status: ${serviceText(r)}` +
    (r.service_changed_by && r.service_changed_at ? ` · set by ${r.service_changed_by} at ${clock(r.service_changed_at)}` : "");
  for (const b of document.querySelectorAll("[data-svc]")) b.classList.toggle("current", b.dataset.svc === st);
  document.querySelector('[data-svc="special_event"]').textContent =
    st === "special_event" ? "Change special event" : "Special event";
  $("sel-eta").hidden = r.lat == null;
  const where = !cat ? (st === "out_of_service" ? "out of service" : "not in service")
    : cat === "available" ? "available"
    : cat === "special" ? "on a special event"
    : r.status === "arrived" ? `at ${hospName(r.hospital_id)}`
    : r.phase === "onscene" ? `on scene, going to ${hospName(r.hospital_id)}`
    : `transporting to ${hospName(r.hospital_id)}`;
  $("sel-info").textContent = where;
  $("sel-label").textContent = cat === "transporting"
    ? "Your ETA to its current position (unit is moving)"
    : "Your ETA to this unit";
}

async function refreshMsoEta() {
  const unitId = selectedId;
  if (!unitId || selBusy) return;
  selBusy = true;
  $("sel-status").textContent = "Getting your location…";
  try {
    const fix = await myPosition();
    if (selectedId !== unitId) return;
    $("sel-status").textContent = "Calculating…";
    const { data, error } = await db.functions.invoke("eta", {
      body: { action: "mso_eta", unit_id: unitId, lat: fix.coords.latitude, lng: fix.coords.longitude },
    });
    if (selectedId !== unitId) return;
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch {}
      $("sel-status").textContent = `Couldn't get ETA: ${msg}`;
      return;
    }
    $("sel-normal").textContent = formatEta(data.eta_google_seconds);
    $("sel-ls").textContent = formatEta(data.eta_ls_seconds);
    const saved = Math.round((data.eta_google_seconds - data.eta_ls_seconds) / 60);
    $("sel-status").textContent =
      `${formatMiles(data.distance_m)}` +
      (saved >= 1 ? ` · lights & sirens ≈ ${saved} min faster` : "") +
      ` · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` +
      (data.eta_source === "estimate" ? " · rough estimate" : "");
    updateSelInfo();
    drawMsoRoute(fix, data);
  } catch (e) {
    $("sel-status").textContent = e.code === 1
      ? "Location is blocked for this page. Allow location access to see your ETA."
      : `Couldn't get your location: ${e.message}`;
  } finally {
    selBusy = false;
  }
}

function myPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This browser can't share location."));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, maximumAge: 30000, timeout: 20000,
    });
  });
}

function drawMsoRoute(fix, data) {
  if (!map) return;
  const me = { lat: fix.coords.latitude, lng: fix.coords.longitude };
  if (youMarker) youMarker.position = me;
  else youMarker = addMarker(map, me, pin("You", "you"), "You");
  if (selLine) selLine.setMap(null);
  selLine = routeLine(data.route_polyline, [me, { lat: data.unit_lat, lng: data.unit_lng }], "#ffffff", 5);
}


function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function setConn(text, ok) {
  $("conn").textContent = text;
  $("conn").className = ok ? "ok" : "bad";
}
