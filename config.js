// ===== ETA Beacon settings =====
// Everything in this file is public (it ships to the browser). That's OK:
// the database is locked to signed-in accounts, and the Google browser key
// is restricted to this site's address in Google Cloud.

// Supabase: Project Settings → API (the "publishable" key — never the secret key)
export const SUPABASE_URL = "https://zzwjxlmnfjujyzgdfdte.supabase.co";
export const SUPABASE_KEY = "sb_publishable_VcppjE49WaCFVIkkg0NIkg_dcH4drqg";

// Google Maps (ED board map). Google Cloud → APIs & Services → Credentials.
// Restrict this key to "Maps JavaScript API" + your site (https://cal42.github.io/*).
export const GOOGLE_MAPS_BROWSER_KEY = "AIzaSyB-N73Z9fqa-ycqZISGvjj042COgpJEbDE";
// Map ID (Google Cloud → Google Maps Platform → Map management). "DEMO_MAP_ID" works for testing.
export const GOOGLE_MAP_ID = "DEMO_MAP_ID";

// How often the rig phone sends a position + ETA update (milliseconds)
export const UPDATE_INTERVAL_MS = 60000;

// Hospitals now live in the database (hospitals table) — see setup.sql.
