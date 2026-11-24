// ETA Beacon — "eta" Edge Function
//
// Called by a signed-in rig phone.
//   Position update: { hospital_id, lat, lng, accuracy_m, start?, moving?, started_by? }
//   (Speed is never sent, shown or stored.)
//     (moving = the phone has driven away from where the transport was started)
//     1. Checks the caller is a rig account (and which unit it is).
//     2. Asks Google Routes for a traffic-aware ETA (key stays secret here).
//     3. Works out both ETAs (no lights & sirens / lights & sirens) and which
//        mode the unit seems to be driving in.
//     4. Saves the live row (units) and the raw history (transports, eta_samples).
//   Arrival:   { action: "arrived", method: "auto" | "button", lat, lng, age_ms, closest_approach_m }
//   Departure: { action: "departed" }  (drove away from the hospital after arriving)
//   Movement:  { action: "motion", motion_state: "moving" | "stopped" | "stopped_care",
//                since_age_ms, lat, lng }  (sent the moment it changes; no Google call)
//   Check-in:  { action: "heartbeat", lat?, lng?, accuracy_m? }  (every 2 min when not transporting;
//              no Google call). Service status itself is changed with the set_unit_service
//              database function (by the unit or its MSO).
//
// Called by a signed-in MSO:
//   { action: "mso_eta", unit_id, lat, lng }  → the MSO's own ETAs (no lights & sirens /
//   lights & sirens) from their position to that unit. Only units of the MSO's agency.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GOOGLE_ROUTES_KEY   Google API key restricted to the Routes API
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

// ---- Tunable assumptions (each sample records the factor in effect) ----
// Lights & sirens assumed to take 75% of normal drive time (25% faster).
const LS_TIME_FACTOR = 0.75;
// Driving-mode detection: compare how fast Google's ETA falls vs. the clock.
// ≈1.0 = driving with traffic; ≈1/0.75 = 1.33 = lights & sirens.
const LS_ENTER_RATIO = 1.2;     // switch to lights & sirens above this
const LS_EXIT_RATIO = 1.1;      // switch back to normal below this
const LS_WINDOW_MIN_S = 110;    // compare against an ETA at least this old…
const LS_WINDOW_MAX_S = 300;    // …and no older than this

// Cost guard: never call Google for the same unit more often than this.
const MIN_GOOGLE_INTERVAL_S = 45;

// Fallback if Google is unreachable: straight line × road factor at ~30 mph
const FALLBACK_SPEED_MPS = 13;
const ROAD_FACTOR = 1.3;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    // ---- Who is calling? ----
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Not signed in" }, 401);

    const { data: acct } = await admin
      .from("accounts").select("role, unit_id, agency_id").eq("user_id", user.id).maybeSingle();
    const body = await req.json().catch(() => ({}));
    const now = new Date();

    if (acct?.role === "mso" && body.action === "mso_eta") return await msoEta(acct.agency_id, body);
    if (!acct || acct.role !== "rig") return json({ error: "This login is not a rig account" }, 403);
    const unitId: string = acct.unit_id;

    const { data: prev } = await admin.from("units").select("*").eq("unit_id", unitId).maybeSingle();

    if (body.action === "arrived") return await arrived(unitId, prev, body, now);
    if (body.action === "departed") return await departed(unitId, prev, now);
    if (body.action === "heartbeat") return await heartbeat(unitId, acct.agency_id, prev, body, now);
    if (body.action === "motion") return await motion(prev, body, now);
    return await positionUpdate(unitId, acct.agency_id, prev, body, now);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error" }, 500);
  }
});

// ---------------------------------------------------------------------------
async function positionUpdate(unitId: string, agencyId: string | null, prev: any, body: any, now: Date) {
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!validLatLng(lat, lng)) return json({ error: "Bad GPS position" }, 400);
  const { data: hospital } = await admin
    .from("hospitals").select("id, lat, lng").eq("id", String(body.hospital_id ?? "")).maybeSingle();
  if (!hospital) return json({ error: "Unknown destination" }, 400);

  const isStart = body.start === true;
  const continuing = !isStart && prev?.status === "enroute" && !!prev.transport_id &&
    prev.hospital_id === hospital.id;
  const defaultMode = await agencyDefaultMode(agencyId);
  // Trial arm: fixed for the whole transport (a config change applies from the next one)
  const shadow = continuing ? !!prev.shadow : await shadowSetting(unitId);

  // On scene until the phone reports it has started driving; then stays transporting
  let phase = continuing ? (prev.phase ?? "transporting") : "onscene";
  const leftSceneNow = phase === "onscene" && body.moving === true;
  if (leftSceneNow) phase = "transporting";

  // Cost guard: reuse the last ETA if it's very recent (but never delay the "started driving" update)
  if (continuing && !leftSceneNow) {
    const ageS = (now.getTime() - Date.parse(prev.updated_at)) / 1000;
    if (ageS < MIN_GOOGLE_INTERVAL_S) {
      const elapsed = phase === "transporting" ? ageS : 0;
      return json({
        ...etaFields(prev.eta_google_seconds - elapsed, prev.driving_mode ?? "unknown", defaultMode),
        phase,
        shadow,
        distance_m: prev.distance_m,
        eta_source: prev.eta_source,
        reused: true,
      });
    }
  }

  // A new transport closes any earlier one that never recorded an arrival
  if (!continuing && prev?.transport_id && prev.status === "enroute") {
    await admin.from("transports")
      .update({ status: "abandoned", ended_at: now.toISOString() })
      .eq("id", prev.transport_id).is("arrived_at", null);
  }

  // ---- Google ETA ----
  let route;
  try {
    route = await googleRoute(lat, lng, hospital.lat, hospital.lng);
  } catch (e) {
    console.error("Google Routes failed, using estimate:", e);
    route = straightLineEstimate(lat, lng, hospital.lat, hospital.lng);
  }
  const etaGoogle = Math.round(route.seconds);
  const distanceM = Math.round(route.meters);

  // ---- Transport record ----
  let transportId: string = continuing ? prev.transport_id : "";
  if (!continuing) {
    const { data: t, error } = await admin.from("transports").insert({
      unit_id: unitId,
      hospital_id: hospital.id,
      started_at: now.toISOString(),
      start_lat: lat,
      start_lng: lng,
      first_eta_google_s: etaGoogle,
      first_distance_m: distanceM,
      agency_id: agencyId,
      default_mode: defaultMode,
      shadow,
      started_by: body.started_by === "ed" ? "ed" : "crew",
      left_scene_at: phase === "transporting" ? now.toISOString() : null,
    }).select("id").single();
    if (error) return json({ error: error.message }, 500);
    transportId = t.id;
  } else if (leftSceneNow) {
    await admin.from("transports").update({ left_scene_at: now.toISOString() })
      .eq("id", transportId).is("left_scene_at", null);
  }

  // ---- Driving mode detection (only while transporting) ----
  // Starts from the agency default, so e.g. a Seattle Fire unit needs clear
  // evidence before it's treated as driving without lights & sirens.
  let mode: string = continuing ? (prev.driving_mode ?? "unknown") : "unknown";
  let ratio: number | null = null;
  if (continuing && phase === "transporting" && route.source === "google") {
    const { data: past } = await admin.from("eta_samples")
      .select("recorded_at, eta_google_s")
      .eq("transport_id", transportId)
      .eq("eta_source", "google")
      .eq("phase", "transporting")
      .gte("recorded_at", new Date(now.getTime() - LS_WINDOW_MAX_S * 1000).toISOString())
      .lte("recorded_at", new Date(now.getTime() - LS_WINDOW_MIN_S * 1000).toISOString())
      .order("recorded_at", { ascending: true })
      .limit(1);
    if (past?.length) {
      const dtS = (now.getTime() - Date.parse(past[0].recorded_at)) / 1000;
      ratio = (past[0].eta_google_s - etaGoogle) / dtS;
      const prior = mode === "unknown" ? defaultMode : mode;
      if (prior === "ls") mode = ratio < LS_EXIT_RATIO ? "normal" : "ls";
      else mode = ratio > LS_ENTER_RATIO ? "ls" : "normal";
    }
  }

  const etas = etaFields(etaGoogle, mode, defaultMode);

  // ---- Raw history sample ----
  const { error: sErr } = await admin.from("eta_samples").insert({
    transport_id: transportId,
    recorded_at: now.toISOString(),
    lat,
    lng,
    gps_accuracy_m: numOrNull(body.accuracy_m),
    distance_m: distanceM,
    eta_google_s: etas.eta_google_seconds,
    eta_ls_s: etas.eta_ls_seconds,
    eta_best_s: etas.eta_seconds,
    ls_factor: LS_TIME_FACTOR,
    driving_mode: mode,
    progress_ratio: ratio == null ? null : Math.round(ratio * 1000) / 1000,
    eta_source: route.source,
    phase,
    motion_state: continuing ? prev.motion_state ?? null : null,
  });
  if (sErr) console.error("eta_samples insert failed:", sErr);

  // ---- Live row (what the ED board and Provider app see) ----
  const row: Record<string, unknown> = {
    unit_id: unitId,
    hospital_id: hospital.id,
    status: "enroute",
    lat,
    lng,
    ...etas,
    distance_m: distanceM,
    eta_source: route.source,
    route_polyline: route.polyline ?? null,   // road route to the hospital (MSO map)
    transport_id: transportId,
    agency_id: agencyId,
    shadow,
    phase,
    arrived_at: null,
    doors_at: null,
    updated_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    // Starting a transport puts the unit in service (keeps an active special event)
    ...serviceOnActivity(prev, unitId, now, true),
  };
  if (!continuing) {
    // New transport: fresh on-scene clock, no movement yet, clear any old trauma code
    // and any "marked transporting by the ED" request (the phone has taken over)
    Object.assign(row, {
      trauma_level: null, trauma_id: null, trauma_set_at: null,
      transport_started_at: now.toISOString(),
      motion_state: phase === "transporting" ? "moving" : null,
      motion_since: phase === "transporting" ? now.toISOString() : null,
      current_stop_id: null,
      ed_request_hospital_id: null, ed_request_at: null, ed_request_by: null,
    });
  } else if (leftSceneNow) {
    Object.assign(row, { motion_state: "moving", motion_since: now.toISOString() });
  }

  const { error } = await admin.from("units").upsert(row);
  if (error) return json({ error: error.message }, 500);
  return json(row);
}

// ---------------------------------------------------------------------------
async function arrived(unitId: string, prev: any, body: any, now: Date) {
  const method = body.method === "auto" ? "auto" : "button";
  // For automatic arrival, back-date to when the GPS fix was taken
  // (age_ms is measured on the phone, so phone/server clock differences don't matter).
  const ageMs = method === "auto" ? Math.min(Math.max(Number(body.age_ms) || 0, 0), 120000) : 0;
  const arrivedAt = new Date(now.getTime() - ageMs);

  const { error } = await admin.from("units")
    .update({
      status: "arrived",
      arrived_at: arrivedAt.toISOString(),
      doors_at: null,
      eta_seconds: 0, eta_google_seconds: 0, eta_ls_seconds: 0,
      updated_at: now.toISOString(),
      last_seen_at: now.toISOString(),
    })
    .eq("unit_id", unitId);
  if (error) return json({ error: error.message }, 500);

  if (prev?.transport_id && prev.status === "enroute") {
    // Close a stop still open at arrival
    await admin.from("transport_stops").update({ ended_at: arrivedAt.toISOString() })
      .eq("transport_id", prev.transport_id).is("ended_at", null);
    await admin.from("units").update({ motion_state: null, motion_since: null, current_stop_id: null })
      .eq("unit_id", unitId);
    const { data: hospital } = await admin
      .from("hospitals").select("lat, lng, arrival_radius_m").eq("id", prev.hospital_id).maybeSingle();
    const lat = Number(body.lat), lng = Number(body.lng);
    const hasPos = validLatLng(lat, lng);
    await admin.from("transports").update({
      status: "arrived",
      arrived_at: arrivedAt.toISOString(),
      ended_at: now.toISOString(),
      arrival_method: method,
      arrival_lat: hasPos ? lat : null,
      arrival_lng: hasPos ? lng : null,
      arrival_distance_m: hasPos && hospital ? Math.round(haversine(lat, lng, hospital.lat, hospital.lng)) : null,
      arrival_radius_m: hospital?.arrival_radius_m ?? null,
      closest_approach_m: numOrNull(body.closest_approach_m, true),
      final_driving_mode: prev.driving_mode ?? null,
    }).eq("id", prev.transport_id).is("arrived_at", null);
  }
  return json({ ok: true, unit_id: unitId, method, arrived_at: arrivedAt.toISOString() });
}

// ---------------------------------------------------------------------------
// Drove away from the hospital after arriving → drops off the ED board
async function departed(unitId: string, prev: any, now: Date) {
  if (prev?.status !== "arrived") return json({ ok: true, ignored: true });
  const { error } = await admin.from("units")
    .update({ status: "departed", updated_at: now.toISOString(), last_seen_at: now.toISOString() })
    .eq("unit_id", unitId).eq("status", "arrived");
  if (error) return json({ error: error.message }, 500);
  if (prev.transport_id) {
    await admin.from("transports").update({ departed_at: now.toISOString() })
      .eq("id", prev.transport_id).is("departed_at", null);
  }
  return json({ ok: true, unit_id: unitId });
}

// ---------------------------------------------------------------------------
// Movement during a transport: moving / stopped / stopped_care (possibly patient care).
// Sent by the phone the moment it changes. Never touches the ETA (updated_at).
async function motion(prev: any, body: any, now: Date) {
  const state = ["moving", "stopped", "stopped_care"].includes(body.motion_state) ? body.motion_state : null;
  if (!state) return json({ error: "Bad motion state" }, 400);
  if (prev?.status !== "enroute" || prev.phase !== "transporting" || !prev.transport_id) {
    return json({ ok: true, ignored: true });
  }
  const ageMs = Math.min(Math.max(Number(body.since_age_ms) || 0, 0), 30 * 60 * 1000);
  const since = new Date(now.getTime() - ageMs).toISOString();
  const lat = Number(body.lat), lng = Number(body.lng);
  const hasPos = validLatLng(lat, lng);

  const update: Record<string, unknown> = {
    motion_state: state,
    last_seen_at: now.toISOString(),
    ...(hasPos ? { lat, lng } : {}),
  };
  const wasStopped = prev.motion_state === "stopped" || prev.motion_state === "stopped_care";
  const isStopped = state !== "moving";

  if (isStopped && !wasStopped) {
    // A new stop begins
    const { data: stop } = await admin.from("transport_stops").insert({
      transport_id: prev.transport_id,
      started_at: since,
      lat: hasPos ? lat : prev.lat,
      lng: hasPos ? lng : prev.lng,
      likely_care: state === "stopped_care",
    }).select("id").single();
    Object.assign(update, { motion_since: since, current_stop_id: stop?.id ?? null });
  } else if (isStopped && wasStopped) {
    // Same stop; it may have been upgraded to "possibly patient care"
    if (state === "stopped_care" && prev.current_stop_id) {
      await admin.from("transport_stops").update({ likely_care: true }).eq("id", prev.current_stop_id);
    }
  } else if (!isStopped && wasStopped) {
    // Moving again: close the stop
    if (prev.current_stop_id) {
      await admin.from("transport_stops").update({ ended_at: since }).eq("id", prev.current_stop_id);
    }
    Object.assign(update, { motion_since: since, current_stop_id: null });
  } else if (!prev.motion_since) {
    update.motion_since = since;
  }

  const { error } = await admin.from("units").update(update).eq("unit_id", prev.unit_id);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, motion_state: state });
}

// ---------------------------------------------------------------------------
// Check-in between transports: keeps the unit in service and its position current
// for the MSO. Never touches an active transport's ETA (updated_at).
async function heartbeat(unitId: string, agencyId: string | null, prev: any, body: any, now: Date) {
  const lat = Number(body.lat), lng = Number(body.lng);
  const row: Record<string, unknown> = {
    unit_id: unitId,
    agency_id: agencyId,
    last_seen_at: now.toISOString(),
    // First check-in ever, or an expired special event → in service. Never overrides
    // an out-of-service set by the crew or MSO.
    ...serviceOnActivity(prev, unitId, now, false),
  };
  if (validLatLng(lat, lng)) Object.assign(row, { lat, lng });
  // Not on a transport (or never was): available, no destination
  if (!prev || !prev.status || prev.status === "departed" || prev.status === "available") {
    Object.assign(row, { status: "available", hospital_id: null, phase: null });
    if (!prev) row.updated_at = now.toISOString();
  }
  // Between transports, pick up the current trial setting
  if (prev?.status !== "enroute" && prev?.status !== "arrived") row.shadow = await shadowSetting(unitId);
  const { error } = await admin.from("units").upsert(row);
  if (error) return json({ error: error.message }, 500);
  return json({
    ok: true, unit_id: unitId, status: row.status ?? prev?.status,
    shadow: (row.shadow ?? prev?.shadow) === true,
  });
}

// Service status changes caused by the unit's own activity
function serviceOnActivity(prev: any, unitId: string, now: Date, overrideOutOfService: boolean) {
  const st = prev?.service_status ?? null;
  const specialActive = st === "special_event" && prev?.special_event_until &&
    Date.parse(prev.special_event_until) > now.getTime();
  if (st === "in_service" || specialActive) return {};
  if (st === "out_of_service" && !overrideOutOfService) return {};
  return {
    service_status: "in_service",
    service_changed_at: now.toISOString(),
    service_changed_by: st === "special_event" ? "Special event ended" : unitId,
    special_event_until: null,
    ...(st === "special_event" ? {} : { in_service_since: now.toISOString() }),
  };
}

// ---------------------------------------------------------------------------
// MSO: ETA from the MSO's own position to one of their agency's units
async function msoEta(agencyId: string | null, body: any) {
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!validLatLng(lat, lng)) return json({ error: "Bad GPS position" }, 400);
  const { data: u } = await admin.from("units")
    .select("unit_id, agency_id, lat, lng").eq("unit_id", String(body.unit_id ?? "")).maybeSingle();
  if (!u || !agencyId || u.agency_id !== agencyId) return json({ error: "Unit not found" }, 404);
  if (u.lat == null || u.lng == null) return json({ error: "That unit has no location yet" }, 400);

  let route;
  try {
    route = await googleRoute(lat, lng, u.lat, u.lng);
  } catch (e) {
    console.error("Google Routes failed, using estimate:", e);
    route = straightLineEstimate(lat, lng, u.lat, u.lng);
  }
  const g = Math.round(route.seconds);
  return json({
    unit_id: u.unit_id,
    unit_lat: u.lat,
    unit_lng: u.lng,
    eta_google_seconds: g,
    eta_ls_seconds: Math.round(g * LS_TIME_FACTOR),
    ls_factor: LS_TIME_FACTOR,
    distance_m: Math.round(route.meters),
    eta_source: route.source,
    route_polyline: route.polyline ?? null,
  });
}

// ---------------------------------------------------------------------------
// Shadow mode (admin setting in unit_config): recorded, but hidden from the ED
async function shadowSetting(unitId: string) {
  const { data } = await admin.from("unit_config").select("shadow").eq("unit_id", unitId).maybeSingle();
  return data?.shadow === true;
}

async function agencyDefaultMode(agencyId: string | null) {
  if (!agencyId) return "normal";
  const { data } = await admin.from("agencies").select("default_driving_mode").eq("id", agencyId).maybeSingle();
  return data?.default_driving_mode === "ls" ? "ls" : "normal";
}

// Both ETAs, plus the "best" one (eta_seconds) shown to the ED:
// the detected mode once known, otherwise the agency default.
function etaFields(googleSeconds: number, mode: string, defaultMode: string) {
  const g = Math.max(0, Math.round(googleSeconds));
  const ls = Math.round(g * LS_TIME_FACTOR);
  const effective = mode === "unknown" ? defaultMode : mode;
  return {
    eta_google_seconds: g,
    eta_ls_seconds: ls,
    eta_seconds: effective === "ls" ? ls : g,
    driving_mode: mode,
    default_mode: defaultMode,
  };
}

async function googleRoute(
  fromLat: number, fromLng: number, toLat: number, toLng: number,
): Promise<{ seconds: number; meters: number; source: string; polyline?: string | null }> {
  const key = Deno.env.get("GOOGLE_ROUTES_KEY");
  if (!key) throw new Error("GOOGLE_ROUTES_KEY secret is not set");
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
      destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const r = data.routes?.[0];
  if (!r?.duration) throw new Error("Google returned no route");
  // duration comes back like "734s"
  return {
    seconds: parseInt(r.duration, 10),
    meters: r.distanceMeters ?? 0,
    source: "google",
    polyline: r.polyline?.encodedPolyline ?? null,
  };
}

function straightLineEstimate(lat1: number, lng1: number, lat2: number, lng2: number) {
  const meters = haversine(lat1, lng1, lat2, lng2) * ROAD_FACTOR;
  return { seconds: meters / FALLBACK_SPEED_MPS, meters, source: "estimate" };
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function validLatLng(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function numOrNull(v: unknown, round = false) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return round ? Math.round(n) : n;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
