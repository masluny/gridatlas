import { atlas } from "./atlas.js";
import { countryAt, nearestPlace } from "./locate.js";
import { preparePolygons } from "./geom.js";
import { GRID, windowAt, windowFromId, windowsOverlapping } from "./grid.js";
import { projectY, unprojectY } from "./proj.js";

const WATERS = [
  ["Pacific Ocean", -160, 0],
  ["Pacific Ocean", -140, -30],
  ["Atlantic Ocean", -40, 25],
  ["Atlantic Ocean", -20, -20],
  ["Indian Ocean", 75, -15],
  ["Arctic Ocean", 0, 78],
  ["Southern Ocean", 20, -62],
  ["Mediterranean", 18, 36],
];

const CSS = `
.ga-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #7eafc0;
  touch-action: none;
  outline: none;
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  color: #2c241c;
}
.ga-root canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}
.ga-readout, .ga-corner {
  position: absolute;
  z-index: 2;
  background: rgba(255, 250, 242, 0.96);
  border: 1px solid rgba(70, 52, 32, 0.22);
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(40, 28, 16, 0.16);
  pointer-events: none;
}
.ga-readout { left: 14px; bottom: 14px; padding: 8px 12px 9px; min-width: 210px; }
.ga-id {
  font-family: Palatino, "Palatino Linotype", Georgia, serif;
  font-size: 26px;
  line-height: 1;
  letter-spacing: 0.01em;
}
.ga-meta { margin-top: 4px; font-size: 12px; line-height: 1.35; color: #5c5146; }
.ga-corner { right: 14px; bottom: 14px; padding: 7px 10px 6px; }
.ga-scale-bar {
  display: block;
  height: 7px;
  border-left: 2px solid #2c241c;
  border-right: 2px solid #2c241c;
  border-bottom: 2px solid #2c241c;
  box-sizing: border-box;
}
.ga-scale-label { display: block; margin-top: 2px; font-size: 11px; text-align: center; }
.ga-zoom {
  position: absolute;
  z-index: 2;
  right: 14px;
  top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ga-zoom button {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid rgba(70, 52, 32, 0.35);
  background: #fffaf2;
  box-shadow: 0 6px 18px rgba(40, 28, 16, 0.16);
  color: #2c241c;
  font: 600 18px/1 "Avenir Next", "Segoe UI", sans-serif;
  cursor: pointer;
  padding: 0;
}
.ga-zoom button:hover { background: #fffaf2; }
@media (max-width: 720px) {
  .ga-readout {
    top: 8px;
    right: 64px;
    bottom: auto;
    left: 8px;
    width: auto;
    height: max-content;
    min-width: 0;
  }
}
`;

function describe(lat, lon) {
  const win = windowAt(lat, lon);
  return {
    ...win,
    country: countryAt(win.center.lat, win.center.lon),
    near: nearestPlace(win.center.lat, win.center.lon),
  };
}

function hemisphere(value, positive, negative) {
  const side = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(2)}° ${side}`;
}

let styleMounted = false;

export class GridMap {
  constructor(container, options = {}) {
    if (!container) throw new Error("GridMap needs a container element");
    this.onSelect = options.onSelect || null;
    this.onHover = options.onHover || null;
    this.inset = options.inset || null;
    this.avoid = options.avoid || null;
    this.flyToken = 0;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.hover = null;
    this.selection = null;
    this.highlights = [];
    this.taken = [];
    this.offsets = [0];
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.centerLon = 12;
    this.centerLat = 16;
    this.scale = 1;
    this.viewWest = -180;
    this.viewEast = 180;
    this.viewSouth = -60;
    this.viewNorth = 75;
    this.frame = 0;
    this.pendingFly = null;
    this.scaleLabel = "";

    const position = getComputedStyle(container).position;
    if (position === "static") container.style.position = "relative";

    if (!styleMounted) {
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);
      styleMounted = true;
    }

    this.root = document.createElement("div");
    this.root.className = "ga-root";
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "application");
    this.root.setAttribute("aria-label", "World map of selectable windows");
    container.appendChild(this.root);

    this.canvas = document.createElement("canvas");
    this.canvas.draggable = false;
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.fine = preparePolygons(atlas.land);
    this.coarse = preparePolygons(atlas.coarse);
    this.lakes = preparePolygons(atlas.lakes);
    this.rivers = atlas.rivers.map((river) => ({
      rank: river.rank,
      lines: river.lines.map((line) => {
        let minLon = 180;
        let minLat = 90;
        let maxLon = -180;
        let maxLat = -90;
        for (let i = 0; i < line.length; i++) {
          const lon = line[i][0];
          const lat = line[i][1];
          if (lon < minLon) minLon = lon;
          if (lat < minLat) minLat = lat;
          if (lon > maxLon) maxLon = lon;
          if (lat > maxLat) maxLat = lat;
        }
        return { pts: line, bbox: [minLon, minLat, maxLon, maxLat] };
      }),
    }));

    if (options.readout !== false) {
      this.readout = document.createElement("div");
      this.readout.className = "ga-readout";
      this.readout.setAttribute("aria-live", "polite");
      this.idEl = document.createElement("div");
      this.idEl.className = "ga-id";
      this.idEl.textContent = "-";
      this.metaEl = document.createElement("div");
      this.metaEl.className = "ga-meta";
      this.metaEl.textContent = "Move across the map";
      this.readout.append(this.idEl, this.metaEl);
      this.root.appendChild(this.readout);
    }

    this.corner = document.createElement("div");
    this.corner.className = "ga-corner";
    this.scaleBarEl = document.createElement("span");
    this.scaleBarEl.className = "ga-scale-bar";
    this.scaleLabelEl = document.createElement("span");
    this.scaleLabelEl.className = "ga-scale-label";
    this.corner.append(this.scaleBarEl, this.scaleLabelEl);
    this.root.appendChild(this.corner);

    this.zoomBar = document.createElement("div");
    this.zoomBar.className = "ga-zoom";
    this.zoomBar.append(
      this.button("+", "Zoom in", () => this.zoomBy(1.5)),
      this.button("−", "Zoom out", () => this.zoomBy(1 / 1.5)),
      this.button("◯", "Show the whole world", () => this.fitWorld()),
    );
    this.root.appendChild(this.zoomBar);

    this.onPointerDown = (event) => this.pointerDown(event);
    this.onPointerMove = (event) => this.pointerMove(event);
    this.onPointerUp = (event) => this.pointerUp(event);
    this.onWheel = (event) => this.wheel(event);
    this.onDbl = (event) => this.doubleClick(event);
    this.onKey = (event) => this.key(event);
    this.onLeave = (event) => this.leave(event);

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.onDbl);
    this.root.addEventListener("keydown", this.onKey);

    this.observer = new ResizeObserver(() => {
      this.layout();
      if (this.pendingFly && this.width >= 2 && this.height >= 2) this.startFly();
      this.requestDraw();
    });
    this.observer.observe(this.root);
    this.layout();
    this.requestDraw();
  }

  button(text, label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.cancelFly();
      action();
    });
    return button;
  }

  destroy() {
    this.cancelFly();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("dblclick", this.onDbl);
    this.root.removeEventListener("keydown", this.onKey);
    this.root.remove();
  }

  layout() {
    const rect = this.root.getBoundingClientRect();
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const first = this.width < 2 && width >= 2;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    if (first) {
      this.centerLon = 12;
      this.centerLat = 16;
      this.scale = width;
    }
    this.clampView();
  }

  clampView() {
    if (this.width < 2) return;
    const minScale = this.width;
    const maxScale = Math.max(minScale, 0.85 * Math.min(this.width, this.height) * GRID.cols);
    if (this.scale < minScale) this.scale = minScale;
    if (this.scale > maxScale) this.scale = maxScale;
    if (this.centerLat > 83) this.centerLat = 83;
    if (this.centerLat < -83) this.centerLat = -83;
  }

  requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  cancelFly() {
    this.flyToken += 1;
  }

  local(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  xOf(lon) {
    return ((lon - this.centerLon) / 360) * this.scale + this.width / 2;
  }

  yOf(lat) {
    return (projectY(lat) - projectY(this.centerLat)) * this.scale + this.height / 2;
  }

  toScreen(lon, lat) {
    return [this.xOf(lon), this.yOf(lat)];
  }

  fromScreen(x, y) {
    const lon = this.centerLon + ((x - this.width / 2) / this.scale) * 360;
    const py = projectY(this.centerLat) + (y - this.height / 2) / this.scale;
    return [lon, unprojectY(py)];
  }

  anchor(lon, lat, x, y) {
    this.centerLon = lon - ((x - this.width / 2) / this.scale) * 360;
    const py = projectY(lat) - (y - this.height / 2) / this.scale;
    this.centerLat = unprojectY(py);
  }

  updateView() {
    const [west] = this.fromScreen(0, this.height / 2);
    const [east] = this.fromScreen(this.width, this.height / 2);
    const [, north] = this.fromScreen(this.width / 2, 0);
    const [, south] = this.fromScreen(this.width / 2, this.height);
    this.viewWest = west;
    this.viewEast = east;
    this.viewNorth = Math.min(90, north);
    this.viewSouth = Math.max(-90, south);
    const k0 = Math.ceil((west - 180) / 360);
    const k1 = Math.floor((east + 180) / 360);
    this.offsets = [];
    for (let k = k0; k <= k1; k++) this.offsets.push(k * 360);
    if (!this.offsets.length) this.offsets = [0];
  }

  zoomBy(factor) {
    if (this.width < 2) return;
    const x = this.width / 2;
    const y = this.height / 2;
    const [lon, lat] = this.fromScreen(x, y);
    this.scale *= factor;
    this.clampView();
    this.anchor(lon, lat, x, y);
    this.clampView();
    this.requestDraw();
  }

  nudge(sx, sy) {
    this.cancelFly();
    const dx = sx * this.width * 0.18;
    const dy = sy * this.height * 0.18;
    this.centerLon += (dx / this.scale) * 360;
    this.centerLat = unprojectY(projectY(this.centerLat) + dy / this.scale);
    this.clampView();
    this.requestDraw();
  }

  fitWorld() {
    this.cancelFly();
    this.centerLon = 12;
    this.centerLat = 16;
    this.scale = this.width || 1;
    this.clampView();
    this.requestDraw();
  }

  flyTo(lat, lon, options = {}) {
    this.pendingFly = { lat, lon, options };
    if (this.width < 2 || this.height < 2) return;
    this.startFly();
  }

  startFly() {
    const pending = this.pendingFly;
    if (!pending) return;
    this.pendingFly = null;
    const { lat, lon, options } = pending;
    const across = options.windowsAcross ?? 6;
    const px = Math.min(this.width, this.height);
    const scale = options.scale ?? (px / across) * GRID.cols;
    const pad = options.padding || {};
    const focusX = ((pad.left || 0) + this.width - (pad.right || 0)) / 2;
    const focusY = ((pad.top || 0) + this.height - (pad.bottom || 0)) / 2;
    const targetLon = lon - ((focusX - this.width / 2) / scale) * 360;
    const targetLat = unprojectY(projectY(lat) - (focusY - this.height / 2) / scale);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      this.centerLat = targetLat;
      this.centerLon = targetLon;
      this.scale = scale;
      this.clampView();
      this.requestDraw();
      return;
    }
    const from = { lat: this.centerLat, lon: this.centerLon, scale: this.scale };
    const token = ++this.flyToken;
    const started = performance.now();
    const step = (now) => {
      if (token !== this.flyToken) return;
      const t = Math.min(1, (now - started) / 760);
      const eased = 1 - (1 - t) ** 3;
      this.centerLat = from.lat + (targetLat - from.lat) * eased;
      this.centerLon = from.lon + (targetLon - from.lon) * eased;
      const ratio = scale / from.scale;
      this.scale = from.scale * ratio ** eased;
      this.clampView();
      this.draw();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  highlight(windows) {
    this.highlights = (windows || []).map((item) =>
      typeof item === "string" ? windowFromId(item) : item,
    );
    this.requestDraw();
  }

  selectAt(lat, lon) {
    const described = describe(lat, lon);
    this.selection = described;
    this.updateReadout(this.hover || described);
    if (this.onSelect) this.onSelect(described);
    this.requestDraw();
    return described;
  }

  getSelection() {
    return this.selection;
  }

  pointerDown(event) {
    this.root.focus({ preventScroll: true });
    this.cancelFly();
    const [x, y] = this.local(event);
    this.pointers.set(event.pointerId, { x, y });
    this.canvas.setPointerCapture(event.pointerId);
    if (this.pointers.size === 1) {
      this.drag = { id: event.pointerId, x, y, lon: this.centerLon, lat: this.centerLat, moved: false };
      this.pinch = null;
    } else if (this.pointers.size >= 2) {
      this.drag = null;
      const pts = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        scale: this.scale,
        lon: this.centerLon,
        lat: this.centerLat,
      };
    }
  }

  pointerMove(event) {
    const [x, y] = this.local(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x, y });

    if (this.pinch && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this.scale = this.pinch.scale * (dist / this.pinch.dist);
      this.centerLon = this.pinch.lon;
      this.centerLat = this.pinch.lat;
      this.clampView();
      this.requestDraw();
      return;
    }

    if (this.drag && event.pointerId === this.drag.id) {
      const dx = x - this.drag.x;
      const dy = y - this.drag.y;
      if (dx * dx + dy * dy > 16) this.drag.moved = true;
      this.centerLon = this.drag.lon - (dx / this.scale) * 360;
      this.centerLat = unprojectY(projectY(this.drag.lat) - dy / this.scale);
      this.clampView();
      this.canvas.style.cursor = "grabbing";
      this.requestDraw();
      return;
    }

    this.hoverAt(x, y);
  }

  pointerUp(event) {
    const drag = this.drag && this.drag.id === event.pointerId ? this.drag : null;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!drag) return;
    this.drag = null;
    this.canvas.style.cursor = "crosshair";
    if (!drag.moved) {
      const [x, y] = this.local(event);
      const [lon, lat] = this.fromScreen(x, y);
      this.selectAt(lat, lon);
    }
  }

  leave(event) {
    if (this.drag || this.pointers.size) return;
    if (event.pointerType === "touch") return;
    this.hover = null;
    this.updateReadout(this.selection);
    if (this.onHover) this.onHover(null);
    this.requestDraw();
  }

  hoverAt(x, y) {
    const [lon, lat] = this.fromScreen(x, y);
    const win = windowAt(lat, lon);
    if (this.hover && this.hover.id === win.id) return;
    this.hover = describe(lat, lon);
    this.updateReadout(this.hover);
    if (this.onHover) this.onHover(this.hover);
    this.requestDraw();
  }

  wheel(event) {
    event.preventDefault();
    this.cancelFly();
    const [x, y] = this.local(event);
    const [lon, lat] = this.fromScreen(x, y);
    let dy = event.deltaY;
    if (event.deltaMode === 1) dy *= 16;
    else if (event.deltaMode === 2) dy *= this.height;
    const gain = event.ctrlKey ? 0.01 : 0.0015;
    this.scale *= Math.exp(-dy * gain);
    this.clampView();
    this.anchor(lon, lat, x, y);
    this.clampView();
    this.requestDraw();
  }

  doubleClick(event) {
    this.cancelFly();
    const [x, y] = this.local(event);
    const [lon, lat] = this.fromScreen(x, y);
    this.scale *= 2;
    this.clampView();
    this.anchor(lon, lat, x, y);
    this.clampView();
    this.requestDraw();
  }

  key(event) {
    if (event.target !== this.root) return;
    if (event.key === "ArrowLeft") this.nudge(-1, 0);
    else if (event.key === "ArrowRight") this.nudge(1, 0);
    else if (event.key === "ArrowUp") this.nudge(0, -1);
    else if (event.key === "ArrowDown") this.nudge(0, 1);
    else if (event.key === "+" || event.key === "=") this.zoomBy(1.4);
    else if (event.key === "-" || event.key === "_") this.zoomBy(1 / 1.4);
    else if (event.key === "0") this.fitWorld();
    else return;
    event.preventDefault();
  }

  updateReadout(win) {
    if (!this.readout) return;
    if (!win) {
      this.idEl.textContent = "-";
      this.metaEl.textContent = "Move across the map";
      return;
    }
    this.idEl.textContent = win.id;
    const where = `${hemisphere(win.center.lat, "N", "S")}, ${hemisphere(win.center.lon, "E", "W")}`;
    const size = `${win.widthKm.toFixed(1)} × ${win.heightKm.toFixed(1)} km`;
    const place = [];
    if (win.country) place.push(win.country);
    if (win.near && win.near.km < 40) place.push(win.near.name);
    else if (win.near && win.near.km < 600) place.push(`near ${win.near.name}`);
    else if (!win.country) place.push("Open ocean");
    this.metaEl.textContent = place.length ? `${where} · ${size} · ${place.join(", ")}` : `${where} · ${size}`;
  }

  updateScale() {
    const lat = Math.max(-70, Math.min(70, this.centerLat));
    const metersPerPx = (111320 * Math.cos((lat * Math.PI) / 180)) / (this.scale / 360);
    const meters = metersPerPx * 110;
    if (!(meters > 0) || !Number.isFinite(meters)) return;
    const pow = 10 ** Math.floor(Math.log10(meters));
    const n = meters / pow;
    const nice = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    const use = nice * pow;
    const px = Math.max(28, Math.min(180, use / metersPerPx));
    const label = use >= 1000 ? `${use / 1000} km` : `${Math.round(use)} m`;
    if (label !== this.scaleLabel) {
      this.scaleLabelEl.textContent = label;
      this.scaleLabel = label;
    }
    this.scaleBarEl.style.width = `${px}px`;
  }

  bboxHits(bbox, offset) {
    const pad = 3;
    return (
      bbox[2] + offset >= this.viewWest - pad &&
      bbox[0] + offset <= this.viewEast + pad &&
      bbox[3] >= this.viewSouth - pad &&
      bbox[1] <= this.viewNorth + pad
    );
  }

  traceRing(ring, offset) {
    const ctx = this.ctx;
    for (let i = 0; i < ring.length; i++) {
      const x = this.xOf(ring[i][0] + offset);
      const y = this.yOf(ring[i][1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  traceLine(line, offset) {
    const ctx = this.ctx;
    for (let i = 0; i < line.length; i++) {
      const x = this.xOf(line[i][0] + offset);
      const y = this.yOf(line[i][1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  drawPolygons(list, fill) {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    for (let i = 0; i < list.length; i++) {
      const parts = list[i].parts;
      for (let k = 0; k < this.offsets.length; k++) {
        const offset = this.offsets[k];
        ctx.beginPath();
        let any = false;
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (!this.bboxHits(part.bbox, offset)) continue;
          any = true;
          this.traceRing(part.outer, offset);
          for (let h = 0; h < part.holes.length; h++) this.traceRing(part.holes[h], offset);
        }
        if (any) ctx.fill("evenodd");
      }
    }
  }

  strokePolygons(list) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < list.length; i++) {
      const parts = list[i].parts;
      for (let k = 0; k < this.offsets.length; k++) {
        const offset = this.offsets[k];
        for (let p = 0; p < parts.length; p++) {
          const part = parts[p];
          if (!this.bboxHits(part.bbox, offset)) continue;
          this.traceRing(part.outer, offset);
        }
      }
    }
    ctx.strokeStyle = "rgba(66, 98, 58, 0.8)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  drawRivers(cellPx) {
    const ctx = this.ctx;
    const boost = Math.max(0.75, Math.min(2.6, this.scale / 6000));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#4d86a0";
    const ranks = cellPx > 5 ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4];
    for (let r = 0; r < ranks.length; r++) {
      const rank = ranks[r];
      ctx.beginPath();
      let any = false;
      const rivers = this.rivers;
      for (let i = 0; i < rivers.length; i++) {
        const river = rivers[i];
        if (river.rank !== rank) continue;
        const lines = river.lines;
        for (let n = 0; n < lines.length; n++) {
          const line = lines[n];
          for (let k = 0; k < this.offsets.length; k++) {
            const offset = this.offsets[k];
            if (!this.bboxHits(line.bbox, offset)) continue;
            any = true;
            this.traceLine(line.pts, offset);
          }
        }
      }
      if (!any) continue;
      const base = rank <= 2 ? 1.8 : rank <= 4 ? 1.25 : 0.75;
      ctx.lineWidth = base * boost;
      ctx.stroke();
    }
  }

  drawGraticule() {
    const ctx = this.ctx;
    const drawLons = (lons, style, width) => {
      ctx.beginPath();
      for (let i = 0; i < lons.length; i++) {
        for (let k = 0; k < this.offsets.length; k++) {
          const x = this.xOf(lons[i] + this.offsets[k]);
          if (x < -2 || x > this.width + 2) continue;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, this.height);
        }
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    const drawLats = (lats, style, width) => {
      ctx.beginPath();
      for (let i = 0; i < lats.length; i++) {
        const y = this.yOf(lats[i]);
        if (y < -2 || y > this.height + 2) continue;
        ctx.moveTo(0, y);
        ctx.lineTo(this.width, y);
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    const lons = [];
    const majors = [];
    for (let lon = -180; lon <= 180; lon += 30) {
      if (lon === 0 || Math.abs(lon) === 180) majors.push(lon);
      else lons.push(lon);
    }
    const lats = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      if (lat !== 0) lats.push(lat);
    }
    drawLons(lons, "rgba(44, 36, 28, 0.13)", 0.7);
    drawLats(lats, "rgba(44, 36, 28, 0.13)", 0.7);
    drawLons(majors, "rgba(44, 36, 28, 0.28)", 1);
    drawLats([0], "rgba(44, 36, 28, 0.28)", 1);
  }

  drawNet() {
    const ctx = this.ctx;
    const lonStep = 360 / GRID.cols;
    const latStep = 180 / GRID.rows;
    ctx.beginPath();
    let lon = Math.floor((this.viewWest + 180) / lonStep) * lonStep - 180;
    for (; lon <= this.viewEast + lonStep; lon += lonStep) {
      const x = this.xOf(lon);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
    }
    const south = Math.max(-85, this.viewSouth);
    const north = Math.min(85, this.viewNorth);
    let lat = Math.floor((south + 90) / latStep) * latStep - 90;
    for (; lat <= north; lat += latStep) {
      const y = this.yOf(lat);
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.strokeStyle = "rgba(40, 64, 36, 0.24)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  paintWindow(win, fill, stroke, dashed) {
    const ctx = this.ctx;
    const width = win.bounds.east - win.bounds.west;
    for (let k = 0; k < this.offsets.length; k++) {
      const x0 = this.xOf(win.bounds.west + this.offsets[k]);
      const x1 = this.xOf(win.bounds.west + width + this.offsets[k]);
      const y0 = this.yOf(win.bounds.north);
      const y1 = this.yOf(win.bounds.south);
      if (x1 < 0 || x0 > this.width || y1 < 0 || y0 > this.height) continue;
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      if (stroke) {
        ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = dashed ? 1.75 : 2.25;
        ctx.strokeRect(x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 2);
        ctx.setLineDash([]);
      }
    }
  }

  drawWindowNames(windows, cellPx) {
    if (cellPx < 56 || !windows.length) return;
    const ctx = this.ctx;
    const size = Math.max(15, Math.min(26, cellPx * 0.11));
    ctx.font = `600 ${size}px Palatino, "Palatino Linotype", Georgia, serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const seen = new Set();
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      if (!win || seen.has(win.id)) continue;
      seen.add(win.id);
      const width = win.bounds.east - win.bounds.west;
      for (let k = 0; k < this.offsets.length; k++) {
        const x = this.xOf(win.bounds.west + width / 2 + this.offsets[k]);
        const y = this.yOf(win.center.lat);
        if (x < 24 || x > this.width - 24 || y < 20 || y > this.height - 20) continue;
        const metrics = ctx.measureText(win.id);
        const boxW = metrics.width + 14;
        const boxH = size + 8;
        if (!this.claim(x - boxW / 2, y - boxH / 2, boxW, boxH)) continue;
        ctx.fillStyle = "rgba(255, 250, 242, 0.88)";
        ctx.beginPath();
        ctx.roundRect(x - boxW / 2, y - boxH / 2, boxW, boxH, 6);
        ctx.fill();
        ctx.fillStyle = "#0a4f58";
        ctx.fillText(win.id, x, y + 1);
      }
    }
  }

  minPop(cellPx) {
    if (cellPx < 2.5) return 2000000;
    if (cellPx < 6) return 500000;
    if (cellPx < 14) return 120000;
    if (cellPx < 36) return 30000;
    return 0;
  }

  drawPlaces(cellPx) {
    const ctx = this.ctx;
    const minPop = this.minPop(cellPx);
    const places = atlas.places;
    const major = Math.max(minPop * 4, 50000);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    let placed = 0;
    for (let i = 0; i < places.length; i++) {
      const place = places[i];
      if (place[5] < minPop) break;
      if (placed >= 160) break;
      const big = place[5] >= major;
      ctx.font = big
        ? "600 12px Palatino, 'Palatino Linotype', Georgia, serif"
        : "500 11px Palatino, 'Palatino Linotype', Georgia, serif";
      const lat = place[3];
      const lon = place[4];
      if (lat < this.viewSouth || lat > this.viewNorth) continue;
      for (let k = 0; k < this.offsets.length; k++) {
        const x = this.xOf(lon + this.offsets[k]);
        const y = this.yOf(lat);
        if (x < -10 || x > this.width + 10 || y < -10 || y > this.height + 10) continue;
        const name = place[0];
        const metrics = ctx.measureText(name);
        const boxW = metrics.width + (big ? 12 : 10);
        const boxH = big ? 18 : 16;
        const labelX = x + 8;
        const labelY = y - (big ? 14 : 12);
        if (!this.claim(x - 4, labelY - boxH / 2, boxW + 8, boxH + (big ? 16 : 12))) continue;
        ctx.fillStyle = "#4a3828";
        ctx.beginPath();
        ctx.arc(x, y, big ? 2.4 : 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 250, 242, 0.92)";
        ctx.beginPath();
        ctx.roundRect(labelX - 4, labelY - boxH / 2, boxW, boxH, 5);
        ctx.fill();
        ctx.fillStyle = "#2f261c";
        ctx.textAlign = "left";
        ctx.fillText(name, labelX, labelY);
        ctx.textAlign = "center";
        placed += 1;
      }
    }
  }

  drawCountryLabels(cellPx) {
    if (cellPx > 12) return;
    const ctx = this.ctx;
    const maxRank = cellPx < 3 ? 2 : cellPx < 6 ? 4 : 6;
    ctx.font = "500 13px Palatino, 'Palatino Linotype', Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#3f5a36";
    ctx.lineJoin = "round";
    const labels = atlas.labels;
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (label[3] > maxRank) continue;
      const lat = label[2];
      const lon = label[1];
      if (lat < this.viewSouth || lat > this.viewNorth) continue;
      for (let k = 0; k < this.offsets.length; k++) {
        const x = this.xOf(lon + this.offsets[k]);
        const y = this.yOf(lat);
        if (x < 8 || x > this.width - 8 || y < 8 || y > this.height - 8) continue;
        const metrics = ctx.measureText(label[0]);
        if (!this.claim(x - metrics.width / 2 - 3, y - 8, metrics.width + 6, 16)) continue;
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = "rgba(214, 230, 190, 0.9)";
        ctx.strokeText(label[0], x, y);
        ctx.fillText(label[0], x, y);
      }
    }
  }

  drawWaters(cellPx) {
    if (cellPx > 5) return;
    const ctx = this.ctx;
    ctx.font = "italic 15px Palatino, 'Palatino Linotype', Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#2f5966";
    ctx.lineJoin = "round";
    for (let i = 0; i < WATERS.length; i++) {
      const water = WATERS[i];
      for (let k = 0; k < this.offsets.length; k++) {
        const x = this.xOf(water[1] + this.offsets[k]);
        const y = this.yOf(water[2]);
        if (x < 10 || x > this.width - 10 || y < 10 || y > this.height - 10) continue;
        const metrics = ctx.measureText(water[0]);
        if (!this.claim(x - metrics.width / 2 - 4, y - 9, metrics.width + 8, 18)) continue;
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = "rgba(126, 175, 192, 0.85)";
        ctx.strokeText(water[0], x, y);
        ctx.fillText(water[0], x, y);
      }
    }
  }

  claim(x, y, w, h) {
    const extra = typeof this.inset === "function" ? this.inset() : this.inset || {};
    const left = extra.left || 0;
    const top = extra.top || 0;
    const right = this.width - (extra.right || 0);
    const bottom = this.height - (extra.bottom || 0);
    const box = { l: x, t: y, r: x + w, b: y + h };
    if (box.l < left || box.t < top || box.r > right || box.b > bottom) return false;
    const taken = this.taken;
    for (let i = 0; i < taken.length; i++) {
      const other = taken[i];
      if (box.l < other.r && box.r > other.l && box.t < other.b && box.b > other.t) return false;
    }
    taken.push(box);
    return true;
  }

  draw() {
    if (this.width < 2 || this.height < 2) return;
    this.clampView();
    this.updateView();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#7eafc0";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const cellPx = this.scale / GRID.cols;
    const span = this.viewEast - this.viewWest;
    const land = span > 85 ? this.coarse : this.fine;

    this.drawPolygons(land, "#d6e6be");
    this.drawPolygons(this.lakes, "#c5e0e8");
    this.drawRivers(cellPx);
    this.strokePolygons(land);

    this.taken = this.avoid ? this.avoid().map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom })) : [];
    if (cellPx < 16) this.drawGraticule();
    else this.drawNet();

    if (cellPx >= 4) {
      for (let i = 0; i < this.highlights.length; i++) {
        this.paintWindow(this.highlights[i], "rgba(30, 190, 204, 0.12)", "rgba(10, 100, 112, 0.95)", true);
      }
      if (this.selection) {
        this.paintWindow(this.selection, "rgba(0, 168, 196, 0.45)", "#006d7f", false);
      }
      if (this.hover && (!this.selection || this.hover.id !== this.selection.id)) {
        this.paintWindow(this.hover, "rgba(0, 190, 214, 0.28)", "#0a8496", false);
      }
    }

    const named = [];
    if (cellPx > 200) {
      const visible = windowsOverlapping({
        west: this.viewWest,
        south: Math.max(-85, this.viewSouth),
        east: this.viewEast,
        north: Math.min(85, this.viewNorth),
      });
      if (visible.length <= 24) named.push(...visible);
    }
    named.push(...this.highlights);
    if (this.selection) named.push(this.selection);
    if (this.hover) named.push(this.hover);
    this.drawWindowNames(named, cellPx);
    this.drawPlaces(cellPx);
    this.drawCountryLabels(cellPx);
    this.drawWaters(cellPx);
    this.updateScale();
  }
}
