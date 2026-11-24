// Unit service status helpers shared by the EMS app and MSO view.
// Statuses: 'in_service' | 'out_of_service' | 'special_event' (until special_event_until).

import { db } from "./auth.js";

// The status in effect right now (an expired special event counts as in service)
export function effectiveService(r) {
  const st = r?.service_status ?? null;
  if (st === "special_event") {
    if (!r.special_event_until || Date.parse(r.special_event_until) <= Date.now()) return "in_service";
  }
  return st;
}

export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function timeLeft(untilIso) {
  const min = Math.max(0, Math.ceil((Date.parse(untilIso) - Date.now()) / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

// e.g. "Special event until 15:30 (1h 20m left)"
export function serviceText(r) {
  switch (effectiveService(r)) {
    case "in_service": return "In service";
    case "out_of_service": return "Out of service";
    case "special_event": return `Special event until ${clock(r.special_event_until)} (${timeLeft(r.special_event_until)} left)`;
    default: return "Not in service";
  }
}

// Change a unit's status (rig: its own unit; MSO: any unit in its agency)
export async function setService(unitId, status, minutes = null) {
  const { error } = await db.rpc("set_unit_service", {
    p_unit_id: unitId, p_status: status, p_minutes: minutes,
  });
  return error ? error.message : null;
}

// Hours + 15-minute picker for a special event. Calls onConfirm(totalMinutes).
export function durationPicker(onConfirm) {
  const wrap = document.createElement("div");
  wrap.className = "picker";

  const hours = document.createElement("select");
  for (let h = 0; h <= 24; h++) hours.add(new Option(`${h} h`, h));
  hours.value = "2";
  const mins = document.createElement("select");
  for (const m of [0, 15, 30, 45]) mins.add(new Option(`${m} min`, m));

  const until = document.createElement("div");
  until.className = "sub";
  const go = document.createElement("button");
  go.className = "tbtn special";
  go.type = "button";
  go.textContent = "Start special event";

  const total = () => Number(hours.value) * 60 + Number(mins.value);
  const update = () => {
    const t = total();
    const ok = t >= 15 && t <= 1440;
    go.disabled = !ok;
    until.textContent = ok
      ? `Back in service automatically at ${clock(new Date(Date.now() + t * 60000).toISOString())}`
      : t > 1440 ? "Maximum is 24 hours" : "Pick at least 15 minutes";
  };
  hours.onchange = update;
  mins.onchange = update;
  go.onclick = () => onConfirm(total());
  update();

  const row = document.createElement("div");
  row.className = "pickrow";
  row.append(hours, mins);
  wrap.append(row, until, go);
  return wrap;
}
