import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY, HOSPITALS } from "./config.js";
import { formatEta, formatMiles } from "./eta.js";

const STALE_AFTER_S = 60;           // flag a unit if no update for 1 min
const HIDE_ARRIVED_AFTER_S = 300;   // keep "arrived" units visible for 5 min
const IGNORE_ENROUTE_AFTER_S = 3600; // drop units silent for an hour

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

// Which hospital this dashboard is for: ed.html?h=dominican
for (const h of HOSPITALS) $("hospital").add(new Option(h.name, h.id));
const wanted = new URLSearchParams(location.search).get("h");
const hospital = HOSPITALS.find((h) => h.id === wanted) || HOSPITALS[0];
$("hospital").value = hospital.id;
$("hospital").onchange = () => { location.search = `?h=${$("hospital").value}`; };

// Map (Leaflet + OpenStreetMap)
const map = L.map("map").setView([hospital.lat, hospital.lng], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);
L.circleMarker([hospital.lat, hospital.lng], { radius: 10, color: "#e53935", fillOpacity: 0.8 })
  .addTo(map)
  .bindTooltip(hospital.name);

const units = new Map();   // unit_id -> latest row from the database
const markers = new Map(); // unit_id -> map marker

function applyRow(row) {
  if (!row || !row.unit_id) return;
  if (row.hospital_id !== hospital.id) {
    // unit is going somewhere else (or diverted away) — drop it
    units.delete(row.unit_id);
    return;
  }
  units.set(row.unit_id, row);
}

async function loadInitial() {
  const since = new Date(Date.now() - IGNORE_ENROUTE_AFTER_S * 1000).toISOString();
  const { data, error } = await db
    .from("units")
    .select("*")
    .eq("hospital_id", hospital.id)
    .gte("updated_at", since);
  if (error) return setConn(`Error: ${error.message}`, false);
  data.forEach(applyRow);
  render();
}

// Live updates: Supabase pushes every insert/update on the units table
db.channel("units-feed")
  .on("postgres_changes", { event: "*", schema: "public", table: "units" }, (payload) => {
    applyRow(payload.new);
    render();
  })
  .subscribe((status) => {
    setConn(status === "SUBSCRIBED" ? "Live" : status, status === "SUBSCRIBED");
    if (status === "SUBSCRIBED") loadInitial(); // (re)load whenever we (re)connect
  });

function timing(row) {
  const ageS = (Date.now() - Date.parse(row.updated_at)) / 1000;
  const leftS = Math.max(0, (row.eta_seconds ?? 0) - ageS); // count down between updates
  return { ageS, leftS };
}

function render() {
  const rows = [...units.values()]
    .map((r) => ({ r, ...timing(r) }))
    .filter((x) =>
      x.r.status === "enroute" ? x.ageS < IGNORE_ENROUTE_AFTER_S : x.ageS < HIDE_ARRIVED_AFTER_S
    )
    .sort((a, b) => {
      if (a.r.status !== b.r.status) return a.r.status === "enroute" ? -1 : 1;
      return a.leftS - b.leftS;
    });

  // Update the list (built with textContent so unit names can't inject HTML)
  const list = $("list");
  list.replaceChildren();
  if (!rows.some((x) => x.r.status === "enroute")) {
    const empty = document.createElement("p");
    empty.className = "sub";
    empty.textContent = "No inbound units.";
    list.append(empty);
  }
  for (const { r, ageS, leftS } of rows) {
    const card = document.createElement("div");
    const stale = r.status === "enroute" && ageS > STALE_AFTER_S;
    card.className = `card ${r.status}${stale ? " stale" : ""}`;

    const name = document.createElement("div");
    name.className = "unit";
    name.textContent = r.unit_id;

    const eta = document.createElement("div");
    eta.className = "eta";
    eta.textContent = r.status === "arrived" ? "ARRIVED" : formatEta(leftS);

    const meta = document.createElement("div");
    meta.className = "sub";
    meta.textContent =
      r.status === "arrived"
        ? `${Math.round(ageS / 60)} min ago`
        : `${formatMiles(r.distance_m)} · updated ${Math.round(ageS)}s ago${stale ? " · NO SIGNAL?" : ""}`;

    card.append(name, eta, meta);
    list.append(card);
  }

  // Update map markers for units still en route
  const shown = new Set(rows.filter((x) => x.r.status === "enroute").map((x) => x.r.unit_id));
  for (const [id, m] of markers) {
    if (!shown.has(id)) { m.remove(); markers.delete(id); }
  }
  for (const { r } of rows) {
    if (!shown.has(r.unit_id) || r.lat == null) continue;
    const m = markers.get(r.unit_id);
    if (m) m.setLatLng([r.lat, r.lng]);
    else markers.set(
      r.unit_id,
      L.marker([r.lat, r.lng]).addTo(map).bindTooltip(r.unit_id, { permanent: true, direction: "top" })
    );
  }
}

function setConn(text, ok) {
  $("conn").textContent = text;
  $("conn").className = ok ? "ok" : "bad";
}

setInterval(render, 1000); // tick the countdowns every second
