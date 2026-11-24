// Google Maps helpers shared by the ED board and MSO view.

import { GOOGLE_MAPS_BROWSER_KEY, GOOGLE_MAP_ID } from "./config.js";

let loading = null;

export function loadGoogleMaps() {
  loading ??= new Promise((resolve, reject) => {
    window.__gmapsReady = resolve;
    window.gm_authFailure = () => reject(new Error("Google Maps key rejected"));
    const s = document.createElement("script");
    s.src =
      "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(GOOGLE_MAPS_BROWSER_KEY)}` +
      "&v=weekly&loading=async&libraries=marker,geometry&callback=__gmapsReady";
    s.async = true;
    s.onerror = () => reject(new Error("Couldn't load Google Maps"));
    document.head.append(s);
  });
  return loading;
}

// Dark map with the live traffic layer. Returns null (and shows a message) if Maps can't load.
export async function createMap(el, center, zoom) {
  try {
    await loadGoogleMaps();
    const map = new google.maps.Map(el, {
      center,
      zoom,
      mapId: GOOGLE_MAP_ID,
      colorScheme: "DARK",
      streetViewControl: false,
      mapTypeControl: false,
    });
    new google.maps.TrafficLayer().setMap(map);
    return map;
  } catch (e) {
    console.error(e);
    el.textContent = "Map unavailable (check the Google Maps browser key in config.js).";
    el.className = "sub mapfail";
    return null;
  }
}

// A text label used as a map marker
export function pin(text, cls) {
  const el = document.createElement("div");
  el.className = `pin ${cls}`;
  el.textContent = text;
  return el;
}

export function addMarker(map, position, content, title) {
  return new google.maps.marker.AdvancedMarkerElement({ map, position, content, title });
}
