import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles, TRAUMA_LABELS, respondersText } from "./eta.js";

const ALERT_IF_NEWER_THAN_S = 15 * 60;  // alarm for activations up to 15 min old (e.g. after reconnecting)
const HIDE_ARRIVED_AFTER_S = 30 * 60;  // keep arrived traumas visible for 30 min
const IGNORE_AFTER_S = 3600;
const RELOAD_EVERY_MS = 30000;
const ALARM_REPEAT_MS = 3000;

const $ = (id) => document.getElementById(id);

// ---- Sign in ----
const account = await signIn("provider");
const { data: { session } } = await db.auth.getSession();
const myUserId = session.user.id;
const { data: hospital, error: hErr } = await db
  .from("hospitals").select("*").eq("id", account.hospital_id).single();
if (hErr) throw new Error(`Couldn't load hospital: ${hErr.message}`);

$("who").textContent = `${account.display_name || "Provider"} · ${hospital.name}`;
$("app").hidden = false;
$("signout").onclick = signOut;

// ---- Arming alerts (browsers only allow sound after a tap) ----
let audioCtx = null;
let wakeLock = null;

$("arm").onclick = async () => {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    beep(1, 880); // confirms sound works
  } catch (e) { console.warn("No audio", e); }
  try {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch {}
  await keepAwake();
  $("armbox").hidden = true;
  $("armed").hidden = false;
  checkAlarms();
};

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx) keepAwake();
});

// ---- Data ----
let units = new Map(); // unit_id -> row
let acks = [];

function applyRow(row) {
  if (!row || !row.unit_id) return;
  if (row.hospital_id !== hospital.id) units.delete(row.unit_id);
  else units.set(row.unit_id, row);
}

async function loadAll() {
  const since = new Date(Date.now() - IGNORE_AFTER_S * 1000).toISOString();
  const [u, a] = await Promise.all([
    db.from("units").select("*").eq("hospital_id", hospital.id).gte("updated_at", since),
    db.from("trauma_acks").select("*").eq("hospital_id", hospital.id).gte("acked_at", since),
  ]);
  if (u.error) return setConn(`Error: ${u.error.message}`, false);
  units = new Map(u.data.map((r) => [r.unit_id, r]));
  if (!a.error) acks = a.data;
  changed();
}

db.channel("provider-feed")
  .on("postgres_changes", { event: "*", schema: "public", table: "units" }, (payload) => {
    applyRow(payload.new);
    changed();
  })
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "trauma_acks" }, (payload) => {
    acks.push(payload.new);
    changed();
  })
  .subscribe((status) => {
    setConn(status === "SUBSCRIBED" ? "Live" : status, status === "SUBSCRIBED");
    if (status === "SUBSCRIBED") loadAll();
  });
setInterval(loadAll, RELOAD_EVERY_MS);

function changed() {
  render();
  checkAlarms();
}

function activeTraumas() {
  return [...units.values()]
    .filter((r) => r.trauma_level && r.trauma_id)
    .map((r) => {
      const ageS = (Date.now() - Date.parse(r.updated_at)) / 1000;
      return { r, ageS, leftS: Math.max(0, (r.eta_seconds ?? 0) - ageS) };
    })
    .filter((x) => (x.r.status === "enroute" ? x.ageS < IGNORE_AFTER_S : x.ageS < HIDE_ARRIVED_AFTER_S))
    .sort((a, b) => {
      if (a.r.status !== b.r.status) return a.r.status === "enroute" ? -1 : 1;
      if (a.r.trauma_level !== b.r.trauma_level) return a.r.trauma_level === "full" ? -1 : 1;
      return a.leftS - b.leftS;
    });
}

const iAcked = (traumaId) => acks.some((a) => a.trauma_id === traumaId && a.user_id === myUserId);

// ---- Alarms ----
const seen = new Set();     // trauma_ids already alerted
const ringing = new Map();  // trauma_id -> row, while alarm is sounding

function checkAlarms() {
  for (const { r } of activeTraumas()) {
    if (seen.has(r.trauma_id)) continue;
    seen.add(r.trauma_id);
    const ageS = (Date.now() - Date.parse(r.trauma_set_at)) / 1000;
    if (r.status === "enroute" && ageS < ALERT_IF_NEWER_THAN_S && !iAcked(r.trauma_id)) {
      ringing.set(r.trauma_id, r);
      notify(r);
    }
  }
  // Stop ringing for activations that were cancelled, upgraded, or acknowledged
  const current = new Set(activeTraumas().map((x) => x.r.trauma_id));
  for (const id of ringing.keys()) {
    if (!current.has(id) || iAcked(id)) ringing.delete(id);
  }
  updateTitle();
  render();
}

setInterval(() => {
  if (!ringing.size) return;
  const full = [...ringing.values()].some((r) => r.trauma_level === "full");
  beep(full ? 3 : 2, full ? 1046 : 784);
  navigator.vibrate?.(full ? [400, 150, 400, 150, 400] : [400, 200, 400]);
}, ALARM_REPEAT_MS);

function beep(times, freq) {
  if (!audioCtx) return;
  let t = audioCtx.currentTime;
  for (let i = 0; i < times; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
    t += 0.35;
  }
}

// System notification when this page is in the background (where the browser allows it)
function notify(r) {
  try {
    if (document.visibilityState === "visible") return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(`${TRAUMA_LABELS[r.trauma_level]} – ${r.unit_id}`, {
      body: `ETA ${formatEta(r.eta_seconds)} to ${hospital.name}`,
      tag: r.trauma_id,
      requireInteraction: true,
    });
  } catch (e) {
    console.warn("Notification not shown", e);
  }
}

const baseTitle = document.title;
function updateTitle() {
  if (!ringing.size) return (document.title = baseTitle);
  const full = [...ringing.values()].some((r) => r.trauma_level === "full");
  document.title = `(!) ${full ? "FULL" : "MODIFIED"} TRAUMA – ETA Beacon`;
}

// ---- Rendering ----
const cardEls = new Map(); // unit_id -> { eta, meta }

function render() {
  const rows = activeTraumas();
  const list = $("list");
  list.replaceChildren();
  cardEls.clear();
  if (!rows.length) list.append(el("p", "sub", "No active trauma codes."));

  for (const { r } of rows) {
    const isRinging = ringing.has(r.trauma_id);
    const card = el("div", `tcard ${r.trauma_level} ${r.status}${isRinging ? " ringing" : ""}`);
    card.append(el("div", "tlevel", TRAUMA_LABELS[r.trauma_level]));
    card.append(el("div", "tunit", `${r.unit_id} → ${hospital.name}`));
    const eta = el("div", "eta");
    const meta = el("div", "sub");
    card.append(eta, meta);
    card.append(el("div", "sub responders", respondersText(acks.filter((a) => a.trauma_id === r.trauma_id))));

    if (r.status === "enroute") {
      if (iAcked(r.trauma_id)) {
        card.append(el("div", "acked", "You're responding ✓"));
      } else {
        const btn = el("button", "big go", "I'm responding");
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = "…";
          const { error } = await db.rpc("ack_trauma", { p_trauma_id: r.trauma_id });
          if (error) alert(`Couldn't respond: ${error.message}`);
          ringing.delete(r.trauma_id);
          loadAll();
        };
        card.append(btn);
      }
      if (isRinging) {
        const silence = el("button", "big alt", "Silence");
        silence.onclick = () => { ringing.delete(r.trauma_id); updateTitle(); render(); };
        card.append(silence);
      }
    }
    list.append(card);
    cardEls.set(r.unit_id, { eta, meta });
  }
  tick();
}

function tick() {
  for (const [id, { eta, meta }] of cardEls) {
    const r = units.get(id);
    if (!r) continue;
    const ageS = (Date.now() - Date.parse(r.updated_at)) / 1000;
    const setS = (Date.now() - Date.parse(r.trauma_set_at)) / 1000;
    eta.textContent = r.status === "arrived" ? "ARRIVED" : formatEta(Math.max(0, (r.eta_seconds ?? 0) - ageS));
    meta.textContent =
      `Activated ${Math.max(0, Math.round(setS / 60))} min ago` +
      (r.status === "enroute" ? ` · ${formatMiles(r.distance_m)}` : "");
  }
}
setInterval(tick, 1000);

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
