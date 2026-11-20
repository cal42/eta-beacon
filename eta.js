// Display helpers shared by the EMS app and ED board.
// (Routing now happens server-side in supabase/functions/eta.)

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
