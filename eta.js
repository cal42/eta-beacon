// Display helpers shared by the EMS app and ED board.
// (Routing now happens server-side in supabase/functions/eta.)

export function formatEta(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "--";
  if (seconds <= 30) return "Arriving";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Straight-line distance between two GPS points, in meters
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const MODE_LABELS = { ls: "lights & sirens", normal: "driving with traffic", unknown: "detecting…" };

export const TRAUMA_LABELS = { modified: "MODIFIED TRAUMA", full: "FULL TRAUMA" };

// Who is responding to a trauma activation, from trauma_acks rows
export function respondersText(acks) {
  if (!acks || !acks.length) return "No providers responding yet";
  return `Responding: ${acks.map((a) => a.display_name).join(", ")}`;
}

export function formatMiles(meters) {
  if (meters == null) return "";
  return `${(meters / 1609.34).toFixed(1)} mi`;
}

// ---- Live unit status shared by the ED board, Provider app and MSO view ----

const isStopped = (r) => r.motion_state === "stopped" || r.motion_state === "stopped_care";

// Seconds left on the ETA right now. Counts down between updates while moving; pauses
// while the unit is stopped (e.g. patient care) or still on scene.
export function etaLeftSeconds(r) {
  if (r.phase === "onscene") return r.eta_seconds ?? 0;
  let end = Date.now();
  if (isStopped(r) && r.motion_since) end = Math.min(end, Date.parse(r.motion_since));
  const elapsed = Math.max(0, (end - Date.parse(r.updated_at)) / 1000);
  return Math.max(0, (r.eta_seconds ?? 0) - elapsed);
}

// "5:23" / "1:02:09" since a time
export function countUp(fromIso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(sec).padStart(2, "0")}`;
}

// The status line under the ETA for an en-route unit: { text, cls }
export function movementLine(r) {
  if (r.eta_source === "radio" && !r.transport_id) {
    return { text: "TRANSPORTING · RADIO ETA (no live GPS)", cls: "phase transporting" };
  }
  if (r.phase === "onscene") {
    return {
      text: `STILL ON SCENE${r.transport_started_at ? ` · ${countUp(r.transport_started_at)}` : ""}`,
      cls: "phase onscene",
    };
  }
  if (r.motion_state === "stopped_care") {
    return {
      text: `STOPPED ${r.motion_since ? countUp(r.motion_since) : ""} · POSSIBLY PATIENT CARE`,
      cls: "phase stopped care",
    };
  }
  if (r.motion_state === "stopped") {
    return { text: `STOPPED ${r.motion_since ? countUp(r.motion_since) : ""}`, cls: "phase stopped" };
  }
  return { text: "TRANSPORTING · MOVING", cls: "phase transporting" };
}

// Arrived unit: "on the ramp" (geofence) until the charge nurse marks "through the doors"
export function arrivalLine(r) {
  if (r.doors_at) return { text: `THROUGH THE DOORS · ${countUp(r.doors_at)}`, cls: "phase arrived doors" };
  return { text: `ON THE RAMP · ${countUp(r.arrived_at ?? r.updated_at)}`, cls: "phase arrived ramp" };
}
