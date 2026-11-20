import { GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAP_ID } from "./config.js";
import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles } from "./eta.js";

const STALE_AFTER_S = 150;           // flag a unit after ~2 missed minute updates
const HIDE_ARRIVED_AFTER_S = 300;    // keep "arrived" units visible for 5 min
const IGNORE_ENROUTE_AFTER_S = 3600; // drop units silent for an hour
const RELOAD_EVERY_MS = 30000;       // full refresh (catches units that diverted away)

const $ = (id) => document.getElementById(id);

// ---- Sign in: the ED account decides which hospital this board shows ----
const account = await signIn("ed");
const { data: hospital, error: hErr } = await db
  .from("hospitals").select("*").eq("id", account.hospital_id).single();
if (hErr) throw new Error(`Couldn't load hospital: ${hErr.message}`);

$("hospname").textContent = hospital.name;
$("board").hidden = false;
$("signout").hidden = false;
$("signout").onclick = signOut;

// ---- Google map ----
let map = null;
const markers = new Map(); // unit_id -> AdvancedMarkerElement

try {
  await loadGoogleMaps();
  map = new google.maps.Map($("map"), {
    center: { lat: hospital.lat, lng: hospital.lng },
    zoom: 13,
    mapId: GOOGLE_MAP_ID,
    colorScheme: "DARK",
    streetViewControl: false,
    mapTypeControl: false,
  });
  new google.maps.TrafficLayer().setMap(map);
  new google.maps.marker.AdvancedMarkerElement({
    map,
    position: { lat: hospital.lat, lng: hospital.lng },
    content: pin(hospital.name, "hosp"),
    title: hospital.name,
  });
} catch (e) {
  console.error(e);
  $("map").textContent = "Map unavailable (check the Google Maps browser key in config.js).";
  $("map").className = "sub mapfail";
}

function loadGoogleMaps() {
  return new Promise((resolve, reject) => {
    window.__gmapsReady = resolve;
    window.gm_authFailure = () => reject(new Error("Google Maps key rejected"));
    const s = document.createElement("script");
    s.src =
      "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(GOOGLE_MAPS_BROWSER_KEY)}` +
      "&v=weekly&loading=async&libraries=marker&callback=__gmapsReady";
    s.async = true;
    s.onerror = () => reject(new Error("Couldn't load Google Maps"));
    document.head.append(s);
  });
}

function pin(text, cls) {
  const el = document.createElement("div");
  el.className = `pin ${cls}`;
  el.textContent = text;
  return el;
}

// ---- Data ----
let units = new Map(); // unit_id -> latest row

function applyRow(row) {
  if (!row || !row.unit_id) return;
  if (row.hospital_id !== hospital.id) units.delete(row.unit_id); // diverted away
  else units.set(row.unit_id, row);
}

// The database only returns units headed to this hospital (row-level security)
async function loadAll() {
  const since = new Date(Date.now() - IGNORE_ENROUTE_AFTER_S * 1000).toISOString();
  const { data, error } = await db
    .from("units")
    .select("*")
    .eq("hospital_id", hospital.id)
    .gte("updated_at", since);
  if (error) return setConn(`Error: ${error.message}`, false);
  units = new Map(data.map((r) => [r.unit_id, r]));
  render();
}

// Live updates: Supabase pushes changes this account is allowed to see
db.channel("units-feed")
  .on("postgres_changes", { event: "*", schema: "public", table: "units" }, (payload) => {
    applyRow(payload.new);
    render();
  })
  .subscribe((status) => {
    setConn(status === "SUBSCRIBED" ? "Live" : status, status === "SUBSCRIBED");
    if (status === "SUBSCRIBED") loadAll(); // (re)load whenever we (re)connect
  });

// A unit that diverts to another hospital is no longer visible to this board,
// so its "diverted" update never arrives here — a periodic reload clears it.
setInterval(loadAll, RELOAD_EVERY_MS);

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

  // List (built with textContent so unit names can't inject HTML)
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
        : `${formatMiles(r.distance_m)} · updated ${Math.round(ageS)}s ago` +
          `${r.eta_source === "estimate" ? " · rough estimate" : ""}` +
          `${stale ? " · NO SIGNAL?" : ""}`;

    card.append(name, eta, meta);
    list.append(card);
  }

  // Map markers for units still en route
  if (!map) return;
  const shown = new Set(
    rows.filter((x) => x.r.status === "enroute" && x.r.lat != null).map((x) => x.r.unit_id)
  );
  for (const [id, m] of markers) {
    if (!shown.has(id)) { m.map = null; markers.delete(id); }
  }
  for (const { r } of rows) {
    if (!shown.has(r.unit_id)) continue;
    const pos = { lat: r.lat, lng: r.lng };
    const m = markers.get(r.unit_id);
    if (m) m.position = pos;
    else markers.set(
      r.unit_id,
      new google.maps.marker.AdvancedMarkerElement({
        map, position: pos, content: pin(r.unit_id, "unit"), title: r.unit_id,
      })
    );
  }
}

function setConn(text, ok) {
  $("conn").textContent = text;
  $("conn").className = ok ? "ok" : "bad";
}

setInterval(render, 1000); // tick the countdowns every second
