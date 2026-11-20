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
```

- **Frontend:** plain HTML/CSS/JavaScript, no build step, hosted on GitHub Pages (https is required for phone GPS).
- **Backend:** Supabase. Database, logins, live updates, and one Edge Function (`supabase/functions/eta`).
- **ETA:** Google Routes API with `TRAFFIC_AWARE` routing, called only from the Edge Function so the key stays secret. If Google is unreachable, a straight-line estimate is used and labelled "rough estimate".
- **Map:** Google Maps JavaScript API with the traffic layer.
- **No patient data** is stored. The app keeps only the unit name, destination, location, ETA and status.

## Security model
- The public (publishable) key alone can't read or write anything.
- Every device has its own login, entered once at setup and then remembered:
  - **Rig accounts:** one per rig phone, tied to a unit (e.g. `M10`). A rig can't write to the database directly; it can only send its position to the Edge Function, which decides which unit it is from the login.
  - **ED accounts:** one per ED screen, tied to a hospital. They can only see units headed to that hospital.
- If a phone is lost, delete or reset its user in Supabase → Authentication.

## Files

| File | What it does |
|---|---|
| `config.js` | Supabase URL and publishable key, Google Maps browser key, update interval |
| `setup.sql` | Tables, security rules, hospital list (safe to re-run) |
| `supabase/functions/eta/index.ts` | Edge Function: checks the login, gets the Google ETA, saves the update |
| `auth.js` | Shared sign-in |
| `ems.html` / `ems.js` | Rig phone: pick destination, sends GPS every minute |
| `ed.html` / `ed.js` | ED board: live inbound list + Google map |
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
For each rig phone and ED screen: Authentication → Users → Add user → Create new user (tick Auto Confirm), then link it to a unit or hospital using the SQL at the bottom of `setup.sql`.

## Costs (Google)
Traffic-aware Routes calls are billed as "Compute Routes Pro": 5,000 free per month, then about $10 per 1,000. Rough cost: one call per minute per transporting unit, so a 15-minute transport ≈ 15 calls. The Edge Function never calls Google more than once every 45 seconds per unit. The ED map is billed separately as Maps JavaScript API map loads, and each ED screen only loads the map once.

## Known limits / next steps
- The rig phone must keep the screen on (web pages pause when locked). A native app is planned.
- Google ETAs assume normal driving, not lights-and-sirens, so they should be calibrated against logged predicted vs. actual arrival times.
