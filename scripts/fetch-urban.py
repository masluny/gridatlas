#!/usr/bin/env python3
"""Build raw/urban.geojson: where the world is built up.

Source: NASA MODIS Land Cover Type, MCD12Q1 version 6.1, layer LC_Type1
(IGBP), class 13 "Urban and Built-up Lands", 500 m. NASA data is CC0, see
https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance

The tiles come from NASA GIBS (gibs.earthdata.nasa.gov), which serves the
same product as paletted PNG without a login. The pixel value is the class,
class 13 has a palette color of its own, so nothing is guessed.

Steps: download the tiles that touch land, cut the class-13 mask, close
one-pixel gaps, drop specks of one or two pixels, polygonize, merge across
tile seams, clip to the 1:10m Natural Earth land minus its lakes (so towns
never spill into the sea), and write GeoJSON. scripts/pack.mjs does the
final simplification. `--clip-only` redoes just the clipping on an existing
file.

Needs: pip install -r scripts/urban-requirements.txt
"""

import argparse
import json
import math
import re
import sys
import tempfile
import time
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
import shapely
from rasterio.features import shapes
from rasterio.transform import Affine
from scipy import ndimage
from shapely.geometry import Polygon, box, shape
from shapely.ops import unary_union

warnings.filterwarnings("ignore", category=rasterio.errors.NotGeoreferencedWarning)

ROOT = Path(__file__).resolve().parent.parent
GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best"
LAYER = "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual"
LEVEL = 7  # the 500 m level of the GIBS tile matrix set
TILE = 512
COLS = 160
ROWS = 80
WIDTH = COLS * TILE
PX = 360 / WIDTH  # degrees per pixel, exact in binary, so seams match
URBAN_RGB = (255, 0, 0)  # GIBS color of IGBP class 13
MIN_PIXELS = 3  # components of 1 or 2 pixels are dropped
MIN_HOLE_PIXELS = 4
SOUTH_LIMIT = -60  # nothing built up below this except research stations
NORTH_LIMIT = 84


def request(url, retries=5):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gridatlas-fetch-urban"})
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, res.read(), res.headers
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return 404, b"", err.headers
            last = err
        except Exception as err:  # network hiccup
            last = err
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"giving up on {url}: {last}")


def latest_time():
    status, body, _ = request(f"{GIBS}/1.0.0/WMTSCapabilities.xml")
    xml = body.decode("utf8", "replace")
    at = xml.index(f"<ows:Identifier>{LAYER}</ows:Identifier>")
    end = xml.index("</Layer>", at)
    span = re.search(r"<Value>(\d{4}-\d\d-\d\d)/(\d{4}-\d\d-\d\d)/P1Y</Value>", xml[at:end])
    if not span:
        raise RuntimeError("could not read the time range of the layer")
    return span.group(2)


def tile_box(row, col):
    west = -180 + col * TILE * PX
    north = 90 - row * TILE * PX
    return box(west, north - TILE * PX, west + TILE * PX, north)


def wanted_tiles(countries, bbox):
    land = None
    if countries.exists():
        geoms = [shape(f["geometry"]) for f in json.loads(countries.read_text())["features"]]
        land = shapely.STRtree([g.buffer(0.05) for g in geoms])
    tiles = []
    for row in range(ROWS):
        for col in range(COLS):
            b = tile_box(row, col)
            west, south, east, north = b.bounds
            if north < SOUTH_LIMIT or south > NORTH_LIMIT:
                continue
            if bbox and (east < bbox[0] or west > bbox[2] or north < bbox[1] or south > bbox[3]):
                continue
            if land is not None and not len(land.query(b, predicate="intersects")):
                continue
            tiles.append((row, col))
    return tiles


def tile_url(stamp, row, col):
    return f"{GIBS}/{LAYER}/default/{stamp}/500m/{LEVEL}/{row}/{col}.png"


def download(tiles, cache, stamp, workers):
    cache.mkdir(parents=True, exist_ok=True)
    todo = [t for t in tiles if not (cache / f"{t[0]}_{t[1]}.png").exists()]
    print(f"{len(tiles)} tiles wanted, {len(todo)} to download", flush=True)
    done = 0

    def one(tile):
        row, col = tile
        status, body, _ = request(tile_url(stamp, row, col))
        # A tile that is not there is open ocean or outside the data.
        (cache / f"{row}_{col}.png").write_bytes(b"" if status == 404 else body)

    with ThreadPoolExecutor(workers) as pool:
        for _ in pool.map(one, todo):
            done += 1
            if done % 250 == 0:
                print(f"  {done}/{len(todo)}", flush=True)


def urban_mask(path):
    if path.stat().st_size == 0:
        return None
    with rasterio.open(path) as ds:
        palette = ds.colormap(1)
        wanted = [i for i, c in palette.items() if tuple(c[:3]) == URBAN_RGB and c[3] == 255]
        if not wanted:
            return None
        return np.isin(ds.read(1), wanted)


def tile_row(cache, row, available):
    out = np.zeros((TILE, WIDTH), dtype=bool)
    for col in range(COLS):
        if (row, col) not in available:
            continue
        mask = urban_mask(cache / f"{row}_{col}.png")
        if mask is not None:
            out[:, col * TILE : (col + 1) * TILE] = mask
    return out


def clean(strip):
    # Wrap the columns so the antimeridian does not eat the edge pixels.
    wide = np.pad(strip, ((0, 0), (2, 2)), mode="wrap")
    closed = ndimage.binary_closing(wide, structure=np.ones((3, 3), dtype=bool))
    labels, count = ndimage.label(closed, structure=np.ones((3, 3), dtype=int))
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    keep = sizes >= MIN_PIXELS
    keep[0] = False
    return keep[labels][:, 2:-2]


def drop_small_holes(poly, min_area):
    if not poly.interiors:
        return poly
    holes = [r for r in poly.interiors if Polygon(r).area >= min_area]
    if len(holes) == len(poly.interiors):
        return poly
    return Polygon(poly.exterior, holes)


def polygons_of(mask, top_lat):
    transform = Affine(PX, 0, -180, 0, -PX, top_lat)
    found = []
    for geom, value in shapes(mask.astype(np.uint8), mask=mask, connectivity=4, transform=transform):
        if value:
            found.append(shape(geom))
    return found


def explode(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in explode(g)]
    return []


def km2(poly):
    south, north = poly.bounds[1], poly.bounds[3]
    return poly.area * 111.2 * 111.2 * math.cos(math.radians((south + north) / 2))


def finish(polys, tolerance, min_km2):
    px_area = PX * PX
    out = []
    for poly in polys:
        poly = drop_small_holes(poly, MIN_HOLE_PIXELS * px_area)
        if km2(poly) < min_km2:
            continue
        simple = shapely.simplify(poly, tolerance, preserve_topology=True)
        for part in explode(simple):
            if not part.is_empty and part.area > 0:
                out.append(part)
    return out


def build(cache, available, tolerance, min_km2):
    eps = PX / 2
    finished = []
    carry = []
    prev = np.zeros((TILE, WIDTH), dtype=bool)
    here = tile_row(cache, 0, available)
    for row in range(ROWS):
        after = tile_row(cache, row + 1, available) if row + 1 < ROWS else np.zeros_like(here)
        if not here.any():
            # Nothing in this row, so nothing carried over can still merge.
            finished.extend(finish(carry, tolerance, min_km2))
            carry = []
            prev, here = here, after
            continue
        strip = np.vstack([prev, here, after])
        center = clean(strip)[TILE : 2 * TILE]
        top = 90 - row * TILE * PX
        bottom = top - TILE * PX
        polys = polygons_of(center, top) if center.any() else []
        seam_top = [p for p in polys if p.bounds[3] >= top - eps]
        inner = [p for p in polys if p.bounds[3] < top - eps]
        merged = explode(unary_union(carry + seam_top)) if (carry or seam_top) else []
        carry = []
        for poly in merged + inner:
            if poly.bounds[1] <= bottom + eps and row + 1 < ROWS:
                carry.append(poly)
            else:
                finished.extend(finish([poly], tolerance, min_km2))
        print(f"  row {row + 1}/{ROWS}: {len(finished)} polygons", flush=True)
        prev, here = here, after
    finished.extend(finish(carry, tolerance, min_km2))
    return finished


def water_free_land():
    """1:10m land minus 1:10m lakes, as a list of polygons and a tree over them."""
    raw = ROOT / "raw"

    def load(name):
        data = json.loads((raw / f"{name}.geojson").read_text())
        return [shape(f["geometry"]).buffer(0) for f in data["features"] if f["geometry"]]

    land = unary_union(load("ne_10m_admin_0_countries"))
    lakes = unary_union(
        load("ne_10m_lakes") + load("ne_10m_lakes_europe") + load("ne_10m_lakes_north_america")
    )
    parts = explode(land.difference(lakes))
    return parts, shapely.STRtree(parts)


def clip(polys):
    parts, tree = water_free_land()
    out = []
    for poly in polys:
        hits = tree.query(poly, predicate="intersects")
        if not len(hits):
            continue
        cut = unary_union([poly.intersection(parts[i]) for i in hits])
        out.extend(p for p in explode(cut) if km2(p) >= 0.5)
    return out


def write(polys, path, info):
    def ring(coords):
        return [[round(x, 4), round(y, 4)] for x, y in coords]

    features = []
    for poly in polys:
        rings = [ring(poly.exterior.coords)] + [ring(r.coords) for r in poly.interiors]
        features.append({"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": rings}})
    data = {"type": "FeatureCollection", "name": "urban", "source": info, "features": features}
    path.write_text(json.dumps(data, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default=str(ROOT / "raw" / "urban.geojson"))
    parser.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "gridatlas-urban"))
    parser.add_argument("--time", default="latest", help="GIBS date, like 2024-01-01 (default: the latest year)")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--tolerance", type=float, default=0.003, help="simplify tolerance in degrees")
    parser.add_argument("--min-km2", type=float, default=3, help="drop polygons smaller than this")
    parser.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"), help="only this area, for tests")
    parser.add_argument("--clip-only", action="store_true", help="only clip an existing --out file to the land")
    args = parser.parse_args()

    if args.clip_only:
        path = Path(args.out)
        data = json.loads(path.read_text())
        polys = clip([shape(f["geometry"]) for f in data["features"]])
        write(polys, path, data.get("source", {}))
        print(json.dumps({"polygons": len(polys), "km2": round(sum(km2(p) for p in polys))}))
        return

    stamp = latest_time() if args.time == "latest" else args.time
    print(f"MCD12Q1 v6.1 LC_Type1 class 13, time {stamp}", flush=True)
    cache = Path(args.cache) / stamp
    tiles = wanted_tiles(ROOT / "raw" / "countries.geojson", args.bbox)
    download(tiles, cache, stamp, args.workers)
    # Any tile will do to read back which product and year GIBS served.
    head = request(tile_url(stamp, 16, 89))[2]
    if head.get("layer-time-actual", "").split("T")[0] != stamp:
        raise RuntimeError(f"GIBS served {head.get('layer-time-actual')} instead of {stamp}")
    available = {t for t in tiles if (cache / f"{t[0]}_{t[1]}.png").stat().st_size > 0}
    print(f"{len(available)} tiles with data", flush=True)

    polys = clip(build(cache, available, args.tolerance, args.min_km2))
    area = sum(km2(p) for p in polys)
    info = {
        "product": "MCD12Q1 v6.1 LC_Type1 (IGBP) class 13, 500 m",
        "time": stamp,
        "via": "NASA GIBS " + LAYER,
        "layer_actual": head.get("layer-identifier-actual"),
    }
    write(polys, Path(args.out), info)
    print(json.dumps({"polygons": len(polys), "km2": round(area), **info}, indent=2))


if __name__ == "__main__":
    sys.exit(main())
