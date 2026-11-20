import { UPDATE_INTERVAL_MS } from "./config.js";
import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles, haversineMeters, MODE_LABELS } from "./eta.js";

const $ = (id) => document.getElementById(id);

// Transport switches from "on scene" to "transporting" once the phone is this
// far from where Start transport was tapped.
const MOVING_AFTER_M = 100;

let hospitals = [];
let unitId = null;
let hospital = null;
let watchId = null;
let timer = null;
let wakeLock = null;
let lastFix = null;       // latest GPS fix { coords, timestamp }
let sending = false;
let isStart = false;      // next update starts a new transport
let finishing = false;    // arrival in progress
let closestM = null;      // closest approach to the ED entrance this transport
let lastEta = null;       // { google, ls, mode, def, at } — for counting down between updates
let startFix = null;      // where the transport started (scene)
let phase = "onscene";    // 'onscene' → 'transporting'
let departWatchId = null; // after arrival: watches for driving away from the hospital

// ---- Start-up: sign in (once per phone), then load destinations ----
const account = await signIn("rig");
unitId = account.unit_id;
$("unit").textContent = unitId;

const { data, error } = await db
  .from("hospitals").select("id, name, lat, lng, arrival_radius_m, departure_radius_m").order("name");
if (error) showMsg(`Couldn't load destinations: ${error.message}`);
hospitals = data ?? [];
for (const h of hospitals) $("hospital").add(new Option(h.name, h.id));
$("setup").hidden = false;

$("signout").onclick = signOut;

// ---- Transport ----
$("start").onclick = async () => {
  if (!("geolocation" in navigator)) return showMsg("This browser can't share location.");
  hospital = hospitals.find((h) => h.id === $("hospital").value);
  if (!hospital) return showMsg("Pick a destination.");
  stopDepartureWatch();
  showMsg("");

  $("setup").hidden = true;
  $("live").hidden = false;
  $("dest").textContent = `${unitId} → ${hospital.name}`;
  $("eta-normal").textContent = "--";
  $("eta-ls").textContent = "--";
  $("diff").textContent = "";
  $("mode").textContent = "";
  $("dist").textContent = "";
  lastEta = null;
  lastFix = null;
  closestM = null;
  startFix = null;
  phase = "onscene";
  isStart = true;
  finishing = false;
  setPhase();
  setStatus("Waiting for GPS…");
  await keepAwake();

  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const first = !lastFix;
      lastFix = p;
      if (!startFix) startFix = p;
      checkArrival(p);
      if (first) return sendUpdate(); // send right away on the first GPS fix
      // Started driving? Tell the ED right away instead of waiting for the next minute.
      if (phase === "onscene" && distance(p, startFix) > MOVING_AFTER_M) {
        phase = "transporting";
        setPhase();
        sendUpdate();
      }
    },
    (err) => setStatus(`GPS error: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
  timer = setInterval(sendUpdate, UPDATE_INTERVAL_MS);
};

async function sendUpdate() {
  if (!lastFix || sending || finishing) return;
  sending = true;
  try {
    const c = lastFix.coords;
    const { data, error } = await db.functions.invoke("eta", {
      body: {
        hospital_id: hospital.id,
        lat: c.latitude,
        lng: c.longitude,
        accuracy_m: c.accuracy,
        speed_mps: c.speed,
        start: isStart,
        moving: phase === "transporting",
      },
    });
    if (error) return setStatus(`NOT SENT: ${await errorText(error)}`);
    if (finishing) return;
    isStart = false;
    lastEta = {
      google: data.eta_google_seconds,
      ls: data.eta_ls_seconds,
      mode: data.driving_mode,
      def: data.default_mode,
      at: Date.now(),
    };
    $("dist").textContent = formatMiles(data.distance_m);
    tick();
    setStatus(
      `Sent ${new Date().toLocaleTimeString()}${data.eta_source === "estimate" ? " (rough estimate)" : ""}`
    );
  } catch (e) {
    setStatus(`NOT SENT: ${e.message}`);
  } finally {
    sending = false;
  }
}

// Show both ETAs and count them down every second between minute updates
function tick() {
  if (!lastEta) return;
  // On scene the drive hasn't started, so the ETAs don't count down
  const elapsed = phase === "transporting" ? (Date.now() - lastEta.at) / 1000 : 0;
  const normal = Math.max(0, lastEta.google - elapsed);
  const ls = Math.max(0, lastEta.ls - elapsed);
  $("eta-normal").textContent = formatEta(normal);
  $("eta-ls").textContent = formatEta(ls);
  const savedMin = Math.round((lastEta.google - lastEta.ls) / 60);
  $("diff").textContent = savedMin >= 1
    ? `Lights & sirens ≈ ${savedMin} min faster`
    : "Lights & sirens: less than 1 min difference";
  const known = lastEta.mode === "ls" || lastEta.mode === "normal";
  const effective = known ? lastEta.mode : lastEta.def;
  $("mode").textContent = phase === "onscene"
    ? ""
    : known
      ? `Detected: ${MODE_LABELS[lastEta.mode]}`
      : `Detecting… (ED sees ${effective === "ls" ? "lights & sirens" : "no lights & sirens"} ETA for now)`;
  $("row-normal").classList.toggle("active", effective === "normal");
  $("row-ls").classList.toggle("active", effective === "ls");
}

function setPhase() {
  $("phase").textContent = phase === "onscene" ? "ON SCENE" : "TRANSPORTING";
  $("phase").className = `phase ${phase}`;
}

function distance(a, b) {
  return haversineMeters(a.coords.latitude, a.coords.longitude, b.coords.latitude, b.coords.longitude);
}
setInterval(tick, 1000);

// ---- Automatic arrival (geofence around the ED entrance) ----
function checkArrival(p) {
  if (!hospital || finishing) return;
  const d = haversineMeters(p.coords.latitude, p.coords.longitude, hospital.lat, hospital.lng);
  if (closestM == null || d < closestM) closestM = d;
  if (d <= (hospital.arrival_radius_m ?? 50)) finish("auto", p);
}

$("arrived").onclick = () => finish("button", lastFix);

async function finish(method, fix) {
  if (finishing) return;
  finishing = true;
  navigator.geolocation.clearWatch(watchId);
  clearInterval(timer);
  timer = null;
  // Let any ETA update already in flight finish first, so it can't land after the arrival
  for (let i = 0; sending && i < 100; i++) await new Promise((r) => setTimeout(r, 100));

  const { error } = await db.functions.invoke("eta", {
    body: {
      action: "arrived",
      method,
      lat: fix?.coords.latitude,
      lng: fix?.coords.longitude,
      age_ms: fix ? Date.now() - fix.timestamp : null,
      closest_approach_m: closestM,
    },
  });
  const arrivalFix = fix;
  lastFix = null;
  lastEta = null;
  $("live").hidden = true;
  $("setup").hidden = false;
  if (error) {
    releaseWakeLock();
    return showMsg(`Couldn't mark arrived: ${await errorText(error)}`);
  }
  showMsg(
    `Arrived at ${hospital.name}${method === "auto" ? " (recorded automatically)" : ""}. ` +
    "You'll clear from the ED board when you drive away. Ready for next transport."
  );
  startDepartureWatch(arrivalFix);
}

// ---- After arrival: clear from the ED board once the rig drives away ----
function startDepartureWatch(arrivalFix) {
  const h = hospital;
  const radius = h.departure_radius_m ?? 100;
  // If arrival was recorded from further out (e.g. Arrived button with poor GPS),
  // require driving clearly further away than that point.
  const arrivalDist = arrivalFix
    ? haversineMeters(arrivalFix.coords.latitude, arrivalFix.coords.longitude, h.lat, h.lng)
    : 0;
  const threshold = Math.max(radius, arrivalDist + 50);
  departWatchId = navigator.geolocation.watchPosition(
    async (p) => {
      const d = haversineMeters(p.coords.latitude, p.coords.longitude, h.lat, h.lng);
      if (d <= threshold || departWatchId == null) return;
      stopDepartureWatch();
      releaseWakeLock();
      const { error } = await db.functions.invoke("eta", { body: { action: "departed" } });
      if (!error) showMsg(`Left ${h.name}. Ready for next transport.`);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
  );
}

function stopDepartureWatch() {
  if (departWatchId != null) navigator.geolocation.clearWatch(departWatchId);
  departWatchId = null;
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}

// Pull the server's error message out of a failed function call
async function errorText(error) {
  try { return (await error.context.json()).error || error.message; } catch { return error.message; }
}

// Keep the screen on — phones pause web pages when the screen locks
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (timer || departWatchId != null)) keepAwake();
});

function setStatus(text) { $("status").textContent = text; }
function showMsg(text) { $("msg").textContent = text; }
