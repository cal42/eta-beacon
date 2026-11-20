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
