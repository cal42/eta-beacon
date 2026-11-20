# ETA Beacon

Live, traffic-aware ETAs from Seattle Fire medic units to Seattle emergency departments.

## Architecture

```
 Rig phone (ems.html)           Supabase                                   ED screen (ed.html)
 ─────────────────────          ────────                                   ───────────────────
 signed in as its unit   ──►    "eta" Edge Function                        signed in as its ED
 GPS every 60 s                   ├─ checks the login is a rig             Google map + traffic layer
                                  ├─ Google Routes API (traffic-aware) ──►  live list sorted by ETA,
                                  └─ saves to units table ──push──►         countdown between updates
                                                                            ED taps Modified / Full trauma
                                                         set_trauma() ◄──── (two taps to confirm)
                                                              │
                                                              └──push──►   Provider app (provider.html)
                                                                           physicians: alarm + live ETA,
                                                                           "I'm responding" → shown to ED
```

- **Frontend:** plain HTML/CSS/JavaScript, no build step, hosted on GitHub Pages (https is required for phone GPS).
- **Backend:** Supabase. Database, logins, live updates, and one Edge Function (`supabase/functions/eta`).
- **ETA:** Google Routes API with `TRAFFIC_AWARE` routing, called only from the Edge Function so the key stays secret. If Google is unreachable, a straight-line estimate is used and labelled "rough estimate".
- **Map:** Google Maps JavaScript API with the traffic layer.
- **On scene, then transporting:** after the crew picks a destination, the ED sees "On scene · 12 min away". Once the phone has moved 100 m, the ED sees a counting-down ETA with "TRANSPORTING" below it.
- **Two ETAs:** the EMS app shows "No lights & sirens" (Google's ETA) and "Lights & sirens" (currently assumed 25% faster), plus the time difference. The app detects which mode the unit is driving in, and the ED sees the matching ETA. Until the mode is detected, the ED sees the agency's default (`agencies.default_driving_mode`): Seattle Fire = lights & sirens.
- **Automatic arrival and departure:** the rig phone records arrival within `hospitals.arrival_radius_m` (50 m) of the ED entrance; the Arrived button remains as a backup. The ED card then counts up ("ARRIVED · 5:23 ago") until the rig drives beyond `hospitals.departure_radius_m` (100 m), when it drops off the board.
- **No patient data** is stored. The app keeps only the unit name, destination, location, ETA and status.

## Security model
- The public (publishable) key alone can't read or write anything.
- Every device has its own login, entered once at setup and then remembered:
  - **Rig accounts:** one per rig phone, tied to a unit (e.g. `M10`). A rig can't write to the database directly; it can only send its position to the Edge Function, which decides which unit it is from the login.
  - **ED accounts:** one per ED screen, tied to a hospital. They can only see units headed to that hospital, and only they can set a trauma code.
  - **Provider accounts:** one per physician, tied to a hospital and a display name (e.g. "Dr. Lee"). They see units headed to their hospital and can mark themselves as responding.
- If a phone is lost, delete or reset its user in Supabase → Authentication.

## Files

| File | What it does |
|---|---|
| `config.js` | Supabase URL and publishable key, Google Maps browser key, update interval |
| `setup.sql` | Tables, security rules, hospital list (safe to re-run) |
| `supabase/functions/eta/index.ts` | Edge Function: checks the login, gets the Google ETA, saves the update |
| `auth.js` | Shared sign-in |
| `ems.html` / `ems.js` | Rig phone: pick destination, sends GPS every minute |
| `ed.html` / `ed.js` | ED board: live inbound list + Google map, sets Modified/Full trauma codes |
| `provider.html` / `provider.js` | Provider app: trauma alarms, live ETA, "I'm responding" |
| `eta.js` | Display helpers |

## Setup

### 1. Google Cloud (project `eta-beacon-515306`)
1. Make sure billing is enabled on the project.
2. APIs & Services → Library → enable **Routes API** and **Maps JavaScript API**.
3. APIs & Services → Credentials → Create credentials → API key, twice:
   - **Server key:** API restrictions → Routes API only. Leave application restrictions as None. This key goes into Supabase and must never be put in this repo.
   - **Browser key:** API restrictions → Maps JavaScript API only. Application restrictions → Websites → `https://cal42.github.io/*` (plus `http://localhost:*/*` for local testing). Paste it into `config.js` as `GOOGLE_MAPS_BROWSER_KEY`.
4. Optional: set a budget alert under Billing → Budgets & alerts.

### 2. Supabase database
1. SQL Editor → paste all of `setup.sql` → Run.
2. Authentication → Sign In / Providers → turn **off** "Allow new users to sign up", so only you can create accounts.

### 3. Edge Function
1. Edge Functions → Secrets → add `GOOGLE_ROUTES_KEY` = the **server** key.
2. Edge Functions → Deploy a new function → Via editor → name it `eta` → paste `supabase/functions/eta/index.ts` → Deploy.
3. In the function's settings, turn **off** "Verify JWT" (also called "Enforce JWT verification"). The function checks logins itself.

(Alternatively, with the Supabase CLI: `supabase link --project-ref zzwjxlmnfjujyzgdfdte`, then `supabase functions deploy eta`.)

### 4. Create device logins
For each rig phone, ED screen and provider: Authentication → Users → Add user → Create new user (tick Auto Confirm), then link it to a unit or hospital using the SQL at the bottom of `setup.sql`.

## ETA accuracy data
Every transport and every ETA is recorded raw so a correction factor can be built later. Only you can read this data, through the Supabase dashboard; no app login can.

| Table / view | Contents |
|---|---|
| `transports` | One row per transport: start, first ETA, arrival time, arrival method (`auto` geofence or `button`), closest approach to the entrance, trauma level, final driving mode |
| `eta_samples` | One row per ETA (≈ every minute): position, GPS accuracy and speed, Google ETA, lights-and-sirens ETA, ETA shown to the ED, detected mode, progress ratio |
| `eta_accuracy` | View joining the two for completed transports: actual time remaining vs. each prediction (`google_error_s`, `ls_error_s`, `best_error_s`, positive = arrived later than predicted), `actual_over_google`, local hour and weekday |

To use it: in Supabase → SQL Editor, run `select * from eta_accuracy`, then **Export → CSV** for Excel or Google Sheets. There are example queries at the bottom of `setup.sql`.

**Driving-mode detection:** every minute the Edge Function compares how fast Google's ETA has fallen over the last 2–5 minutes with how much time has passed (`progress_ratio`). About 1.0 means driving with traffic; about 1.33 means the 25%-faster lights-and-sirens pace. Above 1.2 switches the mode to lights and sirens, and below 1.1 switches back. The 0.75 factor and these thresholds are constants at the top of `supabase/functions/eta/index.ts`, and each sample records the factor that was in effect.

**Geofence radii:** change them per hospital, e.g. `update hospitals set arrival_radius_m = 75, departure_radius_m = 150 where id = 'HMC';`. The phone picks up the new values the next time the EMS page loads.

**Agencies:** add one with `insert into agencies values ('AMR', 'AMR', 'normal');`, and set a rig's agency with `agency_id` in `accounts`. `transports` also records scene time (`left_scene_at`) and time at the hospital (`departed_at`).

## Trauma codes
- The ED taps **Modified** or **Full** on an inbound unit, then taps again to confirm. **Cancel** clears the code. Changing Modified to Full counts as a new activation and alerts providers again.
- Signed-in providers at that hospital get a repeating alarm (louder and faster for Full), vibration where supported, a flashing card with the live ETA, and a system notification if the tab is in the background (where the browser allows it).
- **I'm responding** stops the alarm and shows the provider's name on the ED board and to the other providers. **Silence** stops the sound without responding.
- A unit's trauma code clears automatically when it starts its next transport.

## Costs (Google)
Traffic-aware Routes calls are billed as "Compute Routes Pro": 5,000 free per month, then about $10 per 1,000. Rough cost: one call per minute per transporting unit, so a 15-minute transport ≈ 15 calls. The Edge Function never calls Google more than once every 45 seconds per unit. The ED map is billed separately as Maps JavaScript API map loads, and each ED screen only loads the map once.

## Known limits / next steps
- Provider alerts only sound while the Provider page is open and the screen is on, because a web page can't wake a locked phone. Real lock-screen alerts need Web Push (an installed web app) or a native app, SMS, or pager integration.
- The rig phone must keep the screen on (web pages pause when locked). A native app is planned.
- Google ETAs assume normal driving, not lights-and-sirens, so they should be calibrated against logged predicted vs. actual arrival times.
