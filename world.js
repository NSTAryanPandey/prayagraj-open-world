// Open-world Prayagraj: real map data from OpenStreetMap (© OpenStreetMap contributors, ODbL).
// The server downloads the area once, turns it into a compact file, keeps it (memory + MongoDB or data/), and serves
// it gzipped at /world/map.json. Phones only download that small file, never the raw map.
// Multiplayer for the open world runs on its own Socket.IO namespace "/world".
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AREA = { id: 'prayagraj-city-v2', name: 'Prayagraj', south: 25.372, west: 81.815, north: 25.468, east: 81.940 };
AREA.lat0 = (AREA.south + AREA.north) / 2;
AREA.lon0 = (AREA.west + AREA.east) / 2;
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const CACHE_FILE = path.join(__dirname, 'data', `${AREA.id}.json.gz`);

function overpassQuery(a) {
  const bb = `${a.south},${a.west},${a.north},${a.east}`;
  return `[out:json][timeout:240][maxsize:1073741824];(
    way["highway"](${bb}); way["building"](${bb});
    way["natural"~"^(water|sand|beach|wood|scrub)$"](${bb}); relation["natural"~"^(water|sand)$"](${bb});
    way["waterway"~"^(river|riverbank|canal)$"](${bb}); way["railway"="rail"](${bb});
    way["leisure"~"^(park|garden|pitch|stadium)$"](${bb});
    way["landuse"~"^(grass|forest|recreation_ground|meadow|orchard|village_green|cemetery|farmland|reservoir|basin)$"](${bb});
    node["place"~"^(suburb|neighbourhood|quarter|town|village|locality)$"](${bb});
    nwr["historic"]["name"](${bb}); nwr["amenity"="place_of_worship"]["name"](${bb}); nwr["tourism"]["name"](${bb});
  );out geom;`;
}

// Raw Overpass JSON → compact world. Coordinates are local metres ×10 (decimetres, integers):
// x = east, z = south (so north is −z, like the game camera). Pure function (also used for testing in a browser).
function processOSM(j, lat0, lon0) {
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), kz = 110540;
  const same = (a, b) => a.lat === b.lat && a.lon === b.lon;
  const P = (g) => { const o = []; for (const p of g) o.push(Math.round((p.lon - lon0) * kx * 10), Math.round(-(p.lat - lat0) * kz * 10)); return o; };
  const ring = (g) => (g.length > 3 && same(g[0], g[g.length - 1]) ? g.slice(0, -1) : g);
  const closed = (g) => g.length > 3 && same(g[0], g[g.length - 1]);
  const centroid = (g) => { let x = 0, y = 0; for (const p of g) { x += p.lon; y += p.lat; } return P([{ lon: x / g.length, lat: y / g.length }]); };
  function stitch(ways) {
    const segs = ways.filter(w => w && w.length > 1).map(w => w.slice()), rings = [];
    while (segs.length) {
      let r = segs.shift(), changed = true;
      while (changed && !same(r[0], r[r.length - 1])) {
        changed = false;
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i], end = r[r.length - 1];
          if (same(s[0], end)) r = r.concat(s.slice(1));
          else if (same(s[s.length - 1], end)) r = r.concat(s.slice(0, -1).reverse());
          else if (same(s[s.length - 1], r[0])) r = s.concat(r.slice(1));
          else if (same(s[0], r[0])) r = s.slice(1).reverse().concat(r);
          else continue;
          segs.splice(i, 1); changed = true; break;
        }
      }
      if (r.length > 3) rings.push(ring(r));
    }
    return rings;
  }
  const inPoly = (pt, poly) => {
    let c = false;
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const a = poly[i], b = poly[k];
      if ((a.lat > pt.lat) !== (b.lat > pt.lat) && pt.lon < (b.lon - a.lon) * (pt.lat - a.lat) / (b.lat - a.lat) + a.lon) c = !c;
    }
    return c;
  };
  // road class (0 = highway … 6 = dirt path) and default width in metres
  const ROAD = { motorway: [0, 14], trunk: [0, 12], primary: [1, 10], secondary: [1, 9], tertiary: [2, 7.5], unclassified: [3, 6],
    residential: [3, 6], living_street: [3, 5], service: [4, 4], pedestrian: [5, 5], footway: [5, 2.2], path: [6, 2], track: [6, 3] };
  const GREEN = { park: 1, garden: 1, village_green: 1, recreation_ground: 1, grass: 2, meadow: 2, pitch: 2, stadium: 2, cemetery: 3,
    wood: 4, forest: 4, orchard: 4, scrub: 4, farmland: 5 };
  const out = { v: 2, lat0, lon0, roads: [], buildings: [], water: [], sand: [], green: [], rail: [], labels: [], forts: [] };
  let hash = 0;
  for (const e of j.elements || []) {
    const t = e.tags || {};
    if (e.type === 'node' && t.name && Number.isFinite(e.lat)) {        // area names and famous places
      out.labels.push([t.name, ...P([{ lat: e.lat, lon: e.lon }]), t.place || t.historic || t.amenity || t.tourism || 'place']);
      continue;
    }
    if (e.type === 'way' && e.geometry && t.historic === 'fort' && closed(e.geometry)) out.forts.push(P(ring(e.geometry)));
    if (e.type === 'way' && e.geometry) {
      const g = e.geometry, hw = t.highway && t.highway.replace(/_link$/, '');
      if (hw && ROAD[hw]) {
        const [cls, w] = ROAD[hw];
        const width = Math.min(30, parseFloat(t.width) || (t.lanes ? Math.max(w, +t.lanes * 3.2) : w)) || w;
        out.roads.push([cls, Math.round(width * 10) / 10, t.bridge && t.bridge !== 'no' ? 1 : 0, P(g)]);
      } else if (t.building && closed(g)) {
        hash = (hash * 31 + e.id) % 9973;
        const lv = parseFloat(t['building:levels']);
        let h = parseFloat(t.height) || (lv ? lv * 3.2 + 0.6 : 0);
        if (!h) h = [3.8, 6.8, 6.8, 9.8, 6.8, 3.8, 9.8, 12.8][hash % 8];     // most buildings here are 1–3 floors
        out.buildings.push([Math.round(Math.min(h, 80) * 10) / 10, P(ring(g))]);
      } else if (t.railway === 'rail') out.rail.push(P(g));
      else if (closed(g) && (t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin')) {
        if (t.water !== 'wastewater') out.water.push([P(ring(g))]);
      } else if (closed(g) && (t.natural === 'sand' || t.natural === 'beach')) out.sand.push([P(ring(g))]);
      else if (closed(g) && (GREEN[t.leisure] || GREEN[t.landuse] || GREEN[t.natural])) out.green.push([GREEN[t.leisure] || GREEN[t.landuse] || GREEN[t.natural], P(ring(g))]);
      else if (t.waterway === 'river' && t.name) out.labels.push([t.name, ...P([g[Math.floor(g.length / 2)]]), 'river']);
      if (t.name && closed(g) && (t.leisure || t.natural === 'water' || t.amenity === 'place_of_worship' || t.historic || t.tourism || t.landuse === 'religious'))
        out.labels.push([t.name, ...centroid(g), t.leisure || t.historic || t.tourism || t.amenity || t.natural || 'place']);
    } else if (e.type === 'relation' && e.members && (t.natural === 'water' || t.natural === 'sand')) {
      const outers = stitch(e.members.filter(m => m.role !== 'inner').map(m => m.geometry));
      const inners = stitch(e.members.filter(m => m.role === 'inner').map(m => m.geometry));
      const list = t.natural === 'water' ? out.water : out.sand;
      for (const o of outers) list.push([P(o), ...inners.filter(i => inPoly(i[0], o)).map(P)]);
      if (t.name) out.labels.push([t.name, ...centroid(outers[0] || []), 'water']);
    }
  }
  out.labels = out.labels.filter(l => Number.isFinite(l[1]));
  return out;
}

let cached = null, pending = null;     // gzipped compact JSON
async function fetchOverpass() {
  const body = 'data=' + encodeURIComponent(overpassQuery(AREA));
  let lastErr;
  for (const url of MIRRORS) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 280000);
      const res = await fetch(url, { method: 'POST', body, signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ArchVizStudio-OpenWorld/1.0 (student game)' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      const j = await res.json();
      if (!j.elements || !j.elements.length) throw new Error(`${url} → empty`);
      console.log(`World map downloaded from ${url}: ${j.elements.length} map features`);
      return j;
    } catch (err) { lastErr = err; console.warn('World map mirror failed:', err.message); }
  }
  throw lastErr || new Error('no map server reachable');
}
async function getMap(getDb) {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    const db = getDb && getDb();
    try {                                                      // 1) saved copy
      if (db) { const doc = await db.collection('world').findOne({ _id: AREA.id }); if (doc && doc.gz) return (cached = Buffer.from(doc.gz.buffer || doc.gz)); }
      else if (fs.existsSync(CACHE_FILE)) return (cached = fs.readFileSync(CACHE_FILE));
    } catch (err) { console.warn('World cache read failed:', err.message); }
    const world = processOSM(await fetchOverpass(), AREA.lat0, AREA.lon0);   // 2) download + prepare
    world.area = { name: AREA.name, south: AREA.south, west: AREA.west, north: AREA.north, east: AREA.east };
    const gz = zlib.gzipSync(JSON.stringify(world), { level: 9 });
    console.log(`World ready: ${world.buildings.length} buildings, ${world.roads.length} roads, ${(gz.length / 1024).toFixed(0)} KB`);
    try {
      if (db) await db.collection('world').updateOne({ _id: AREA.id }, { $set: { gz, at: new Date() } }, { upsert: true });
      else { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, gz); }
    } catch (err) { console.warn('World cache write failed:', err.message); }
    return (cached = gz);
  })().finally(() => { pending = null; });
  return pending;
}

function attach(app, io, getDb) {
  app.get(['/', '/world'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));       // the game page
  app.get('/icon.png', (_req, res) => res.sendFile(path.join(__dirname, 'icon.png')));
  // public settings for the game page (the Mapbox token lives in Render's environment, not in the GitHub repo)
  app.get('/world/config', (_req, res) => res.json({ mapboxToken: process.env.MAPBOX_TOKEN || null }));
  app.get('/world/map.json', async (req, res) => {
    try {
      const gz = await getMap(getDb);
      res.set({ 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.set('Content-Encoding', 'gzip'); res.send(gz); }
      else res.send(zlib.gunzipSync(gz));
    } catch (err) {
      console.error('World map unavailable:', err.message);
      res.status(503).json({ error: 'The map server is busy. Try again in a minute.' });
    }
  });
  setTimeout(() => getMap(getDb).catch(err => console.warn('World map warm-up failed:', err.message)), 20000);   // prepare in the background

  // ---- open-world multiplayer: positions, cars, chat. Everyone in one shared city.
  const nsp = io.of('/world');
  const players = new Map();
  const num = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
  const text = (v, d, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : d);
  nsp.on('connection', (socket) => {
    let me = null, lastChat = 0;
    socket.on('join', (d = {}) => {
      if (me) return;
      me = { id: socket.id, name: text(d.name, 'Player', 18), avatar: d.avatar === 'girl' ? 'girl' : 'boy', x: 0, z: 0, y: 0, yaw: 0, car: null, cy: 0, anim: 0 };
      players.set(socket.id, me);
      socket.emit('init', { you: socket.id, players: [...players.values()].filter(p => p.id !== socket.id) });
      socket.broadcast.emit('joined', me);
    });
    socket.on('move', (d = {}) => {
      if (!me || !num(d.x, -6000, 6000) || !num(d.z, -6000, 6000)) return;
      me.x = d.x; me.z = d.z; me.y = num(d.y, -5, 60) ? d.y : 0; me.yaw = num(d.yaw, -1e6, 1e6) ? d.yaw : 0;
      me.car = d.car === 'suv' || d.car === 'sedan' ? d.car : null; me.cy = num(d.cy, -1e6, 1e6) ? d.cy : 0; me.anim = num(d.anim, 0, 3) ? d.anim : 0;
      const pc = d.pc;                                          // where this player's car is parked (shown to others)
      me.pc = Array.isArray(pc) && (pc[0] === 'suv' || pc[0] === 'sedan') && num(pc[1], -6000, 6000) && num(pc[2], -6000, 6000) && num(pc[3], -1e6, 1e6) ? [pc[0], pc[1], pc[2], pc[3]] : null;
      socket.broadcast.volatile.emit('moved', { id: socket.id, x: me.x, z: me.z, y: me.y, yaw: me.yaw, car: me.car, cy: me.cy, anim: me.anim, pc: me.pc });
    });
    socket.on('chat', (d = {}) => {
      if (!me || Date.now() - lastChat < 700) return;
      lastChat = Date.now();
      const msg = text(d.text, '', 140); if (!msg) return;
      nsp.emit('chat', { id: socket.id, name: me.name, text: msg, at: Date.now() });
    });
    socket.on('horn', () => { if (me && me.car) socket.broadcast.emit('horn', { id: socket.id }); });
    socket.on('disconnect', () => { if (!me) return; players.delete(socket.id); socket.broadcast.emit('left', { id: socket.id }); });
  });
}

module.exports = { attach, processOSM, AREA, overpassQuery };
