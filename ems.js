import { UPDATE_INTERVAL_MS } from "./config.js";
import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles } from "./eta.js";

const $ = (id) => document.getElementById(id);

let hospitals = [];
let unitId = null;
let hospital = null;
let watchId = null;
let timer = null;
let wakeLock = null;
let lastPos = null;
let sending = false;
let lastEta = null; // { seconds, at } — for counting down between updates

// ---- Start-up: sign in (once per phone), then load destinations ----
const account = await signIn("rig");
unitId = account.unit_id;
$("unit").textContent = unitId;

const { data, error } = await db.from("hospitals").select("id, name").order("name");
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

  $("setup").hidden = true;
  $("live").hidden = false;
  $("dest").textContent = `${unitId} → ${hospital.name}`;
  $("eta").textContent = "--";
  $("dist").textContent = "";
  lastEta = null;
  setStatus("Waiting for GPS…");
  await keepAwake();

  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const first = !lastPos;
      lastPos = p.coords;
      if (first) sendUpdate(); // send right away on the first GPS fix
    },
    (err) => setStatus(`GPS error: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
  timer = setInterval(sendUpdate, UPDATE_INTERVAL_MS);
};

async function sendUpdate() {
  if (!lastPos || sending) return;
  sending = true;
  try {
    const { data, error } = await db.functions.invoke("eta", {
      body: { hospital_id: hospital.id, lat: lastPos.latitude, lng: lastPos.longitude },
    });
    if (error) return setStatus(`NOT SENT: ${await errorText(error)}`);
    lastEta = { seconds: data.eta_seconds, at: Date.now() };
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

// Count the ETA down every second between minute-by-minute updates
function tick() {
  if (!lastEta) return;
  const left = Math.max(0, lastEta.seconds - (Date.now() - lastEta.at) / 1000);
  $("eta").textContent = formatEta(left);
}
setInterval(tick, 1000);

$("arrived").onclick = async () => {
  navigator.geolocation.clearWatch(watchId);
  clearInterval(timer);
  timer = null;
  const { error } = await db.functions.invoke("eta", { body: { action: "arrived" } });
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
  lastPos = null;
  lastEta = null;
  $("live").hidden = true;
  $("setup").hidden = false;
  showMsg(error ? `Couldn't mark arrived: ${await errorText(error)}` : "Marked arrived. Ready for next transport.");
};

// Pull the server's error message out of a failed function call
async function errorText(error) {
  try { return (await error.context.json()).error || error.message; } catch { return error.message; }
}

// Keep the screen on — phones pause web pages when the screen locks
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && timer) keepAwake();
});

function setStatus(text) { $("status").textContent = text; }
function showMsg(text) { $("msg").textContent = text; }
