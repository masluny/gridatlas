// Download cities and towns of 10,000 people or more from Wikidata (CC0)
// into raw/cities.csv. pack.mjs merges them with the Natural Earth places.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const QUERY = `
SELECT ?item ?label (MAX(?p) AS ?pop) (SAMPLE(?lat) AS ?la) (SAMPLE(?lon) AS ?lo) (SAMPLE(?cc) AS ?country) WHERE {
  { ?item wdt:P31/wdt:P279* wd:Q515 } UNION { ?item wdt:P31/wdt:P279* wd:Q3957 }
  ?item wdt:P1082 ?p . FILTER(?p >= 10000)
  FILTER NOT EXISTS { ?item wdt:P576 [] }
  ?item p:P625/psv:P625 [ wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon ; wikibase:geoGlobe wd:Q2 ] .
  OPTIONAL { ?item wdt:P17 ?c . ?c rdfs:label ?cc FILTER(lang(?cc) = "en") }
  ?item rdfs:label ?label FILTER(lang(?label) = "en")
} GROUP BY ?item ?label`;

const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}`;
const res = await fetch(url, {
  headers: { Accept: "text/csv", "User-Agent": "gridatlas-build/1.0 (offline map data)" },
});
if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
const text = await res.text();
const rows = text.trim().split("\n").length - 1;
if (rows < 10000) throw new Error(`Only ${rows} rows came back, the query probably timed out`);
writeFileSync(join(root, "raw", "cities.csv"), text);
console.log(`${rows} places`);
