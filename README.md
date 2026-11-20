# ETA Beacon — MVP

Live ETAs from ambulances to emergency departments.

## Architecture

```
 Crew phone (crew.html)                Supabase (hosted Postgres)              ED screen (ed.html)
 ──────────────────────                ──────────────────────────              ───────────────────
 GPS every 15 s ──► OSRM routing ──►   units table (1 row per unit)  ──push──►  live list sorted by ETA
                    (drive time)       upsert: location, ETA, status   (realtime) + map, countdown ticks
                                                                                 between updates
```

- **Frontend:** plain HTML/CSS/JavaScript — no build step. Hosted free on GitHub Pages (https is required for phone GPS).
- **Backend:** Supabase — database + realtime push. No server code to write.
- **ETA:** OSRM public demo server (free, no key, no live traffic). Swap for Google Routes / Mapbox later.
- **Map:** Leaflet + OpenStreetMap tiles.
- **No patient data** is stored — only unit name, destination, location, ETA, status.

## Files

| File | What it does |
|---|---|
| `config.js` | Your Supabase keys + hospital list (edit this) |
| `setup.sql` | Creates the database table (run once in Supabase) |
| `crew.html` / `crew.js` | Ambulance app: pick unit + destination, sends GPS + ETA |
| `ed.html` / `ed.js` | ED board: live inbound list + map |
| `eta.js` | Routing/ETA helpers shared by both |
| `index.html`, `style.css` | Landing page and styling |

## Known MVP limits (fix before any real use)
- Anyone with the public key can read/write the table → add logins + per-agency rules.
- Phone must keep the screen on (web pages pause when locked) → native app later.
- ETAs ignore traffic and lights-and-sirens speeds → calibrate with logged predicted vs actual times.
