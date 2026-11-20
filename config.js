// ===== ETA Beacon settings =====
// 1) Paste these from Supabase: Project Settings → API
//    (use the "anon" / "publishable" key — never the "service_role" / secret key)
export const SUPABASE_URL = "https://zzwjxlmnfjujyzgdfdte.supabase.co";
export const SUPABASE_KEY = "sb_publishable_VcppjE49WaCFVIkkg0NIkg_dcH4drqg";

// 2) Destinations. Get exact coordinates in Google Maps:
//    right-click the ED ambulance entrance → click the numbers at the top to copy them.
//    The coordinates below are rough placeholders — replace them.
export const HOSPITALS = [
  { id: "HMC", name: "Harborview ED", lat: 47.60463, lng: -122.32421 },
  { id: "test",      name: "Test destination",      lat: 36.9741, lng: -122.0308 },
];

// How often the crew app sends a position + ETA update (milliseconds)
export const UPDATE_INTERVAL_MS = 15000;
