// ETA Beacon — "eta" Edge Function
//
// Called by a signed-in rig phone with its GPS position and destination.
// 1. Checks the caller is a rig account (and which unit it is).
// 2. Asks Google Routes for a traffic-aware driving ETA (key stays secret here).
// 3. Saves the unit's position + ETA to the database (ED boards get it live).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GOOGLE_ROUTES_KEY   Google API key restricted to the Routes API
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

// Cost guard: never call Google for the same unit more often than this,
// even if a phone sends updates faster than expected.
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
      .from("accounts").select("role, unit_id").eq("user_id", user.id).maybeSingle();
    if (!acct || acct.role !== "rig") return json({ error: "This login is not a rig account" }, 403);
    const unitId: string = acct.unit_id;

    const body = await req.json().catch(() => ({}));
    const now = new Date();

    // ---- Arrived ----
    if (body.action === "arrived") {
      const { error } = await admin.from("units")
        .update({ status: "arrived", eta_seconds: 0, updated_at: now.toISOString() })
        .eq("unit_id", unitId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, unit_id: unitId });
    }

    // ---- Position update ----
    const lat = Number(body.lat), lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return json({ error: "Bad GPS position" }, 400);
    }
    const { data: hospital } = await admin
      .from("hospitals").select("id, lat, lng").eq("id", String(body.hospital_id ?? "")).maybeSingle();
    if (!hospital) return json({ error: "Unknown destination" }, 400);

    // Cost guard: reuse the last ETA if it's very recent
    const { data: prev } = await admin.from("units").select("*").eq("unit_id", unitId).maybeSingle();
    if (prev && prev.status === "enroute" && prev.hospital_id === hospital.id) {
      const ageS = (now.getTime() - Date.parse(prev.updated_at)) / 1000;
      if (ageS < MIN_GOOGLE_INTERVAL_S) {
        return json({
          unit_id: unitId,
          eta_seconds: Math.max(0, Math.round(prev.eta_seconds - ageS)),
          distance_m: prev.distance_m,
          eta_source: prev.eta_source,
          reused: true,
        });
      }
    }

    let route;
    try {
      route = await googleRoute(lat, lng, hospital.lat, hospital.lng);
    } catch (e) {
      console.error("Google Routes failed, using estimate:", e);
      route = straightLineEstimate(lat, lng, hospital.lat, hospital.lng);
    }

    const row: Record<string, unknown> = {
      unit_id: unitId,
      hospital_id: hospital.id,
      status: "enroute",
      lat,
      lng,
      eta_seconds: Math.round(route.seconds),
      distance_m: Math.round(route.meters),
      eta_source: route.source,
      updated_at: now.toISOString(),
    };
    // New transport (or diverted to a different hospital): clear any old trauma code.
    // Otherwise the ED's trauma code is left untouched.
    if (!prev || prev.status !== "enroute" || prev.hospital_id !== hospital.id) {
      Object.assign(row, { trauma_level: null, trauma_id: null, trauma_set_at: null });
    }
    const { error } = await admin.from("units").upsert(row);
    if (error) return json({ error: error.message }, 500);
    return json(row);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error" }, 500);
  }
});

async function googleRoute(fromLat: number, fromLng: number, toLat: number, toLng: number) {
  const key = Deno.env.get("GOOGLE_ROUTES_KEY");
  if (!key) throw new Error("GOOGLE_ROUTES_KEY secret is not set");
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
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
  return { seconds: parseInt(r.duration, 10), meters: r.distanceMeters ?? 0, source: "google" };
}

function straightLineEstimate(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  const meters = 2 * R * Math.asin(Math.sqrt(a)) * ROAD_FACTOR;
  return { seconds: meters / FALLBACK_SPEED_MPS, meters, source: "estimate" };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
