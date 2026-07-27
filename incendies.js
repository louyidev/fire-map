const NASA_API_KEY = "d9fe3ef6c297fec40b61f84714b55a56";
// ------------------------------------------------------------------
// 0) Mini-terminal : affiché pendant le chargement, masqué 5s après
//    la fin (succès ou échec) du chargement final.
// ------------------------------------------------------------------
const termLogEl = document.getElementById("terminal-log");
let termHideTimer = null;

function termShow() {
  clearTimeout(termHideTimer);
  termLogEl.style.opacity = "1";
  termLogEl.style.display = "block";
}

function termScheduleHide() {
  clearTimeout(termHideTimer);
  termHideTimer = setTimeout(() => {
    termLogEl.style.display = "none";
  });
}

function termLog(message) {
  termShow();
  const caret = termLogEl.querySelector(".term-caret");
  if (caret) caret.parentElement.remove();

  const line = document.createElement("div");
  line.textContent = message;
  termLogEl.appendChild(line);

  const caretLine = document.createElement("div");
  caretLine.innerHTML = `<span class="term-caret">_</span>`;
  termLogEl.appendChild(caretLine);

  termLogEl.scrollTop = termLogEl.scrollHeight;
}

// ------------------------------------------------------------------
// 1) Initialisation de la carte avec un rendu CANVAS (et non SVG).
//    C'est le changement de performance le plus important : le SVG crée
//    un élément DOM par marqueur (coûteux à animer/repeindre sur mobile),
//    alors que le canvas dessine tout sur une seule surface graphique.
// ------------------------------------------------------------------
const canvasRenderer = L.canvas({ padding: 0.5 });

const map = L.map("map", {
  center: [44.56, -0.52],
  zoom: 9,
  renderer: canvasRenderer,
  preferCanvas: true,
  zoomSnap: 0.5,
  tap: true,
});

const satelliteLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri",
  },
).addTo(map);

const roadsLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: "Labels &copy; Esri",
    pane: "overlayPane",
  },
).addTo(map);

const placesLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: "Labels &copy; Esri",
    pane: "overlayPane",
  },
).addTo(map);

const fireLayerGroup = L.layerGroup().addTo(map);

// ------------------------------------------------------------------
// 2) Structures de données.
//    - allFires : liste à plat de tous les foyers, triée par date.
//    - timeSteps : un pas de temps par relevé unique (pour le curseur).
//    - activeMarkers : uniquement les marqueurs "actifs" en cours
//      d'affichage, pour ne faire clignoter QUE ceux-là (peu nombreux).
// ------------------------------------------------------------------
let allFires = [];
let timeSteps = []; // [{ label, timestamp }]
let currentStepIndex = -1; // dernier pas réellement rendu (pour rendu incrémental)
let animationInterval = null;
let pulseInterval = null;
let pulseOn = true;
const activeMarkers = new Set();

function formatFrenchDateTime(dateObj) {
  const day = String(dateObj.getDate()).padStart(2, "0");
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const yearShort = String(dateObj.getFullYear()).substring(2);
  const hours = String(dateObj.getHours()).padStart(2, "0");
  const minutes = String(dateObj.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${yearShort} à ${hours}:${minutes}`;
}

async function fetchCsvSource(url, sourceName) {
  termLog(`GET ${sourceName}...`);
  const t0 = performance.now();
  try {
    const response = await fetch(url);
    const elapsed = Math.round(performance.now() - t0);

    if (!response.ok) {
      termLog(`${sourceName} -> HTTP ${response.status} (${elapsed}ms)`);
      return [];
    }
    const csvText = await response.text();
    const lines = csvText.trim().split("\n");
    if (lines.length <= 1) {
      termLog(`${sourceName} -> 0 ligne (${elapsed}ms)`);
      return [];
    }

    const headers = lines[0].split(",").map((h) => h.trim());
    const latIdx = headers.indexOf("latitude");
    const lngIdx = headers.indexOf("longitude");
    const frpIdx = headers.indexOf("frp");
    const dateIdx = headers.indexOf("acq_date");
    const timeIdx = headers.indexOf("acq_time");
    const confidenceIdx = headers.indexOf("confidence");
    const brightTi4Idx = headers.indexOf("bright_ti4");
    const daynightIdx = headers.indexOf("daynight");

    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(",");
      if (row.length < headers.length) continue;

      const lat = parseFloat(row[latIdx]);
      const lng = parseFloat(row[lngIdx]);
      const frp = parseFloat(row[frpIdx]) || 1.0;
      const rawDate = row[dateIdx];
      const rawTime = (row[timeIdx] || "0000").padStart(4, "0");
      const confidence = confidenceIdx !== -1 ? row[confidenceIdx] : "N/A";
      const brightTi4 = brightTi4Idx !== -1 ? row[brightTi4Idx] : "N/A";
      const daynight = daynightIdx !== -1 ? row[daynightIdx] : "N/A";

      const hh = rawTime.substring(0, 2);
      const mm = rawTime.substring(2, 4);
      const dateObj = new Date(`${rawDate}T${hh}:${mm}:00Z`);
      if (isNaN(lat) || isNaN(lng) || isNaN(dateObj.getTime())) continue;

      items.push({
        lat,
        lng,
        frp,
        formattedDateTime: formatFrenchDateTime(dateObj),
        timestamp: dateObj.getTime(),
        source: sourceName,
        confidence,
        brightTi4,
        daynight,
        marker: null,
        glowMarker: null,
        category: null,
      });
    }

    termLog(`${sourceName} -> ${items.length} points OK (${elapsed}ms)`);
    return items;
  } catch (e) {
    const elapsed = Math.round(performance.now() - t0);
    termLog(`${sourceName} -> échec réseau (${elapsed}ms)`);
    console.warn("Erreur sur un flux satellite :", e);
    return [];
  }
}

async function loadMultiSatelliteData() {
  const statusEl = document.getElementById("status");
  const loaderEl = document.getElementById("loader");
  const btnReload = document.getElementById("btn-reload");
  const banner = document.getElementById("last-update-banner");

  banner.style.display = "none";
  loaderEl.style.display = "block";
  btnReload.disabled = true;

  statusEl.innerText = "Interrogation satellites...";
  termLog("--- Nouvelle actualisation ---");

  const bbox = "-5.5,41.0,9.8,51.5";
  const days = "5";

  const sources = [
    {
      url: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_API_KEY}/VIIRS_SNPP_NRT/${bbox}/${days}`,
      name: "VIIRS SNPP (NRT)",
    },
    {
      url: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_API_KEY}/VIIRS_NOAA20_NRT/${bbox}/${days}`,
      name: "VIIRS NOAA-20 (NRT)",
    },
    {
      url: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_API_KEY}/MODIS_NRT/${bbox}/${days}`,
      name: "MODIS (NRT)",
    },
  ];

  try {
    const results = await Promise.all(
      sources.map((src) => fetchCsvSource(src.url, src.name)),
    );

    stopAnimation();

    fireLayerGroup.clearLayers();
    activeMarkers.clear();

    allFires = results.flat();

    currentStepIndex = -1;

    if (allFires.length === 0) {
      statusEl.innerText = "⚠️ Aucun point détecté.";

      termLog("Aucun point détecté au total.");

      return;
    }

    // Tri chronologique
    allFires.sort((a, b) => a.timestamp - b.timestamp);

    // Création des étapes temporelles
    const seen = new Map();

    for (const fire of allFires) {
      if (!seen.has(fire.formattedDateTime)) {
        seen.set(fire.formattedDateTime, fire.timestamp);
      }
    }

    timeSteps = Array.from(seen, ([label, timestamp]) => ({
      label,
      timestamp,
    })).sort((a, b) => a.timestamp - b.timestamp);

    statusEl.innerText = `✅ ${allFires.length} relevés`;

    termLog(`Total : ${allFires.length} relevés fusionnés.`);

    // ---------------------------------------------------------
    // Position initiale :
    // Lacanau - Bassin d'Arcachon - Bordeaux
    // ---------------------------------------------------------

    applyMapView();

    initTimeline();
    const lastUpdateText = document.getElementById("last-update-text");
    lastUpdateText.textContent = timeSteps[timeSteps.length - 1].label;
    banner.style.display = "flex";
  } catch (err) {
    console.error("Erreur chargement incendies :", err);
    banner.style.display = "none";
    statusEl.innerText = "❌ Erreur de chargement.";

    termLog("Erreur globale de chargement.");
  } finally {
    loaderEl.style.display = "none";

    btnReload.disabled = false;

    termScheduleHide();
  }
}

function initTimeline() {
  const timelinePanel = document.getElementById("timeline-panel");
  const slider = document.getElementById("time-slider");
  const lastUpdateBanner = document.getElementById("last-update-banner");
  const lastUpdateText = document.getElementById("last-update-text");

  if (timeSteps.length === 0) return;

  timelinePanel.style.display = "flex";

  const lastIndex = timeSteps.length - 1;
  lastUpdateText.innerText = timeSteps[lastIndex].label;
  lastUpdateBanner.style.display = "flex";

  slider.min = 0;
  slider.max = lastIndex;
  slider.value = lastIndex;

  renderStep(lastIndex);
  startPulse();
}

// ------------------------------------------------------------------
// 3) Détermination de catégorie visuelle selon l'âge du foyer.
// ------------------------------------------------------------------

const STYLES = {
  // 0-3 h : cœur extrêmement chaud
  c1: {
    fillColor: "#fff200",
    color: "#ffffff",
    fillOpacity: 1,
    weight: 3,
  },

  // 3-6 h
  c2: {
    fillColor: "#ffd000",
    color: "#ffef9f",
    fillOpacity: 0.98,
    weight: 3,
  },

  // 6-12 h
  c3: {
    fillColor: "#ff9800",
    color: "#ff5e00",
    fillOpacity: 0.95,
    weight: 3,
  },

  // 12-24 h
  c4: {
    fillColor: "#ff5c00",
    color: "#d62828",
    fillOpacity: 0.9,
    weight: 2,
  },

  // 24-36 h
  c5: {
    fillColor: "#d62828",
    color: "#8b0000",
    fillOpacity: 0.8,
    weight: 2,
  },

  // 36-48 h
  c6: {
    fillColor: "#8b0000",
    color: "#4a0404",
    fillOpacity: 0.65,
    weight: 2,
  },

  // 48-72 h
  c7: {
    fillColor: "#4a0404",
    color: "#1f1f1f",
    fillOpacity: 0.45,
    weight: 1,
  },

  // >72 h
  c8: {
    fillColor: "#202020",
    color: "#000000",
    fillOpacity: 0.25,
    weight: 1,
  },
};

function popupHtml(fire, category) {
  const statusLabel = {
    active: "🔥 Anomalie active / chaude (<12h)",
    medium: "⚠️ Foyer en refroidissement (12h-36h)",
    old: "ℹ️ Trace ancienne (>36h)",
  }[category];

  return `<div>
                <b>Statut :</b> ${statusLabel}<br>
                <b>🛰️ Source :</b> ${fire.source}<br>
                <b>📅 Relevé :</b> ${fire.formattedDateTime}<br>
                <b>⚡ FRP :</b> ${fire.frp} MW<br>
                <b>🎯 Confiance :</b> ${fire.confidence}<br>
                <b>🌡️ Bright_ti4 :</b> ${fire.brightTi4} K<br>
                <b>🌓 Cycle :</b> ${fire.daynight === "D" ? "Jour" : "Nuit"}<br>
                <b>📍 Position :</b> ${fire.lat.toFixed(4)}, ${fire.lng.toFixed(4)}
            </div>`;
}

// ------------------------------------------------------------------
// 4) Rendu d'un pas de temps.
//    Optimisation clé : on ne recrée JAMAIS un marqueur qui existe déjà.
//    - Les nouveaux foyers (par rapport au pas précédent) sont ajoutés.
//    - Les foyers déjà affichés ne sont restylés QUE si leur catégorie
//      (actif / atténué / ancien) a changé, pas à chaque frame.
//    - Un saut en arrière du curseur ne fait que masquer les foyers
//      trop récents, sans tout recalculer depuis zéro.
// ------------------------------------------------------------------
function renderStep(index) {
  const targetTimestamp = timeSteps[index].timestamp;
  document.getElementById("time-display").innerText = timeSteps[index].label;
  document.getElementById("time-slider").value = index;

  for (const fire of allFires) {
    if (fire.timestamp > targetTimestamp) {
      // Pas encore "révélé" à cet instant : on le masque si besoin.
      if (fire.marker) {
        fireLayerGroup.removeLayer(fire.marker);
        if (fire.glowMarker) fireLayerGroup.removeLayer(fire.glowMarker);
        activeMarkers.delete(fire);
        fire.marker = null;
        fire.glowMarker = null;
        fire.category = null;
      }
      continue;
    }

    const ageInHours = (targetTimestamp - fire.timestamp) / 3600000;
    const category = categoryFor(ageInHours);

    if (fire.category === category && fire.marker) {
      continue; // rien à faire : déjà affiché avec le bon style
    }

    const style = STYLES[category];
    const radius = radiusFor(category, fire.frp);

    if (!fire.marker) {
      fire.marker = L.circleMarker([fire.lat, fire.lng], {
        renderer: canvasRenderer,
        radius,
        ...style,
      }).addTo(fireLayerGroup);
      fire.marker.bindPopup(popupHtml(fire, category), { maxWidth: 220 });
    } else {
      fire.marker.setStyle(style);
      fire.marker.setRadius(radius);
      fire.marker.setPopupContent(popupHtml(fire, category));
    }

    // Halo lumineux léger, uniquement pour les foyers actifs :
    // deux cercles canvas au lieu d'un filtre CSS (beaucoup moins cher au rendu).
    if (isHotFire(category) && !fire.glowMarker) {
      fire.glowMarker = L.circleMarker([fire.lat, fire.lng], {
        renderer: canvasRenderer,
        radius: radius + 6,

        fillColor: category === "c1" ? "#ffff00" : "#ff4500",

        color: "transparent",

        fillOpacity: category === "c1" ? 0.55 : 0.35,

        weight: 0,
      }).addTo(fireLayerGroup);

      fire.glowMarker.bringToBack();

      activeMarkers.add(fire);
    } else if (!isHotFire(category) && fire.glowMarker) {
      fireLayerGroup.removeLayer(fire.glowMarker);

      fire.glowMarker = null;

      activeMarkers.delete(fire);
    }

    fire.category = category;
  }

  currentStepIndex = index;
}

// ------------------------------------------------------------------
// 5) Pulsation des foyers actifs.
//    Un seul setInterval global qui ne touche QUE les quelques
//    marqueurs "actifs" (activeMarkers), au lieu d'une animation CSS
//    avec flou (drop-shadow) appliquée à tous les points : c'est ce
//    filtre qui faisait ramer les téléphones.
// ------------------------------------------------------------------
function startPulse() {
  if (pulseInterval) return;

  let phase = 0;

  pulseInterval = setInterval(() => {
    phase += 0.3;

    const glowScale = 1 + Math.sin(phase) * 0.25;
    const glowOpacity = 0.2 + (Math.sin(phase) + 1) * 0.18;
    const coreScale = 1 + Math.sin(phase + 0.8) * 0.08;

    activeMarkers.forEach((fire) => {
      if (!fire.marker || !fire.glowMarker) {
        return;
      }

      // On garde la taille liée à l'âge réel du feu
      const baseRadius = radiusFor(fire.category, fire.frp);

      // Le point central pulse légèrement
      fire.marker.setRadius(baseRadius * coreScale);

      // Le halo pulse davantage
      fire.glowMarker.setRadius((baseRadius + 5) * glowScale);

      fire.glowMarker.setStyle({
        fillOpacity: glowOpacity,
      });
    });
  }, 40); // ~25 FPS
}

function stopAnimation() {
  if (animationInterval) {
    clearInterval(animationInterval);
    animationInterval = null;
  }
  document.getElementById("btn-play").innerText = "▶ Jouer";
}

document
  .getElementById("btn-reload")
  .addEventListener("click", loadMultiSatelliteData);

document.getElementById("btn-play").addEventListener("click", () => {
  const btnPlay = document.getElementById("btn-play");
  if (animationInterval) {
    stopAnimation();
  } else {
    btnPlay.innerText = "⏸ Pause";
    animationInterval = setInterval(() => {
      let next = currentStepIndex + 1;
      if (next >= timeSteps.length) next = 0;
      renderStep(next);
    }, 700);
  }
});

document.getElementById("time-slider").addEventListener("input", (e) => {
  stopAnimation();
  renderStep(parseInt(e.target.value, 10));
});

// Redimensionnement : on limite les recalculs à un seul par courte
// rafale d'évènements (utile quand la barre d'adresse mobile apparaît/disparaît).
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => map.invalidateSize(), 200);
});

window.addEventListener("load", () => {
  setTimeout(() => {
    map.invalidateSize();
    loadMultiSatelliteData();
  }, 300);

  // Changement de cadrage carte
  document
    .getElementById("view-gironde")
    .addEventListener("change", applyMapView);

  document
    .getElementById("view-france")
    .addEventListener("change", applyMapView);
});

function applyMapView() {
  const girondeSelected = document.getElementById("view-gironde").checked;

  if (girondeSelected) {
    const zoneGironde = L.latLngBounds([44.5, -1.2], [44.95, -0.4]);

    map.fitBounds(zoneGironde, {
      padding: [20, 20],
      animate: true,
      maxZoom: 10,
    });
  } else {
    const zoneFrance = L.latLngBounds([41.0, -5.5], [51.5, 9.8]);

    map.fitBounds(zoneFrance, {
      padding: [20, 20],
      animate: true,
      maxZoom: 7,
    });
  }
}

function categoryFor(ageInHours) {
  if (ageInHours <= 3) return "c1";
  if (ageInHours <= 6) return "c2";
  if (ageInHours <= 12) return "c3";
  if (ageInHours <= 24) return "c4";
  if (ageInHours <= 36) return "c5";
  if (ageInHours <= 48) return "c6";
  if (ageInHours <= 72) return "c7";

  return "c8";
}

function isHotFire(category) {
  return ["c1", "c2", "c3"].includes(category);
}

function radiusFor(category, frp) {
  const baseRadius = Math.min(Math.max(frp * 0.45, 7), 18);

  switch (category) {
    case "c1":
      return baseRadius;

    case "c2":
      return baseRadius - 1;

    case "c3":
      return baseRadius - 2;

    case "c4":
      return 7;

    case "c5":
      return 6;

    case "c6":
      return 5;

    case "c7":
      return 4;

    default:
      return 3;
  }
}
