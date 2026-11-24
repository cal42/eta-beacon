import { createMap, addMarker, pin } from "./gmaps.js";
import { db, signIn, signOut } from "./auth.js";
import { formatEta, formatMiles, TRAUMA_LABELS, respondersText, etaLeftSeconds, countUp, movementLine, arrivalLine } from "./eta.js";

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

// ---- Log radio ETA (radio vs. ETA Beacon trial) ----
// The clerk types the unit + minutes when a unit radios its ETA; the time is recorded as now.
$("radio-btn").hidden = false;
$("radio-btn").onclick = () => {
  $("radio").hidden = !$("radio").hidden;
  if (!$("radio").hidden) { loadRadio(); $("r-unit").focus(); }
};
$("radio").onsubmit = async (e) => {
  e.preventDefault();
  const unit = $("r-unit").value.trim().toUpperCase();
  const minutes = Number($("r-min").value);
  if (!unit) return radioMsg("Enter the unit, e.g. M1");
  if ($("r-min").value === "" || !Number.isInteger(minutes) || minutes < 0 || minutes > 180) {
    return radioMsg("Enter the ETA in whole minutes (0–180)");
  }
  $("r-save").disabled = true;
  const { error } = await db.rpc("log_radio_eta", {
    p_unit_id: unit, p_eta_minutes: minutes, p_note: $("r-note").value || null,
  });
  if (error) { $("r-save").disabled = false; return radioMsg(`Not logged: ${error.message}`); }
  let msg = `Logged ${unit} · ${minutes} min at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  // Crew too busy to tap Start? Put the unit on the board as transporting here.
  if ($("r-mark").checked) {
    const { data: result, error: mErr } = await db.rpc("ed_mark_transporting", { p_unit_id: unit, p_eta_minutes: minutes });
    msg += mErr ? ` · couldn't show as transporting: ${mErr.message}`
      : result === "radio_only" ? ` · ${unit} is in the trial's radio-only group, so it isn't shown`
      : result === "already" ? ` · ${unit} is already on the board`
      : ` · ${unit} now shown as transporting`;
    loadAll();
  }
  $("r-save").disabled = false;
  radioMsg(msg);
  $("r-unit").value = "";
  $("r-min").value = "";
  $("r-note").value = "";
  $("r-mark").checked = false;
  $("r-unit").focus();
  loadRadio();
};
// Suggest "show as transporting" when the unit isn't on the board yet
$("r-unit").oninput = () => {
  const u = $("r-unit").value.trim().toUpperCase();
  $("r-mark").checked = u.length >= 2 && !units.has(u);
};

function radioMsg(text) { $("r-msg").textContent = text; }

// Recent radio ETAs (last 2 h) with Undo for the last 30 min
async function loadRadio() {
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const { data, error } = await db.from("radio_etas")
    .select("id, unit_id, eta_minutes, reported_at")
    .eq("hospital_id", hospital.id).is("deleted_at", null).gte("reported_at", since)
    .order("reported_at", { ascending: false }).limit(5);
  if (error) return;
  const box = $("r-recent");
  box.replaceChildren();
  for (const r of data) {
    const line = el("span", "rline",
      `${r.unit_id} · ${r.eta_minutes} min · ${new Date(r.reported_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    if (Date.now() - Date.parse(r.reported_at) < 30 * 60 * 1000) {
      const undo = el("button", "link", "Undo");
      undo.type = "button";
      undo.onclick = async () => {
        const { error } = await db.rpc("delete_radio_eta", { p_id: r.id });
        radioMsg(error ? `Couldn't undo: ${error.message}` : `Removed ${r.unit_id} · ${r.eta_minutes} min`);
        loadRadio();
      };
      line.append(" ", undo);
    }
    box.append(line);
  }
  // Suggest unit names: units on the board + recently radioed units
  const names = new Set([...units.keys(), ...data.map((r) => r.unit_id)]);
  $("r-units").replaceChildren(...[...names].sort().map((n) => new Option(n)));
}

// ---- Report an issue ----
$("issue-btn").hidden = false;
$("issue-btn").onclick = () => {
  $("issue").hidden = !$("issue").hidden;
  if (!$("issue").hidden) $("i-text").focus();
};
$("issue").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("i-text").value.trim();
  if (!text) return ($("i-msg").textContent = "Please describe the issue");
  $("i-send").disabled = true;
  const { error } = await db.rpc("submit_ed_feedback", {
    p_kind: "issue", p_unit_id: $("i-unit").value || null, p_comment: text,
  });
  $("i-send").disabled = false;
  if (error) return ($("i-msg").textContent = `Not sent: ${error.message}`);
  $("i-msg").textContent = "Thanks, sent.";
  $("i-unit").value = "";
  $("i-text").value = "";
};

// ---- Google map ----
const markers = new Map(); // unit_id -> AdvancedMarkerElement
const map = await createMap($("map"), { lat: hospital.lat, lng: hospital.lng }, 13);
if (map) addMarker(map, { lat: hospital.lat, lng: hospital.lng }, pin(hospital.name, "hosp"), hospital.name);

// ---- Data ----
let units = new Map(); // unit_id -> latest row
let acks = [];         // trauma_acks rows for this hospital (recent)
let rated = new Set(); // transport_ids already rated by this ED
const ratingOpen = new Set(); // transport_ids showing the "why not?" reasons

function applyRow(row) {
  if (!row || !row.unit_id) return;
  if (row.hospital_id !== hospital.id) units.delete(row.unit_id); // diverted away
  else units.set(row.unit_id, row);
}

// The database only returns rows for this hospital (row-level security)
async function loadAll() {
  const since = new Date(Date.now() - IGNORE_ENROUTE_AFTER_S * 1000).toISOString();
  const ratedSince = new Date(Date.now() - HIDE_ARRIVED_AFTER_S * 1000).toISOString();
  const [u, a, f] = await Promise.all([
    db.from("units").select("*").eq("hospital_id", hospital.id).gte("updated_at", since),
    db.from("trauma_acks").select("*").eq("hospital_id", hospital.id).gte("acked_at", since),
    db.from("ed_feedback").select("transport_id").eq("hospital_id", hospital.id)
      .eq("kind", "eta_rating").gte("created_at", ratedSince),
  ]);
  if (u.error) return setConn(`Error: ${u.error.message}`, false);
  units = new Map(u.data.map((r) => [r.unit_id, r]));
  if (!a.error) acks = a.data;
  if (!f.error) rated = new Set(f.data.map((x) => x.transport_id));
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
  // Counts down while moving; pauses on scene and while stopped (see eta.js)
  return { ageS, leftS: etaLeftSeconds(row) };
}

const radioOnly = (r) => r.eta_source === "radio" && !r.transport_id; // marked by the ED, no live GPS

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
    if (radioOnly(r)) card.append(radioOnlyButtons(r));
    if (r.status === "arrived" && !r.doors_at) card.append(doorsButton(r));
    if (r.status === "arrived" && r.transport_id && !rated.has(r.transport_id)) card.append(ratingPrompt(r));

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
    const stale = r.status === "enroute" && !radioOnly(r) && ageS > STALE_AFTER_S;
    card.classList.toggle("stale", stale);
    card.classList.toggle("stopped-care", r.status === "enroute" && r.motion_state === "stopped_care");

    if (r.status === "arrived") {
      const a = arrivalLine(r);
      eta.textContent = "ARRIVED";
      phase.textContent = a.text;
      phase.className = a.cls;
      meta.textContent = r.doors_at
        ? `On the ramp ${rampTime(r)} · arrived ${countUp(r.arrived_at ?? r.updated_at)} ago`
        : "";
      continue;
    }

    const onScene = r.phase === "onscene";
    const line = movementLine(r);
    eta.textContent = onScene ? "On scene" : r.eta_seconds == null ? "ETA ?" : formatEta(leftS);
    phase.textContent = onScene ? `${line.text} · ${formatEta(leftS)} away` : line.text;
    phase.className = line.cls;
    if (radioOnly(r)) {
      meta.textContent = `Radio ETA logged ${Math.round(ageS / 60)} min ago · marked transporting by ED`;
      continue;
    }
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

// Charge nurse: medics have wheeled the patient through the ED doors (second tap confirms)
function doorsButton(r) {
  const wrap = el("div", "tbtns");
  const id = r.unit_id;
  wrap.append(confirmButton(`${id}:doors`, "Through the doors", "Confirm through the doors", "doors", async () => {
    const { error } = await db.rpc("ed_mark_through_doors", { p_unit_id: id });
    if (error) alert(`Couldn't update ${id}: ${error.message}`);
    loadAll();
  }));
  return wrap;
}

// "4:12" from on the ramp to through the doors
function rampTime(r) {
  const s = Math.max(0, Math.round((Date.parse(r.doors_at) - Date.parse(r.arrived_at ?? r.updated_at)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Units the ED marked as transporting (no live GPS): the ED records arrival / clears them
function radioOnlyButtons(r) {
  const wrap = el("div", "tbtns");
  const id = r.unit_id;
  if (r.status === "enroute") {
    wrap.append(confirmButton(`${id}:arrived`, "Arrived", "Confirm arrived", "cancel", () => edUpdate(id, "arrived")));
  }
  wrap.append(confirmButton(`${id}:clear`, "Remove", "Confirm remove", "cancel", () => edUpdate(id, "clear")));
  return wrap;
}

async function edUpdate(unitId, action) {
  const { error } = await db.rpc("ed_update_unit", { p_unit_id: unitId, p_action: action });
  if (error) alert(`Couldn't update ${unitId}: ${error.message}`);
  loadAll();
}

// One-tap "ETA accurate?" on an arrived unit
function ratingPrompt(r) {
  const box = el("div", "rating");
  const tid = r.transport_id;
  if (!ratingOpen.has(tid)) {
    box.append(el("span", "sub", "ETA accurate?"));
    const yes = el("button", "tbtn rate", "Yes");
    yes.onclick = () => rate(r, true, null);
    const no = el("button", "tbtn rate", "No");
    no.onclick = () => { ratingOpen.add(tid); render(); };
    box.append(yes, no);
  } else {
    box.append(el("span", "sub", "What was off?"));
    for (const [label, reason] of [["Arrived early", "early"], ["Arrived late", "late"], ["Other", "other"]]) {
      const b = el("button", "tbtn rate", label);
      b.onclick = () => rate(r, false, reason);
      box.append(b);
    }
  }
  return box;
}

async function rate(r, accurate, reason) {
  rated.add(r.transport_id);
  ratingOpen.delete(r.transport_id);
  render();
  const { error } = await db.rpc("submit_ed_feedback", {
    p_kind: "eta_rating", p_transport_id: r.transport_id, p_unit_id: r.unit_id,
    p_accurate: accurate, p_reason: reason,
  });
  if (error) {
    rated.delete(r.transport_id);
    alert(`Rating not saved: ${error.message}`);
    render();
  }
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
      markers.set(r.unit_id, addMarker(map, pos, pin(r.unit_id, cls), r.unit_id));
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
