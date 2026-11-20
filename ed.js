import { GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAP_ID } from "./config.js";
import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles, TRAUMA_LABELS, respondersText } from "./eta.js";

const STALE_AFTER_S = 150;           // flag a unit after ~2 missed minute updates
const HIDE_ARRIVED_AFTER_S = 7200;   // safety net: arrived units normally clear when they drive away
const IGNORE_ENROUTE_AFTER_S = 3600; // drop units silent for an hour
const RELOAD_EVERY_MS = 30000;       // full refresh (catches units that diverted away)
const CONFIRM_WINDOW_MS = 4000;      // trauma buttons need a second tap within this time

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
let acks = [];         // trauma_acks rows for this hospital (recent)

function applyRow(row) {
  if (!row || !row.unit_id) return;
  if (row.hospital_id !== hospital.id) units.delete(row.unit_id); // diverted away
  else units.set(row.unit_id, row);
}

// The database only returns rows for this hospital (row-level security)
async function loadAll() {
  const since = new Date(Date.now() - IGNORE_ENROUTE_AFTER_S * 1000).toISOString();
  const [u, a] = await Promise.all([
    db.from("units").select("*").eq("hospital_id", hospital.id).gte("updated_at", since),
    db.from("trauma_acks").select("*").eq("hospital_id", hospital.id).gte("acked_at", since),
  ]);
  if (u.error) return setConn(`Error: ${u.error.message}`, false);
  units = new Map(u.data.map((r) => [r.unit_id, r]));
  if (!a.error) acks = a.data;
  render();
}

// Live updates: Supabase pushes changes this account is allowed to see
db.channel("ed-feed")
  .on("postgres_changes", { event: "*", schema: "public", table: "units" }, (payload) => {
    applyRow(payload.new);
    render();
  })
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "trauma_acks" }, (payload) => {
    acks.push(payload.new);
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
  // Count down between updates while transporting; on scene the drive hasn't started
  const leftS = row.phase === "onscene"
    ? row.eta_seconds ?? 0
    : Math.max(0, (row.eta_seconds ?? 0) - ageS);
  return { ageS, leftS };
}

// "5:23" / "1:02:09" — time since arrival, counting up
function formatCountUp(fromIso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

// ---- Rendering ----
// render() rebuilds the cards when data changes; tick() updates the countdown
// text every second without rebuilding (so button taps aren't interrupted).
const cardEls = new Map(); // unit_id -> { card, eta, meta }

function render() {
  const rows = [...units.values()]
    .map((r) => ({ r, ...timing(r) }))
    .filter((x) =>
      x.r.status === "enroute" ? x.ageS < IGNORE_ENROUTE_AFTER_S
      : x.r.status === "arrived" ? x.ageS < HIDE_ARRIVED_AFTER_S
      : false // departed: drove away from the hospital
    )
    .sort((a, b) => {
      if (a.r.status !== b.r.status) return a.r.status === "enroute" ? -1 : 1;
      if (a.r.status === "arrived") return Date.parse(b.r.arrived_at ?? b.r.updated_at) - Date.parse(a.r.arrived_at ?? a.r.updated_at);
      return a.leftS - b.leftS;
    });

  const list = $("list");
  list.replaceChildren();
  cardEls.clear();
  if (!rows.some((x) => x.r.status === "enroute")) {
    list.append(el("p", "sub", "No inbound units."));
  }
  for (const { r } of rows) {
    const card = el("div", `card ${r.status}${r.trauma_level ? ` trauma-${r.trauma_level}` : ""}`);
    const top = el("div", "cardtop");
    top.append(el("div", "unit", r.unit_id));
    if (r.trauma_level) top.append(el("span", `badge ${r.trauma_level}`, TRAUMA_LABELS[r.trauma_level]));
    const eta = el("div", "eta");
    const phase = el("div", "phase");
    const meta = el("div", "sub");
    card.append(top, eta, phase, meta);

    if (r.trauma_level) {
      card.append(el("div", "sub responders", respondersText(acks.filter((a) => a.trauma_id === r.trauma_id))));
    }
    if (r.status === "enroute") card.append(traumaButtons(r));

    list.append(card);
    cardEls.set(r.unit_id, { card, eta, phase, meta });
  }
  tick();
  renderMarkers(rows);
}

function tick() {
  for (const [id, { card, eta, phase, meta }] of cardEls) {
    const r = units.get(id);
    if (!r) continue;
    const { ageS, leftS } = timing(r);
    const stale = r.status === "enroute" && ageS > STALE_AFTER_S;
    card.classList.toggle("stale", stale);

    if (r.status === "arrived") {
      eta.textContent = "ARRIVED";
      phase.textContent = `${formatCountUp(r.arrived_at ?? r.updated_at)} ago`;
      phase.className = "phase arrived";
      meta.textContent = "";
      continue;
    }

    const onScene = r.phase === "onscene";
    eta.textContent = onScene ? "On scene" : formatEta(leftS);
    phase.textContent = onScene ? `${formatEta(leftS)} away` : "TRANSPORTING";
    phase.className = `phase ${onScene ? "onscene" : "transporting"}`;
    const ls = r.driving_mode === "ls" || (r.driving_mode !== "normal" && r.default_mode === "ls");
    meta.textContent =
      `${formatMiles(r.distance_m)} · updated ${Math.round(ageS)}s ago` +
      `${!onScene && ls ? " · lights & sirens ETA" : ""}` +
      `${r.eta_source === "estimate" ? " · rough estimate" : ""}` +
      `${stale ? " · NO SIGNAL?" : ""}`;
  }
}
setInterval(tick, 1000);
setInterval(render, 15000); // re-check which units should be hidden

// Modified / Full / Cancel buttons. Each needs a confirming second tap.
function traumaButtons(r) {
  const wrap = el("div", "tbtns");
  const id = r.unit_id;
  if (r.trauma_level !== "modified") {
    wrap.append(confirmButton(`${id}:modified`, "Modified", "Confirm MODIFIED", "modified", () => setTrauma(id, "modified")));
  }
  if (r.trauma_level !== "full") {
    wrap.append(confirmButton(`${id}:full`, "Full", "Confirm FULL", "full", () => setTrauma(id, "full")));
  }
  if (r.trauma_level) {
    wrap.append(confirmButton(`${id}:cancel`, "Cancel", "Confirm cancel", "cancel", () => setTrauma(id, null)));
  }
  return wrap;
}

// The "armed" (waiting for confirm) state is kept here, outside the button,
// so it survives the card being redrawn by a live update.
let armedKey = null;
let armedUntil = 0;

function confirmButton(key, label, confirmLabel, cls, action) {
  const armed = armedKey === key && Date.now() < armedUntil;
  const b = el("button", `tbtn ${cls}${armed ? " armed" : ""}`, armed ? confirmLabel : label);
  b.onclick = async () => {
    if (!(armedKey === key && Date.now() < armedUntil)) {
      armedKey = key;
      armedUntil = Date.now() + CONFIRM_WINDOW_MS;
      render();
      setTimeout(() => { if (armedKey === key && Date.now() >= armedUntil) { armedKey = null; render(); } }, CONFIRM_WINDOW_MS + 50);
      return;
    }
    armedKey = null;
    b.disabled = true;
    b.textContent = "…";
    await action();
  };
  return b;
}

async function setTrauma(unitId, level) {
  const { error } = await db.rpc("set_trauma", { p_unit_id: unitId, p_level: level });
  if (error) alert(`Couldn't update trauma code: ${error.message}`);
  loadAll();
}

function renderMarkers(rows) {
  if (!map) return;
  const shown = rows.filter((x) => x.r.status === "enroute" && x.r.lat != null).map((x) => x.r);
  const ids = new Set(shown.map((r) => r.unit_id));
  for (const [id, m] of markers) {
    if (!ids.has(id)) { m.map = null; markers.delete(id); }
  }
  for (const r of shown) {
    const pos = { lat: r.lat, lng: r.lng };
    const cls = `unit${r.trauma_level ? ` ${r.trauma_level}` : ""}`;
    const m = markers.get(r.unit_id);
    if (m) {
      m.position = pos;
      m.content.className = `pin ${cls}`;
    } else {
      markers.set(
        r.unit_id,
        new google.maps.marker.AdvancedMarkerElement({
          map, position: pos, content: pin(r.unit_id, cls), title: r.unit_id,
        })
      );
    }
  }
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
