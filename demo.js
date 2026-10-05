import { GridMap, searchPlaces } from "./src/gridatlas.js";

const panel = document.querySelector("#panel");
const query = document.querySelector("#query");
const results = document.querySelector("#results");
const chosen = document.querySelector("#chosen");

const map = new GridMap(document.querySelector("#map"), {
  inset: viewPadding,
  avoid: () => [panel.getBoundingClientRect()],
  onSelect(win) {
    chosen.dataset.id = win.id;
    chosen.textContent = win.id;
    chosen.hidden = false;
  },
});

let hits = [];
let active = -1;

function viewPadding() {
  if (window.innerWidth <= 720) {
    return { left: 8, right: 56, top: 64, bottom: 64 };
  }
  return { left: 16, right: 68, top: 64, bottom: 78 };
}

function goTo(place) {
  map.flyTo(place.lat, place.lon, { windowsAcross: 24, padding: viewPadding() });
  results.hidden = true;
  query.value = "";
}

function renderHits() {
  results.replaceChildren();
  if (!hits.length) {
    results.hidden = true;
    return;
  }
  results.hidden = false;
  hits.forEach((hit, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-selected", index === active ? "true" : "false");
    const name = document.createElement("span");
    name.textContent = hit.name;
    const meta = document.createElement("small");
    meta.textContent = hit.country || "";
    button.append(name, meta);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      goTo(hit);
    });
    results.appendChild(button);
  });
}

query.addEventListener("input", () => {
  hits = searchPlaces(query.value, 7);
  active = hits.length ? 0 : -1;
  renderHits();
});

query.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    active = Math.min(hits.length - 1, active + 1);
    renderHits();
    event.preventDefault();
  } else if (event.key === "ArrowUp") {
    active = Math.max(0, active - 1);
    renderHits();
    event.preventDefault();
  } else if (event.key === "Enter" && hits[active >= 0 ? active : 0]) {
    goTo(hits[active >= 0 ? active : 0]);
    event.preventDefault();
  } else if (event.key === "Escape") {
    results.hidden = true;
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".search")) results.hidden = true;
});

chosen.addEventListener("click", async () => {
  const id = chosen.dataset.id;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    const area = document.createElement("textarea");
    area.value = id;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  chosen.textContent = "Copied";
  setTimeout(() => {
    chosen.textContent = chosen.dataset.id;
  }, 900);
});

map.flyTo(52.233, 21.0614, { windowsAcross: 24, padding: viewPadding() });
