import { UPDATE_INTERVAL_MS, IDLE_UPDATE_INTERVAL_MS } from "./config.js";
import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles, haversineMeters, MODE_LABELS } from "./eta.js";
import { effectiveService, serviceText, setService, durationPicker } from "./service.js";

const $ = (id) => document.getElementById(id);

// Transport switches from "on scene" to "transporting" once the phone is this
// far from where Start transport was tapped.
const MOVING_AFTER_M = 100;
// If the crew went out of service this recently, reopening the app doesn't put them back in
const OUT_OF_SERVICE_STICKY_H = 8;
// Stopped vs. moving after leaving the scene. GPS speed is used only here, in memory,
// to tell moving from stopped — it is never shown, sent or stored.
const STOP_SPEED_MPS = 1.5;     // below ≈ 3 mph counts as stopped
const MOVE_SPEED_MPS = 3;       // above ≈ 7 mph counts as moving again
const STOP_CARE_AFTER_S = 10;   // stopped this long while running lights & sirens → possibly patient care
const STOP_PLAIN_AFTER_S = 120; // driving with traffic: only flag long stops (not red lights)
// An ED "transporting to us" request older than this is ignored
const ED_REQUEST_MAX_AGE_MS = 30 * 60 * 1000;

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
let startedBy = "crew";   // 'crew' or 'ed' (the ED marked us transporting)
let handledRequestAt = null;
// Movement after leaving the scene
let prevFix = null;
let lastSpeed = null;
let lastFixAt = null;
let stoppedSince = null;  // ms timestamp when the unit came to a stop
let motionSent = null;    // last motion state sent: 'moving' | 'stopped' | 'stopped_care'
let phase = "onscene";    // 'onscene' → 'transporting'
// Service status: this unit's row ({ service_status, special_event_until, ... }).
// Unless out of service, the phone checks in every 2 minutes between transports (no Google call).
let svc = null;
const tracking = () => effectiveService(svc) !== "out_of_service";
let idleWatchId = null;   // GPS watch while not transporting
let idleTimer = null;
let lastIdleFix = null;
let departure = null;     // after arrival: { hospital, threshold } — clears the ED board on driving away

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

$("signout").onclick = async () => {
  if (tracking()) await changeService("out_of_service");
  signOut();
};

// ---- Service status: In service / Out of service / Special event ----
$("svc-in").onclick = () => changeService("in_service");
$("svc-out").onclick = () => changeService("out_of_service");
$("svc-special").onclick = () => { $("special-picker").hidden = !$("special-picker").hidden; };
$("special-picker").append(durationPicker((minutes) => changeService("special_event", minutes)));

// On opening the app: go in service, unless on an active special event or the crew
// went out of service within the last few hours.
const { data: me } = await db.from("units")
  .select("service_status, special_event_until, service_changed_at, service_changed_by, out_of_service_at, shadow, ed_request_hospital_id, ed_request_at")
  .eq("unit_id", unitId).maybeSingle();
const recentlyOut = effectiveService(me) === "out_of_service" && me.out_of_service_at &&
  Date.now() - Date.parse(me.out_of_service_at) < OUT_OF_SERVICE_STICKY_H * 3600 * 1000;
setShadow(me?.shadow === true);
if (effectiveService(me) === "special_event" || recentlyOut) applyService(me);
else changeService("in_service");

// The MSO can change this unit's status from the MSO view — follow it live
db.channel("my-unit")
  .on("postgres_changes",
    { event: "*", schema: "public", table: "units", filter: `unit_id=eq.${unitId}` },
    (payload) => {
      const r = payload.new;
      if (r?.unit_id) setShadow(r.shadow === true);
      checkEdRequest(r);
      if (!r?.unit_id || r.service_changed_at === svc?.service_changed_at) return;
      applyService(r);
      if (r.service_changed_by && r.service_changed_by !== unitId) {
        showMsg(`Status changed by ${r.service_changed_by}: ${serviceText(r)}`);
      }
    })
  .subscribe();

async function changeService(status, minutes = null) {
  $("special-picker").hidden = true;
  const err = await setService(unitId, status, minutes);
  if (err) return showMsg(`Couldn't change status: ${err}`);
  const { data: row } = await db.from("units")
    .select("service_status, special_event_until, service_changed_at, service_changed_by, out_of_service_at")
    .eq("unit_id", unitId).maybeSingle();
  applyService(row);
}

// Show the status and start/stop check-ins to match it
function applyService(row) {
  svc = row;
  setServiceUI();
  if (timer) return; // mid-transport: ETA updates keep running regardless
  if (tracking()) {
    keepAwake();
    startIdle();
    sendHeartbeat();
  } else {
    departure = null;
    stopIdle();
    releaseWakeLock();
  }
}

function setServiceUI() {
  const st = effectiveService(svc);
  $("service").textContent = `${st === "out_of_service" ? "○" : st === "special_event" ? "★" : "●"} ${serviceText(svc)}`;
  $("service").className = `service ${st === "out_of_service" ? "off" : st === "special_event" ? "special" : "on"}`;
  for (const [id, s] of [["svc-in", "in_service"], ["svc-out", "out_of_service"], ["svc-special", "special_event"]]) {
    $(id).classList.toggle("current", st === s);
  }
  $("svc-special").textContent = st === "special_event" ? "Change special event" : "Special event";
}

// A special event ends on its own: switch back to in service when the time is up
setInterval(() => {
  if (svc?.service_status === "special_event" && effectiveService(svc) === "in_service") {
    svc = { ...svc, service_status: "in_service", special_event_until: null };
    setServiceUI();
    showMsg("Special event ended. Back in service.");
    sendHeartbeat(); // the server records the change
  } else if (effectiveService(svc) === "special_event") {
    setServiceUI(); // refresh the time left
  }
}, 15000);

function startIdle() {
  if (idleWatchId != null || !("geolocation" in navigator)) return;
  idleWatchId = navigator.geolocation.watchPosition(
    (p) => {
      lastIdleFix = p;
      checkDeparture(p);
    },
    (err) => { if (err.code === 1) showMsg("Location is blocked — the MSO can't see this unit's position."); },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }
  );
  idleTimer = setInterval(sendHeartbeat, IDLE_UPDATE_INTERVAL_MS);
}

function stopIdle() {
  if (idleWatchId != null) navigator.geolocation.clearWatch(idleWatchId);
  idleWatchId = null;
  clearInterval(idleTimer);
  idleTimer = null;
}

async function sendHeartbeat() {
  if (!tracking() || timer) return; // during a transport the ETA updates do this job
  const c = lastIdleFix?.coords;
  const res = await db.functions.invoke("eta", {
    body: { action: "heartbeat", lat: c?.latitude, lng: c?.longitude, accuracy_m: c?.accuracy },
  }).catch(() => null);
  if (res?.data) setShadow(res.data.shadow);
}

// Trial shadow mode (set by the admin): the ED can't see this unit, so the crew must radio ETAs
function setShadow(on) {
  $("shadow").hidden = !on;
}

// ---- Transport ----
$("start").onclick = () => {
  const h = hospitals.find((x) => x.id === $("hospital").value);
  if (!h) return showMsg("Pick a destination.");
  startTransport(h, "crew");
};

// The ED marked this unit as transporting to them after a radio report → start automatically
function checkEdRequest(r) {
  if (!r?.ed_request_hospital_id || !r.ed_request_at || r.ed_request_at === handledRequestAt) return;
  if (Date.now() - Date.parse(r.ed_request_at) > ED_REQUEST_MAX_AGE_MS) return;
  handledRequestAt = r.ed_request_at;
  if (timer) return; // already transporting
  const h = hospitals.find((x) => x.id === r.ed_request_hospital_id);
  if (!h) return;
  startTransport(h, "ed");
  setStatus(`Started automatically: ${h.name} ED marked you as transporting after your radio report.`);
}
checkEdRequest(me);

async function startTransport(h, by) {
  if (!("geolocation" in navigator)) return showMsg("This browser can't share location.");
  hospital = h;
  startedBy = by;
  // Starting a transport puts the unit in service (an active special event stays)
  stopIdle();
  departure = null;
  if (effectiveService(svc) !== "special_event") {
    svc = { ...svc, service_status: "in_service", special_event_until: null };
    setServiceUI();
  }
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
  prevFix = null;
  lastSpeed = null;
  lastFixAt = null;
  stoppedSince = null;
  motionSent = null;
  $("motion").textContent = "";
  phase = "onscene";
  isStart = true;
  finishing = false;
  setPhase();
  if (by === "crew") setStatus("Waiting for GPS…");
  await keepAwake();

  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const first = !lastFix;
      lastFix = p;
      if (!startFix) startFix = p;
      checkArrival(p);
      trackSpeed(p);
      if (first) return sendUpdate(); // send right away on the first GPS fix
      // Started driving? Tell the ED right away instead of waiting for the next minute.
      if (phase === "onscene" && distance(p, startFix) > MOVING_AFTER_M) {
        phase = "transporting";
        motionSent = "moving"; // the server marks "moving" when the unit leaves the scene
        stoppedSince = null;
        setPhase();
        sendUpdate();
      }
      evaluateMotion();
    },
    (err) => setStatus(`GPS error: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
  timer = setInterval(sendUpdate, UPDATE_INTERVAL_MS);
}

// ---- Moving / stopped after leaving the scene ----
function trackSpeed(p) {
  let speed = p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed : null;
  if (speed == null && prevFix) {
    const dt = (p.timestamp - prevFix.timestamp) / 1000;
    if (dt > 0.5) speed = distance(p, prevFix) / dt;
  }
  prevFix = p;
  lastFixAt = p.timestamp;
  if (speed == null) return;
  lastSpeed = speed;
  if (speed < STOP_SPEED_MPS) stoppedSince ??= p.timestamp;
  else if (speed > MOVE_SPEED_MPS) stoppedSince = null;
}

function effectiveMode() {
  if (!lastEta) return "normal";
  return lastEta.mode === "ls" || lastEta.mode === "normal" ? lastEta.mode : lastEta.def;
}

function evaluateMotion() {
  if (!timer || finishing || phase !== "transporting") return;
  // Phones send fewer GPS updates when standing still: no fix for a while = not moving
  if (!stoppedSince && lastFixAt && Date.now() - lastFixAt > 5000 && (lastSpeed ?? 0) < MOVE_SPEED_MPS) {
    stoppedSince = lastFixAt;
  }
  let state = "moving";
  if (stoppedSince) {
    const dur = (Date.now() - stoppedSince) / 1000;
    if (effectiveMode() === "ls" && dur >= STOP_CARE_AFTER_S) state = "stopped_care";
    else if (dur >= STOP_PLAIN_AFTER_S) state = "stopped";
  }
  $("motion").textContent =
    state === "stopped_care" ? "Stopped — the ED sees: possibly patient care"
    : state === "stopped" ? "Stopped — the ED sees: stopped"
    : "Moving";
  if (state !== motionSent) sendMotion(state);
}
setInterval(evaluateMotion, 1000);

async function sendMotion(state) {
  motionSent = state;
  const c = lastFix?.coords;
  const { error } = await db.functions.invoke("eta", {
    body: {
      action: "motion",
      motion_state: state,
      since_age_ms: state === "moving" || !stoppedSince ? 0 : Date.now() - stoppedSince,
      lat: c?.latitude,
      lng: c?.longitude,
    },
  }).catch((e) => ({ error: e }));
  if (error) motionSent = null; // retry on the next check
}

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
        start: isStart,
        started_by: isStart ? startedBy : undefined,
        moving: phase === "transporting",
      },
    });
    if (error) return setStatus(`NOT SENT: ${await errorText(error)}`);
    if (finishing) return;
    isStart = false;
    setShadow(data.shadow);
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
    showMsg(`Couldn't mark arrived: ${await errorText(error)}`);
  } else {
    showMsg(
      `Arrived at ${hospital.name}${method === "auto" ? " (recorded automatically)" : ""}. ` +
      "You'll clear from the ED board when you drive away. Ready for next transport."
    );
    // Clear from the ED board once the rig drives away. If arrival was recorded from
    // further out (e.g. Arrived button with poor GPS), require driving clearly beyond that point.
    const arrivalDist = arrivalFix
      ? haversineMeters(arrivalFix.coords.latitude, arrivalFix.coords.longitude, hospital.lat, hospital.lng)
      : 0;
    departure = { hospital, threshold: Math.max(hospital.departure_radius_m ?? 100, arrivalDist + 50) };
  }
  // Back to checking in every 2 minutes (unless taken out of service meanwhile)
  if (tracking()) startIdle();
  else releaseWakeLock();
  setServiceUI();
}

// ---- After arrival: drove away from the hospital ----
async function checkDeparture(p) {
  if (!departure) return;
  const h = departure.hospital;
  const d = haversineMeters(p.coords.latitude, p.coords.longitude, h.lat, h.lng);
  if (d <= departure.threshold) return;
  departure = null;
  const { error } = await db.functions.invoke("eta", { body: { action: "departed" } });
  if (!error) {
    showMsg(`Left ${h.name}. Ready for next transport.`);
    sendHeartbeat(); // shows as available to the MSO right away
  }
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
  if (document.visibilityState === "visible" && (timer || tracking())) keepAwake();
});

function setStatus(text) { $("status").textContent = text; }
function showMsg(text) { $("msg").textContent = text; }
