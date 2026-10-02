# Gridatlas

An offline world map split into selectable windows of about 16 km. No map service, no API keys, no tiles to download. The geography is baked into one JavaScript file, and a window id is plain math on latitude and longitude.

![Warsaw with one window chosen](docs/warsaw.png)

## Windows

The earth is cut into 1,504 columns and 1,220 rows. Every window has the same size in degrees, which makes it about 16.3 km by 16.3 km at Warsaw's latitude. That size is not arbitrary: it is the one for which Warsaw's city bounds fall on exactly four windows, with the cross between them in the middle of the city.

A window id is its column letters and its row number, like `AFH-965`. Column `A` starts at 180° west, row `1` is the southernmost band, and a window owns its south and west edges. The same point always lands in the same window, on any device, with no lookup.

## Use the windows without the map

```js
import { windowAt, windowFromId } from "./src/gridatlas.js";

const place = windowAt(52.23, 21.01);
place.id;       // "AFH-965"
place.center;   // { lat: 52.3033, lon: 20.9441 }
place.bounds;   // { west, south, east, north }
place.widthKm;  // 16.3
place.heightKm; // 16.3

const again = windowFromId("AFH-965");
```

Store `place.id` in metadata. `windowFromId` turns it back into a center and a bounding box.

## Show the map

```js
import { GridMap } from "./src/gridatlas.js";

const map = new GridMap(document.querySelector("#map"), {
  onSelect(win) {
    console.log(win.id, win.country, win.near);
  },
});

map.flyTo(52.23, 21.01, { windowsAcross: 6 });
```

Scroll or pinch to zoom, drag to move, click a window to choose it. The net of windows appears once they are large enough to see. Arrow keys, `+`, `-` and `0` work when the map has focus.

| Option | What it does |
| --- | --- |
| `onSelect(win)` | Called when a window is chosen. `win.country` and `win.near` (the nearest city and its distance) are filled in. |
| `onHover(win)` | Called as the pointer moves over windows, with `null` when it leaves. |
| `readout` | `false` hides the window readout in the bottom left corner. |
| `inset` | Padding, or a function returning padding, that labels stay inside. |
| `avoid` | A function returning screen rectangles that labels keep away from, such as your own panels. |

| Method | What it does |
| --- | --- |
| `flyTo(lat, lon, { windowsAcross, padding })` | Moves to a point, zoomed so that many windows fit across. |
| `selectAt(lat, lon)` | Chooses the window under a point. |
| `highlight(windows)` | Outlines windows, given as objects or ids. |
| `getSelection()` | The chosen window, or `null`. |
| `fitWorld()` | Shows the whole world. |
| `destroy()` | Removes the map and its listeners. |

## Find places

```js
import { searchPlaces, nearestPlace, countryAt } from "./src/gridatlas.js";

searchPlaces("krak");       // [{ name: "Kraków", country: "Poland", lat, lon, pop }]
nearestPlace(52.23, 21.01); // { name: "Warsaw", km: 0.4, ... }
countryAt(52.23, 21.01);    // "Poland"
```

Search ignores accents and letter case, so `krakow` finds Kraków and `lodz` finds Łódź.

## What is on the map

About 26,000 cities and towns, country borders, coastlines, rivers and lakes. Labels thin out as you zoom out, so the biggest cities always win.

![The whole world](docs/world.png)

![Europe with cities, rivers and borders](docs/europe.png)

## Demo

```bash
npm run check
python3 -m http.server 8765
```

Open `http://localhost:8765`. The page opens on Warsaw with a search field in the corner.

## Rebuild the geography

The raw files live in `raw/`, which is not in the repository:

- From [Natural Earth](https://www.naturalearthdata.com/): `countries.geojson` (1:50m admin 0 countries), `lakes.geojson` (1:50m lakes), `rivers.geojson` (1:50m rivers and lake centerlines) and `places10.geojson` (1:10m populated places).
- From [Wikidata](https://www.wikidata.org/): `cities.csv`, made by `npm run fetch-cities`.

Then:

```bash
npm run pack
```

That rewrites `src/atlas.js`.

## Data

Coastlines, borders, rivers, lakes and the larger cities come from Natural Earth, which is public domain. Towns of 10,000 people or more come from Wikidata, which is CC0. Neither asks for credit, so the map shows none.

## License

Copyright 2026 Kacper Kotowski.

Gridatlas is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, change and share it for any noncommercial purpose: personal projects, study, research, hobby work, and use by schools, charities and public institutions. You may not use it to make money, for example in a product or service that is sold, or in work done for a paying client.

For commercial use, ask the author for a separate license.

The license covers this code and the packed atlas. The Natural Earth and Wikidata data stay public domain at their sources.
