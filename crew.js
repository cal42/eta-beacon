import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_KEY, HOSPITALS, UPDATE_INTERVAL_MS } from "./config.js";
import { getRoute, formatEta, formatMiles } from "./eta.js";

const db = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (id) => document.getElementById(id);

// Fill the destination dropdown and remember the last unit name used
for (const h of HOSPITALS) $("hospital").add(new Option(h.name, h.id));
try { $("unit").value = localStorage.getItem("unit") || ""; } catch {}

let watchId = null;
let timer = null;
let wakeLock = null;
let lastPos = null;
let unitId = null;
let hospital = null;
let sending = false;

$("start").onclick = async () => {
  unitId = $("unit").value.trim().toUpperCase();
  if (!unitId) return showMsg("Enter your unit name first.");
  if (!("geolocation" in navigator)) return showMsg("This browser can't share location.");
  hospital = HOSPITALS.find((h) => h.id === $("hospital").value);
  try { localStorage.setItem("unit", unitId); } catch {}

  $("setup").hidden = true;
  $("live").hidden = false;
  $("dest").textContent = `${unitId} → ${hospital.name}`;
  $("eta").textContent = "--";
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
    const { latitude: lat, longitude: lng } = lastPos;
    const route = await getRoute(lat, lng, hospital.lat, hospital.lng);
    $("eta").textContent = formatEta(route.seconds);
    $("dist").textContent = formatMiles(route.meters);

    const { error } = await db.from("units").upsert({
      unit_id: unitId,
      hospital_id: hospital.id,
      status: "enroute",
      lat,
      lng,
      eta_seconds: Math.round(route.seconds),
      distance_m: Math.round(route.meters),
      updated_at: new Date().toISOString(),
    });
    setStatus(
      error
        ? `NOT SENT: ${error.message}`
        : `Sent ${new Date().toLocaleTimeString()}${route.estimated ? " (rough estimate)" : ""}`
    );
  } finally {
    sending = false;
  }
}

$("arrived").onclick = async () => {
  navigator.geolocation.clearWatch(watchId);
  clearInterval(timer);
  const { error } = await db
    .from("units")
    .update({ status: "arrived", eta_seconds: 0, updated_at: new Date().toISOString() })
    .eq("unit_id", unitId);
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
  lastPos = null;
  $("live").hidden = true;
  $("setup").hidden = false;
  showMsg(error ? `Couldn't mark arrived: ${error.message}` : "Marked arrived. Ready for next transport.");
};

// Keep the screen on — phones pause web pages when the screen locks
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && timer) keepAwake();
});

function setStatus(text) { $("status").textContent = text; }
function showMsg(text) { $("msg").textContent = text; }
