import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const RED = "#c4342d";
const BLUE = "#2b6cb0";
const GRAY = "#c8c5bd";
const PHASE_COLOR = { "El Niño": RED, "La Niña": BLUE, Neutral: GRAY };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const LAND = "#d8c9a2"; // sandy land color for the ocean temperature map
const DRY_LIMIT = 0.3; // mm/day: below this a place is "normally almost dry" that month

const fmt = (v, digits = 1) =>
  v == null || Number.isNaN(v) ? "n/a" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;
const latFmt = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? "N" : "S"}`;
const lonFmt = (v) => {
  const l = ((v + 540) % 360) - 180;
  return `${Math.abs(l).toFixed(1)}°${l >= 0 ? "E" : "W"}`;
};
const pctFmt = (r) => `${Math.round(r * 100)}%`;

// winter category by its Dec–Feb ONI (same thresholds as NOAA)
const winterType = (oni) =>
  oni >= 1.5 ? "Strong El Niño" : oni >= 0.5 ? "Weaker El Niño" : oni <= -0.5 ? "La Niña" : "Neutral";
const TYPE_COLOR = { "Strong El Niño": "#8f1d18", "Weaker El Niño": RED, Neutral: GRAY, "La Niña": BLUE };

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const [nino, eventsRaw, grid, land, california, clim, caWinters] = await Promise.all([
  d3.csv("data/nino34.csv", (d) => ({
    date: d.date,
    year: +d.year,
    month: +d.month,
    oni: d.oni === "" ? null : +d.oni,
    phase: d.phase,
  })),
  d3.csv("data/events.csv", (d) => ({ phase: d.phase, start: d.start, end: d.end, peak: +d.peak })),
  d3.json("data/grid.json"),
  d3.json("data/land.geojson"),
  d3.json("data/california.geojson"),
  // these two come from exploratory/export_climatology.ipynb; the page still works without them
  d3.json("data/climatology.json").catch(() => null),
  d3.csv("data/california.csv", (d) => ({
    label: d.label,
    winter: +d.winter,
    oni: +d.oni,
    phase: d.phase,
    pct: +d.pct_normal,
    inches: +d.inches,
    normal: +d.normal_inches,
  })).catch(() => null),
]);

const N = nino.length;
const indexOf = new Map(nino.map((d, i) => [d.date, i]));
const monthLabel = (i) => `${MONTHS[nino[i].month - 1]} ${nino[i].year}`;

const toFloat = (arr, scale) => Float32Array.from(arr, (x) => (x == null ? NaN : x * scale));
const climMaps = clim
  ? { sst: clim.sst.map((m) => toFloat(m, clim.scale)), pr: clim.pr.map((m) => toFloat(m, clim.scale)) }
  : null;

const events = eventsRaw.map((e) => {
  const i0 = indexOf.get(e.start);
  const i1 = indexOf.get(e.end);
  const y0 = nino[i0].year;
  const y1 = nino[i1].year;
  const years = y0 === y1 ? `${y0}` : `${y0}–${String(y1).slice(2)}`;
  const peakIndex = d3.range(i0, i1 + 1).reduce((best, i) =>
    Math.abs(nino[i].oni ?? 0) > Math.abs(nino[best].oni ?? 0) ? i : best, i0);
  return { ...e, i0, i1, peakIndex, label: `${years} ${e.phase}` };
});

// California winters: which winter does a month belong to? (Nov–Mar, labeled by the January year)
const winterByYear = new Map((caWinters ?? []).map((w) => [w.winter, w]));
const winterOfMonth = (i) => {
  const { year, month } = nino[i];
  if (month >= 11) return winterByYear.get(year + 1) ?? null;
  if (month <= 3) return winterByYear.get(year) ?? null;
  return null;
};

const NLAT = grid.lat.length;
const NLON = grid.lon.length;
const DLAT = grid.lat[1] - grid.lat[0];
const DLON = grid.lon[1] - grid.lon[0];

const cache = { sst: new Map(), pr: new Map() };
function loadYear(v, year) {
  if (!cache[v].has(year)) {
    cache[v].set(year, d3.json(`data/${v}/${year}.json`).then((d) => d.months.map((m) => toFloat(m, d.scale))));
  }
  return cache[v].get(year);
}
const allYears = d3.range(nino[0].year, nino[N - 1].year + 1);
const prefetch = async (v) => { for (const y of allYears) await loadYear(v, y); };

// ---------------------------------------------------------------------------
// State + tooltip
// ---------------------------------------------------------------------------
const state = { variable: "sst", month: indexOf.get("1997-12"), playing: false };

const tooltip = d3.select("#tooltip");
function showTip(event, html) {
  tooltip.html(html).style("opacity", 1);
  const node = tooltip.node();
  let x = event.clientX + 14;
  let y = event.clientY + 14;
  if (x + node.offsetWidth > window.innerWidth - 8) x = event.clientX - node.offsetWidth - 14;
  if (y + node.offsetHeight > window.innerHeight - 8) y = event.clientY - node.offsetHeight - 14;
  tooltip.style("left", `${x}px`).style("top", `${y}px`);
}
const hideTip = () => tooltip.style("opacity", 0);

const winterTip = (w) =>
  `<b>Winter ${w.label}</b> (Nov–Mar)<br>` +
  `California rain: <b>${Math.round(w.pct)}% of normal</b><br>` +
  `${w.inches.toFixed(1)} in. vs. a normal ${w.normal.toFixed(1)} in.<br>` +
  `Winter ONI: <b>${fmt(w.oni, 2)} °C</b> <span style="color:${TYPE_COLOR[winterType(w.oni)]}">● ${winterType(w.oni)}</span>`;

// ---------------------------------------------------------------------------
// Timeline: ONI bars on top, California winter rain below, one movable bar
// ---------------------------------------------------------------------------
const TW = 960;
const ROW1 = { top: 52, bottom: 196 }; // ONI
const ROW2 = { top: 240, bottom: 328 }; // California rain
const TH = 354;
const ml = 52;
const mr = 18;
const tl = d3.select("#timeline").attr("viewBox", `0 0 ${TW} ${TH}`);
const x = d3.scaleUtc([Date.UTC(nino[0].year, 0, 1), Date.UTC(nino[N - 1].year + 1, 0, 1)], [ml, TW - mr]);
const monthX = (i) => x(Date.UTC(nino[i].year, nino[i].month - 1, 1));
const monthW = monthX(1) - monthX(0);
const centerX = (i) => monthX(i) + monthW / 2;
const indexAt = (px) => {
  const d = x.invert(px);
  const i = (d.getUTCFullYear() - nino[0].year) * 12 + d.getUTCMonth();
  return Math.max(0, Math.min(N - 1, i));
};

// row 1: ONI
const y1 = d3.scaleLinear([-2.8, 3.0], [ROW1.bottom, ROW1.top]);
tl.append("text").attr("class", "row-label").attr("x", ml).attr("y", ROW1.top - 14)
  .text("El Niño strength (ONI, °C above or below average)");
tl.append("g").attr("class", "axis").attr("transform", `translate(${ml},0)`)
  .call(d3.axisLeft(y1).ticks(6).tickFormat((d) => `${d > 0 ? "+" : ""}${d}°`))
  .call((g) => g.select(".domain").remove());
tl.append("g").selectAll("line").data([0.5, -0.5]).join("line")
  .attr("x1", ml).attr("x2", TW - mr).attr("y1", (d) => y1(d)).attr("y2", (d) => y1(d))
  .attr("stroke", "#9a978f").attr("stroke-dasharray", "3,3").attr("stroke-width", 0.8);
tl.append("g").selectAll("rect")
  .data(nino.map((d, i) => ({ ...d, i })).filter((d) => d.oni != null))
  .join("rect")
  .attr("x", (d) => monthX(d.i))
  .attr("width", monthW + 0.3)
  .attr("y", (d) => Math.min(y1(0), y1(d.oni)))
  .attr("height", (d) => Math.abs(y1(d.oni) - y1(0)))
  .attr("fill", (d) => PHASE_COLOR[d.phase]);
tl.append("line").attr("x1", ml).attr("x2", TW - mr).attr("y1", y1(0)).attr("y2", y1(0)).attr("stroke", "#7d7a72");
const top3 = [...events].filter((e) => e.phase === "El Niño").sort((a, b) => b.peak - a.peak).slice(0, 3);
tl.append("g").selectAll("text").data(top3).join("text")
  .attr("x", (e) => centerX(e.peakIndex))
  .attr("y", (e) => y1(e.peak) - 4)
  .attr("text-anchor", "middle")
  .style("font-size", "10.5px")
  .text((e) => e.label.split(" ")[0]);

// row 2: California winter rain (% of normal)
const pctMax = caWinters ? Math.max(200, d3.max(caWinters, (w) => w.pct) * 1.05) : 200;
const y2 = d3.scaleLinear([0, pctMax], [ROW2.bottom, ROW2.top]);
const rainColor = d3.scaleDivergingLog(d3.interpolateBrBG).domain([0.25, 1, 4]).clamp(true);
tl.append("text").attr("class", "row-label").attr("x", ml).attr("y", ROW2.top - 12)
  .text("California winter rain (Nov–Mar), % of a normal winter");
tl.append("g").attr("class", "axis").attr("transform", `translate(${ml},0)`)
  .call(d3.axisLeft(y2).tickValues([0, 50, 100, 150, 200].filter((t) => t <= pctMax)).tickFormat((d) => `${d}%`))
  .call((g) => g.select(".domain").remove());
const winterX0 = (w) => x(Date.UTC(w.winter - 1, 10, 1));
const winterX1 = (w) => x(Date.UTC(w.winter, 3, 1));
const rainBars = tl.append("g");
if (caWinters) {
  rainBars.selectAll("rect").data(caWinters).join("rect")
    .attr("x", (w) => winterX0(w) + 0.5)
    .attr("width", (w) => winterX1(w) - winterX0(w) - 1)
    .attr("y", (w) => Math.min(y2(100), y2(w.pct)))
    .attr("height", (w) => Math.abs(y2(w.pct) - y2(100)))
    .attr("fill", (w) => rainColor(w.pct / 100))
    .attr("stroke", "#1f1e1c")
    .attr("stroke-width", 0);
  tl.append("line").attr("x1", ml).attr("x2", TW - mr).attr("y1", y2(100)).attr("y2", y2(100)).attr("stroke", "#7d7a72");
  tl.append("text").attr("x", TW - mr).attr("y", y2(100) - 3).attr("text-anchor", "end").style("font-size", "10px").text("normal");
} else {
  tl.append("text").attr("class", "missing").attr("x", ml + 10).attr("y", (ROW2.top + ROW2.bottom) / 2)
    .style("fill", "#9a6b00")
    .text("Run exploratory/export_climatology.ipynb to add California's rainfall here.");
}
tl.append("g").attr("class", "axis").attr("transform", `translate(0,${ROW2.bottom + 4})`)
  .call(d3.axisBottom(x).ticks(d3.utcYear.every(5)).tickFormat(d3.utcFormat("%Y")).tickSizeOuter(0))
  .call((g) => g.select(".domain").remove());

// hover guide
const ghost = tl.append("line").attr("y1", ROW1.top).attr("y2", ROW2.bottom)
  .attr("stroke", "#1f1e1c").attr("stroke-opacity", 0.35).attr("stroke-dasharray", "2,2")
  .style("display", "none").style("pointer-events", "none");

// the movable bar
const handle = tl.append("g").style("pointer-events", "none");
handle.append("line").attr("y1", 26).attr("y2", ROW2.bottom).attr("stroke", "#1f1e1c").attr("stroke-width", 2);
const knob = handle.append("rect").attr("y", 2).attr("height", 22).attr("rx", 4).attr("fill", "#1f1e1c");
const knobText = handle.append("text").attr("class", "handle-label").attr("y", 17.5).attr("text-anchor", "middle");

function drawHandle() {
  const cx = centerX(state.month);
  handle.attr("transform", `translate(${cx},0)`);
  knobText.text(monthLabel(state.month));
  const w = knobText.node().getComputedTextLength() + 16;
  const shift = Math.max(ml - cx + w / 2, Math.min(0, TW - mr - cx - w / 2));
  knob.attr("x", -w / 2 + shift).attr("width", w);
  knobText.attr("x", shift);
  // outline the California winter this month belongs to
  const w0 = winterOfMonth(state.month);
  rainBars.selectAll("rect").attr("stroke-width", (w) => (w === w0 ? 1.5 : 0));
}

let dragging = false;
tl.append("rect")
  .attr("class", "scrub-overlay")
  .attr("x", ml).attr("y", 0)
  .attr("width", TW - ml - mr).attr("height", ROW2.bottom + 2)
  .attr("fill", "transparent")
  .on("pointerdown", function (event) {
    dragging = true;
    this.setPointerCapture(event.pointerId);
    stopPlay();
    setMonth(indexAt(d3.pointer(event, tl.node())[0]));
    hideTip();
    ghost.style("display", "none");
  })
  .on("pointermove", function (event) {
    const [px, py] = d3.pointer(event, tl.node());
    const i = indexAt(px);
    if (dragging) {
      if (i !== state.month) setMonth(i);
      return;
    }
    ghost.style("display", null).attr("x1", centerX(i)).attr("x2", centerX(i));
    const w = winterOfMonth(i);
    if (py > ROW1.bottom + 10 && w) {
      showTip(event, winterTip(w));
    } else {
      const d = nino[i];
      showTip(event,
        `<b>${monthLabel(i)}</b><br>ONI: <b>${d.oni == null ? "n/a" : fmt(d.oni, 2) + " °C"}</b>` +
        ` <span style="color:${PHASE_COLOR[d.phase]}">● ${d.phase}</span><br>` +
        `<span style="color:#8a8880">Click or drag to show this month on the map</span>`);
    }
  })
  .on("pointerup pointercancel", function (event) {
    dragging = false;
    if (this.hasPointerCapture(event.pointerId)) this.releasePointerCapture(event.pointerId);
  })
  .on("pointerleave", () => {
    if (!dragging) { hideTip(); ghost.style("display", "none"); }
  });

// ---------------------------------------------------------------------------
// Map of the Pacific: smooth canvas + SVG overlay
// ---------------------------------------------------------------------------
const LON_W = 100; // 100°E (Indonesia)
const LON_E = 290; // 70°W (South America)
const LAT_TOP = 60;
const LAT_BOT = -45;
const MW = 960;
const ppd = MW / (LON_E - LON_W); // pixels per degree
const MH = Math.round((LAT_TOP - LAT_BOT) * ppd);
const centerLon = (LON_W + LON_E) / 2;
const proj = d3.geoEquirectangular()
  .rotate([-centerLon, 0])
  .scale((180 / Math.PI) * ppd)
  .translate([MW / 2, LAT_TOP * ppd])
  .clipExtent([[0, 0], [MW, MH]]);
const path = d3.geoPath(proj);
const toLonLat = (mx, my) => [centerLon + (mx - MW / 2) / ppd, LAT_TOP - my / ppd];

const R = 2; // draw at 2x for sharp edges
const CW = MW * R;
const CH = MH * R;
const canvas = document.getElementById("map-canvas");
canvas.width = CW;
canvas.height = CH;
const ctx = canvas.getContext("2d");
const image = ctx.createImageData(CW, CH);
const pixels = new Uint32Array(image.data.buffer);

// bilinear interpolation lookup: which grid columns/rows each pixel sits between
const colJ0 = new Int32Array(CW);
const colJ1 = new Int32Array(CW);
const colW = new Float32Array(CW);
for (let px = 0; px < CW; px++) {
  const [lon] = toLonLat((px + 0.5) / R, 0);
  let fj = (lon - grid.lon[0]) / DLON;
  fj = ((fj % NLON) + NLON) % NLON;
  const j0 = Math.floor(fj);
  colJ0[px] = j0;
  colJ1[px] = (j0 + 1) % NLON;
  colW[px] = fj - j0;
}
const rowI0 = new Int32Array(CH);
const rowW = new Float32Array(CH);
for (let py = 0; py < CH; py++) {
  const [, lat] = toLonLat(0, (py + 0.5) / R);
  const fi = (lat - grid.lat[0]) / DLAT;
  const i0 = Math.max(0, Math.min(NLAT - 2, Math.floor(fi)));
  rowI0[py] = i0;
  rowW[py] = Math.max(0, Math.min(1, fi - i0));
}

function sample(values, lon, lat) {
  let fj = (lon - grid.lon[0]) / DLON;
  fj = ((fj % NLON) + NLON) % NLON;
  const j0 = Math.floor(fj);
  const j1 = (j0 + 1) % NLON;
  const wx = fj - j0;
  const fi = (lat - grid.lat[0]) / DLAT;
  const i0 = Math.max(0, Math.min(NLAT - 2, Math.floor(fi)));
  const wy = Math.max(0, Math.min(1, fi - i0));
  const pts = [
    [values[i0 * NLON + j0], (1 - wx) * (1 - wy)],
    [values[i0 * NLON + j1], wx * (1 - wy)],
    [values[(i0 + 1) * NLON + j0], (1 - wx) * wy],
    [values[(i0 + 1) * NLON + j1], wx * wy],
  ];
  let s = 0;
  let w = 0;
  for (const [v, wt] of pts) if (!Number.isNaN(v)) { s += v * wt; w += wt; }
  return w > 0 ? s / w : NaN;
}

// Map layers. Each one turns a month's anomalies into the values that get colored.
const LAYERS = {
  sst: {
    name: "Ocean temperature",
    lim: 3, // drawn values: °C difference
    color: d3.scaleDiverging((t) => d3.interpolateRdBu(1 - t)).domain([-3, 0, 3]).clamp(true),
    ticks: [-3, -2, -1, 0, 1, 2, 3],
    tickFmt: (t) => `${t > 0 ? "+" : ""}${t}`,
    low: "← colder than average",
    high: "warmer than average (°C) →",
    caption:
      "Color = how much warmer (red) or colder (blue) the ocean is than its 1981–2010 average for the same month. " +
      "These are the real, observed ocean temperatures. Hover for the actual temperature.",
    values: (anom) => anom,
  },
  prPct: {
    name: "Rainfall",
    lim: 2, // drawn values: log2(rain / normal), so ±2 = ¼× to 4×
    color: d3.scaleDiverging(d3.interpolateBrBG).domain([-2, 0, 2]).clamp(true),
    ticks: [-2, -1, 0, 1, 2],
    tickFmt: (t) => pctFmt(2 ** t),
    low: "← less rain than normal",
    high: "more rain than normal →",
    caption:
      "Color = this month's rain as a percent of the usual rain for that month (1981–2010 average): green is wetter, brown is drier. " +
      "Blank areas are normally almost dry that month. Rainfall is simulated by the CESM2 model from the real ocean temperatures (one model run).",
    values: (anom, month) => {
      const normal = climMaps.pr[month - 1];
      return Float32Array.from(anom, (a, k) =>
        Number.isNaN(a) || !(normal[k] >= DRY_LIMIT) ? NaN : Math.log2(Math.max(0.05, (normal[k] + a) / normal[k])));
    },
  },
  prAnom: { // fallback if climatology.json hasn't been generated yet
    name: "Rainfall",
    lim: 6,
    color: d3.scaleDivergingSqrt(d3.interpolateBrBG).domain([-6, 0, 6]).clamp(true),
    ticks: [-6, -4, -2, 0, 2, 4, 6],
    tickFmt: (t) => `${t > 0 ? "+" : ""}${t}`,
    low: "← drier than average",
    high: "wetter (mm/day) →",
    caption:
      "Color = difference from the 1981–2010 average rainfall for the same month (green wetter, brown drier). " +
      "Rainfall is simulated by the CESM2 model from the real ocean temperatures (one model run).",
    values: (anom) => anom,
  },
};
const layerKey = () => (state.variable === "sst" ? "sst" : climMaps ? "prPct" : "prAnom");

const LUT_N = 512;
const luts = {};
for (const [k, L] of Object.entries(LAYERS)) {
  const lut = new Uint32Array(LUT_N);
  for (let n = 0; n < LUT_N; n++) {
    const c = d3.rgb(L.color(-L.lim + (2 * L.lim * n) / (LUT_N - 1)));
    lut[n] = (255 << 24) | (c.b << 16) | (c.g << 8) | c.r;
  }
  luts[k] = lut;
}

function drawCanvas(values, key) {
  const lut = luts[key];
  const lim = LAYERS[key].lim;
  const k = (LUT_N - 1) / (2 * lim);
  for (let py = 0; py < CH; py++) {
    const r0 = rowI0[py] * NLON;
    const r1 = r0 + NLON;
    const wy = rowW[py];
    const base = py * CW;
    for (let px = 0; px < CW; px++) {
      const j0 = colJ0[px];
      const j1 = colJ1[px];
      const wx = colW[px];
      const a = values[r0 + j0];
      const b = values[r0 + j1];
      const c = values[r1 + j0];
      const d = values[r1 + j1];
      let s = 0;
      let w = 0;
      let wt = (1 - wx) * (1 - wy);
      if (a === a) { s += a * wt; w += wt; } // false only for NaN
      wt = wx * (1 - wy);
      if (b === b) { s += b * wt; w += wt; }
      wt = (1 - wx) * wy;
      if (c === c) { s += c * wt; w += wt; }
      wt = wx * wy;
      if (d === d) { s += d * wt; w += wt; }
      if (w < 0.25) { pixels[base + px] = 0; continue; }
      let n = Math.round((s / w + lim) * k);
      if (n < 0) n = 0; else if (n >= LUT_N) n = LUT_N - 1;
      pixels[base + px] = lut[n];
    }
  }
  ctx.putImageData(image, 0, 0);
}

// overlay: land, coastlines, California, labels
const overlay = d3.select("#map-overlay").attr("viewBox", `0 0 ${MW} ${MH}`);
const landFill = overlay.append("path").datum(land).attr("d", path).attr("fill", LAND);
const coast = overlay.append("path").datum(land).attr("d", path).attr("fill", "none")
  .attr("stroke", "#6b5d3e").attr("stroke-width", 0.8);
const caPath = overlay.append("path").datum(california).attr("d", path)
  .attr("fill", "none").attr("stroke", "#1f1e1c").attr("stroke-width", 2).attr("stroke-linejoin", "round");
const [caX, caY] = proj([-119.5, 37.2]);
overlay.append("text").attr("x", caX + 26).attr("y", caY - 14).style("font-size", "12px").style("font-weight", 600)
  .style("fill", "#1f1e1c").text("California");
const eqY = proj([centerLon, 0])[1];
overlay.append("line").attr("x1", 0).attr("x2", MW).attr("y1", eqY).attr("y2", eqY)
  .attr("stroke", "#5f5c55").attr("stroke-opacity", 0.5).attr("stroke-dasharray", "2,4").attr("stroke-width", 0.6);
overlay.append("text").attr("x", 4).attr("y", eqY - 3).style("font-size", "10px").text("Equator");
for (const [name, lon, lat] of [["Indonesia", 112, -10], ["Australia", 132, -26], ["South America", 290 - 26, -16]]) {
  const [lx, ly] = proj([lon, lat]);
  overlay.append("text").attr("x", lx).attr("y", ly).style("font-size", "10.5px").style("fill", "#4a463d").text(name);
}
const hoverDot = overlay.append("circle").attr("r", 4).attr("fill", "none").attr("stroke", "#1f1e1c")
  .attr("stroke-width", 1.5).style("display", "none");

let current = null; // { anom, key, month }
let renderToken = 0;

async function renderMap() {
  const token = ++renderToken;
  const key = layerKey();
  const i = state.month;
  const d = nino[i];
  d3.select("#map-title").text(`${LAYERS[key].name} around the Pacific, ${monthLabel(i)}`);
  const w = winterOfMonth(i);
  d3.select("#readout").html(
    `ONI <b>${d.oni == null ? "n/a" : fmt(d.oni, 2) + " °C"}</b> · <span style="color:${PHASE_COLOR[d.phase]}">${d.phase}</span>` +
      (w ? ` · California's ${w.label} winter: <b>${Math.round(w.pct)}% of normal rain</b>` : ""),
  );
  const variable = key === "sst" ? "sst" : "pr";
  const year = await loadYear(variable, d.year);
  if (token !== renderToken) return; // a newer month was picked while loading
  const anom = year[d.month - 1];
  current = { anom, key, month: d.month, index: i };
  drawCanvas(LAYERS[key].values(anom, d.month), key);
}

overlay
  .on("pointermove", (event) => {
    if (!current) return;
    const [mx, my] = d3.pointer(event);
    const [lon, lat] = toLonLat(mx, my);
    hoverDot.style("display", null).attr("cx", mx).attr("cy", my);
    const monthName = MONTH_NAMES[current.month - 1];
    const lon180 = ((lon + 540) % 360) - 180;
    const inCA = d3.geoContains(california, [lon180, lat]);
    const head = `<b>${inCA ? "California · " : ""}${latFmt(lat)}, ${lonFmt(lon)}</b> · ${monthLabel(current.index)}<br>`;
    if (current.key === "sst") {
      if (d3.geoContains(land, [lon180, lat])) { showTip(event, `${head}Land`); return; }
      const anom = sample(current.anom, lon, lat);
      if (Number.isNaN(anom)) { showTip(event, `${head}No data`); return; }
      const diff = `<b style="color:${anom >= 0 ? RED : BLUE}">${Math.abs(anom).toFixed(1)} °C ${anom >= 0 ? "warmer" : "colder"}</b>`;
      if (climMaps) {
        const normal = sample(climMaps.sst[current.month - 1], lon, lat);
        showTip(event, `${head}Ocean temperature: <b>${(normal + anom).toFixed(1)} °C</b><br>${diff} than a usual ${monthName} (${normal.toFixed(1)} °C)`);
      } else {
        showTip(event, `${head}${diff} than a usual ${monthName}`);
      }
      return;
    }
    const anom = sample(current.anom, lon, lat);
    if (Number.isNaN(anom)) { showTip(event, `${head}No data`); return; }
    if (current.key === "prPct") {
      const normal = sample(climMaps.pr[current.month - 1], lon, lat);
      const actual = Math.max(0, normal + anom);
      if (normal < DRY_LIMIT) {
        showTip(event, `${head}Normally almost dry in ${monthName} (${normal.toFixed(1)} mm/day)<br>This month: ${actual.toFixed(1)} mm/day`);
        return;
      }
      const ratio = actual / normal;
      showTip(event,
        `${head}Rain: <b>${actual.toFixed(1)} mm/day</b><br>` +
        `<b style="color:${ratio >= 1 ? "#1b7a6e" : "#9a6a1f"}">${pctFmt(ratio)} of a usual ${monthName}</b> (${normal.toFixed(1)} mm/day)`);
    } else {
      showTip(event, `${head}<b>${Math.abs(anom).toFixed(1)} mm/day ${anom >= 0 ? "wetter" : "drier"}</b> than a usual ${monthName}`);
    }
  })
  .on("pointerleave", () => { hideTip(); hoverDot.style("display", "none"); });

// legend
const legend = d3.select("#legend").attr("viewBox", "0 0 320 46");
const grad = legend.append("defs").append("linearGradient").attr("id", "legend-grad");
legend.append("rect").attr("x", 10).attr("y", 14).attr("width", 300).attr("height", 10)
  .attr("fill", "url(#legend-grad)").attr("stroke", "#c9c6bd");
const legendAxis = legend.append("g").attr("class", "axis").attr("transform", "translate(0,24)");
const legendLow = legend.append("text").attr("x", 10).attr("y", 9).style("font-size", "10.5px");
const legendHigh = legend.append("text").attr("x", 310).attr("y", 9).attr("text-anchor", "end").style("font-size", "10.5px");

function drawLegend() {
  const L = LAYERS[layerKey()];
  grad.selectAll("stop").data(d3.range(0, 1.0001, 0.05)).join("stop")
    .attr("offset", (t) => `${t * 100}%`)
    .attr("stop-color", (t) => L.color(-L.lim + 2 * L.lim * t));
  const ls = d3.scaleLinear([-L.lim, L.lim], [10, 310]);
  legendAxis.call(d3.axisBottom(ls).tickValues(L.ticks).tickSize(4).tickFormat(L.tickFmt))
    .call((g) => g.select(".domain").remove());
  legendLow.text(L.low);
  legendHigh.text(L.high);
  d3.select("#map-caption").text(L.caption);
  const sst = state.variable === "sst";
  landFill.style("display", sst ? null : "none");
  coast.attr("stroke", sst ? "#6b5d3e" : "#2f2c27").attr("stroke-width", sst ? 0.8 : 1);
}

// ---------------------------------------------------------------------------
// Answer: every winter, ONI vs California rain
// ---------------------------------------------------------------------------
const SW = 600;
const SH = 360;
const sm = { l: 52, r: 16, t: 14, b: 40 };
const scatter = d3.select("#scatter").attr("viewBox", `0 0 ${SW} ${SH}`);
let dots = null;
if (caWinters) {
  const sx = d3.scaleLinear([-2.4, 2.8], [sm.l, SW - sm.r]);
  const sy = d3.scaleLinear([0, pctMax], [SH - sm.b, sm.t]);
  scatter.append("rect").attr("x", sx(0.5)).attr("y", sm.t).attr("width", sx(2.8) - sx(0.5)).attr("height", SH - sm.b - sm.t)
    .attr("fill", RED).attr("fill-opacity", 0.06);
  scatter.append("rect").attr("x", sx(-2.4)).attr("y", sm.t).attr("width", sx(-0.5) - sx(-2.4)).attr("height", SH - sm.b - sm.t)
    .attr("fill", BLUE).attr("fill-opacity", 0.06);
  scatter.append("text").attr("x", sx(2.75)).attr("y", sm.t + 14).attr("text-anchor", "end").style("fill", RED).style("font-weight", 600).text("El Niño winters →");
  scatter.append("text").attr("x", sx(-2.35)).attr("y", sm.t + 14).style("fill", BLUE).style("font-weight", 600).text("← La Niña winters");
  scatter.append("g").attr("class", "axis").attr("transform", `translate(0,${SH - sm.b})`)
    .call(d3.axisBottom(sx).ticks(8).tickFormat((d) => `${d > 0 ? "+" : ""}${d}°`));
  scatter.append("text").attr("x", (sm.l + SW - sm.r) / 2).attr("y", SH - 6).attr("text-anchor", "middle")
    .text("Winter El Niño strength (Dec–Feb ONI, °C)");
  scatter.append("g").attr("class", "axis").attr("transform", `translate(${sm.l},0)`)
    .call(d3.axisLeft(sy).tickValues([0, 50, 100, 150, 200, 250, 300].filter((t) => t <= pctMax)).tickFormat((d) => `${d}%`));
  scatter.append("text").attr("transform", `translate(14,${(sm.t + SH - sm.b) / 2}) rotate(-90)`).attr("text-anchor", "middle")
    .text("California winter rain, % of normal");
  scatter.append("line").attr("x1", sm.l).attr("x2", SW - sm.r).attr("y1", sy(100)).attr("y2", sy(100))
    .attr("stroke", "#7d7a72").attr("stroke-dasharray", "4,3");
  scatter.append("text").attr("x", sm.l + 4).attr("y", sy(100) - 4).style("font-size", "10px").text("normal");

  dots = scatter.append("g").selectAll("circle").data(caWinters).join("circle")
    .attr("cx", (w) => sx(w.oni))
    .attr("cy", (w) => sy(w.pct))
    .attr("r", 6)
    .attr("fill", (w) => TYPE_COLOR[winterType(w.oni)])
    .attr("stroke", "#fff")
    .attr("stroke-width", 1)
    .style("cursor", "pointer")
    .on("pointermove", (event, w) => showTip(event, `${winterTip(w)}<br><span style="color:#8a8880">Click to show this winter above</span>`))
    .on("pointerleave", hideTip)
    .on("click", (event, w) => { stopPlay(); setMonth(indexOf.get(`${w.winter}-01`)); });

  // label the strongest El Niño winters
  const labeled = [...caWinters].sort((a, b) => b.oni - a.oni).slice(0, 4);
  // nudge labels apart when two winters sit close together
  const labelY = new Map();
  [...labeled].sort((a, b) => sy(a.pct) - sy(b.pct)).forEach((w, k, arr) => {
    let yy = sy(w.pct) + 4;
    if (k > 0) yy = Math.max(yy, labelY.get(arr[k - 1]) + 12);
    labelY.set(w, yy);
  });
  scatter.append("g").selectAll("text").data(labeled).join("text")
    .attr("x", (w) => sx(w.oni) + 8)
    .attr("y", (w) => labelY.get(w))
    .style("font-size", "10.5px")
    .style("pointer-events", "none")
    .text((w) => w.label);

  // the summary table
  const types = ["Strong El Niño", "Weaker El Niño", "Neutral", "La Niña"];
  const rows = types.map((t) => {
    const ws = caWinters.filter((w) => winterType(w.oni) === t);
    return { t, n: ws.length, wet: ws.filter((w) => w.pct > 100).length, avg: d3.mean(ws, (w) => w.pct) };
  });
  const r = (() => {
    const mx = d3.mean(caWinters, (w) => w.oni);
    const my = d3.mean(caWinters, (w) => w.pct);
    const sxy = d3.sum(caWinters, (w) => (w.oni - mx) * (w.pct - my));
    return sxy / Math.sqrt(d3.sum(caWinters, (w) => (w.oni - mx) ** 2) * d3.sum(caWinters, (w) => (w.pct - my) ** 2));
  })();
  const strong = rows[0];
  const nina = rows[3];
  d3.select("#answer-text").html(`
    <table>
      <tr><th>Winter type (Dec–Feb ONI)</th><th class="num">Winters</th><th class="num">Wetter than normal</th><th class="num">Avg. rain (% of normal)</th></tr>
      ${rows.map((row) => `<tr>
        <td><span class="swatch" style="background:${TYPE_COLOR[row.t]}"></span>${row.t}
          <span style="color:#8a8880;font-size:0.8rem">${{ "Strong El Niño": "≥ +1.5 °C", "Weaker El Niño": "+0.5 to +1.5", Neutral: "−0.5 to +0.5", "La Niña": "≤ −0.5 °C" }[row.t]}</span></td>
        <td class="num">${row.n}</td><td class="num">${row.wet} of ${row.n}</td><td class="num">${Math.round(row.avg)}%</td></tr>`).join("")}
    </table>
    <p>In the model, the <b>${strong.n} strong El Niño winters</b> averaged <b>${Math.round(strong.avg)}%</b> of California's normal winter rain,
    and ${strong.wet} of ${strong.n} were wetter than normal. La Niña winters averaged <b>${Math.round(nina.avg)}%</b>.</p>
    <p>Across all ${caWinters.length} winters, the link between El Niño strength and California rain is
    ${Math.abs(r) < 0.2 ? "weak" : Math.abs(r) < 0.5 ? "real but loose" : "strong"} (correlation r = ${r.toFixed(2)}):
    the dots are widely scattered, so a big El Niño ${r > 0.2 ? "tilts the odds toward a wet winter but doesn't guarantee one" : "is not a reliable sign of a wet winter"}.</p>
  `);
} else {
  scatter.attr("viewBox", `0 0 ${SW} 60`);
  scatter.append("text").attr("x", 10).attr("y", 30).style("fill", "#9a6b00")
    .text("Run exploratory/export_climatology.ipynb to add California's winters here.");
}

function highlightWinter() {
  if (!dots) return;
  const w0 = winterOfMonth(state.month);
  dots.attr("stroke", (w) => (w === w0 ? "#1f1e1c" : "#fff")).attr("stroke-width", (w) => (w === w0 ? 2.5 : 1))
    .attr("r", (w) => (w === w0 ? 8 : 6));
  if (w0) dots.filter((w) => w === w0).raise();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function setMonth(i) {
  state.month = Math.max(0, Math.min(N - 1, i));
  drawHandle();
  highlightWinter();
  renderMap();
}

function setVariable(vKey) {
  state.variable = vKey;
  d3.selectAll(".seg button").classed("active", function () { return this.dataset.var === vKey; });
  drawLegend();
  renderMap();
  prefetch(vKey);
}
d3.selectAll(".seg button").on("click", function () { setVariable(this.dataset.var); });

let playTimer = null;
const playBtn = d3.select("#play");
function stopPlay() {
  state.playing = false;
  if (playTimer) playTimer.stop();
  playTimer = null;
  playBtn.text("▶ Play").classed("active", false);
}
function startPlay() {
  stopPlay();
  if (state.month >= N - 1) setMonth(0);
  state.playing = true;
  playBtn.text("❚❚ Pause").classed("active", true);
  playTimer = d3.interval(() => {
    if (state.month >= N - 1) { stopPlay(); return; }
    setMonth(state.month + 1);
  }, 200);
}
playBtn.on("click", () => (state.playing ? stopPlay() : startPlay()));

const eventSelect = d3.select("#event-select");
eventSelect.selectAll("option.ev").data(events).join("option")
  .attr("class", "ev")
  .attr("value", (e, i) => i)
  .text((e) => `${e.label} (peak ${fmt(e.peak, 2)} °C)`);
eventSelect.on("change", function () {
  if (this.value === "") return;
  stopPlay();
  setMonth(events[+this.value].peakIndex);
  this.value = "";
});

window.addEventListener("keydown", (event) => {
  if (["SELECT", "INPUT", "TEXTAREA"].includes(event.target.tagName)) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  stopPlay();
  setMonth(state.month + (event.key === "ArrowRight" ? 1 : -1));
});

// ---------------------------------------------------------------------------
// Start on December 1997, the peak of the strongest El Niño in the record
// ---------------------------------------------------------------------------
drawLegend();
drawHandle();
highlightWinter();
await renderMap();
prefetch("sst");
