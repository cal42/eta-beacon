// Calculates a driving ETA using OSRM's free public demo server
// (no API key needed, but it has no live traffic and isn't for heavy use).
// If routing fails, falls back to a rough straight-line estimate.

const FALLBACK_SPEED_MPS = 13; // ≈ 30 mph average
const ROAD_FACTOR = 1.3;       // roads are ~30% longer than a straight line

export async function getRoute(fromLat, fromLng, toLat, toLng) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.code === "Ok" && data.routes && data.routes.length) {
      return { seconds: data.routes[0].duration, meters: data.routes[0].distance, estimated: false };
    }
  } catch (e) {
    console.warn("Routing failed, using straight-line estimate", e);
  }
  const meters = haversineMeters(fromLat, fromLng, toLat, toLng) * ROAD_FACTOR;
  return { seconds: meters / FALLBACK_SPEED_MPS, meters, estimated: true };
}

// Straight-line distance between two GPS points, in meters
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatEta(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "--";
  if (seconds <= 30) return "Arriving";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function formatMiles(meters) {
  if (meters == null) return "";
  return `${(meters / 1609.34).toFixed(1)} mi`;
}
