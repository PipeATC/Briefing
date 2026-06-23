/**
 * weather-proxy.js  —  Proxy METAR/TAF opcional para el sistema BRIEFING
 * ============================================================================
 * El front (index.html) se sirve como contenido ESTÁTICO (GitHub Pages) y por
 * defecto obtiene METAR/TAF del lado del cliente desde la API pública de NOAA
 * (Aviation Weather Center), que tiene CORS habilitado.
 *
 * Este proxy es SOLO necesario si se quiere usar una fuente sin CORS, p.ej.
 * meteochile.cl / DGAC. Levanta un endpoint propio con CORS abierto que:
 *   - obtiene METAR/TAF cada 5 min y los cachea (evita rate-limiting),
 *   - sirve un JSON { metar:{ICAO:str}, taf:{ICAO:str} } compatible con el front.
 *
 * Uso:
 *   1) node weather-proxy.js            (escucha en http://localhost:8787/api/meteo)
 *   2) en index.html, fijar:  CONFIG_METEO.PROXY_METEO = 'http://localhost:8787/api/meteo'
 *
 * Node 18+ (fetch nativo). Sin dependencias externas.
 *
 * NOTA: ajusta construirURLFuente()/parsear() a la estructura real del feed de
 * meteochile/DGAC que dispongas (HTML scrap o API). Aquí queda como plantilla
 * con la fuente NOAA por defecto para que funcione de inmediato.
 * ============================================================================
 */

const http = require('http');

const PUERTO = process.env.PORT || 8787;
const INTERVALO_MS = 5 * 60 * 1000;        // refresco cada 5 minutos
const TIMEOUT_MS = 12000;
const FUENTE_BASE = process.env.METEO_BASE || 'https://aviationweather.gov/api/data';

// ICAOs servidos (deben coincidir con baseDatosAerodromos en index.html)
const ICAOS = [
  'SCAR','SCDA','SCFA','SCCF','SCAT','SCSE','SCEL','SCVM','SCIP','SCIE',
  'SCQP','SCPQ','SCVD','SCTE','SCBA','SCJO','SCCI'
];

// Caché en memoria + control de backoff anti rate-limit
let cache = { metar: {}, taf: {}, notam: {}, ts: null, fuente: 'INICIANDO' };
let backoffMs = 15000;

function fetchConTimeout(url) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } })
    .finally(() => clearTimeout(id));
}

async function refrescar() {
  const ids = ICAOS.join(',');
  try {
    const [rMetar, rTaf, rNotam] = await Promise.all([
      fetchConTimeout(`${FUENTE_BASE}/metar?ids=${ids}&format=json`),
      fetchConTimeout(`${FUENTE_BASE}/taf?ids=${ids}&format=json&hours=24`),
      fetchConTimeout(`${FUENTE_BASE}/notam?ids=${ids}&format=json`).catch(() => null)
    ]);
    if (rMetar.status === 429 || rTaf.status === 429) throw new Error('RATE_LIMIT');
    if (!rMetar.ok || !rTaf.ok) throw new Error(`HTTP ${rMetar.status}/${rTaf.status}`);

    const metars = await rMetar.json();
    const tafs = await rTaf.json();
    const metar = {}, taf = {}, notam = {};
    (Array.isArray(metars) ? metars : []).forEach(m => { if (m && m.icaoId && m.rawOb) metar[m.icaoId] = m.rawOb; });
    (Array.isArray(tafs) ? tafs : []).forEach(t => {
      if (t && t.icaoId && (t.rawTAF || t.rawTaf)) taf[t.icaoId] = t.rawTAF || t.rawTaf;
    });

    if (rNotam && rNotam.ok) {
      const notams = await rNotam.json();
      const grupos = {};
      (Array.isArray(notams) ? notams : []).forEach(n => {
        const loc = n.icaoId || n.icaoLocation;
        if (!loc) return;
        if (!grupos[loc]) grupos[loc] = [];
        const txt = (n.notamTxt || n.message || n.rawNotam || '').trim();
        if (txt) grupos[loc].push(txt);
      });
      ICAOS.forEach(icao => {
        if (grupos[icao] !== undefined) notam[icao] = grupos[icao].join('\n');
      });
    }

    cache = { metar, taf, notam, ts: new Date().toISOString(), fuente: 'LIVE' };
    backoffMs = 15000; // éxito -> reset backoff
    console.log(`[meteo] actualizado ${cache.ts} (${Object.keys(metar).length} METAR / ${Object.keys(taf).length} TAF / ${Object.keys(notam).length} NOTAM)`);
    setTimeout(refrescar, INTERVALO_MS);
  } catch (err) {
    console.error(`[meteo] error: ${err.message} -> reintento en ${Math.round(backoffMs/1000)}s`);
    cache.fuente = err.message.includes('RATE_LIMIT') ? 'RATE_LIMIT_CACHE' : 'ERROR_CACHE';
    setTimeout(refrescar, backoffMs);
    backoffMs = Math.min(backoffMs * 2, INTERVALO_MS); // backoff exponencial con tope
  }
}

const servidor = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');         // CORS abierto para el front estático
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url.startsWith('/api/meteo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(cache));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

servidor.listen(PUERTO, () => {
  console.log(`weather-proxy escuchando en http://localhost:${PUERTO}/api/meteo`);
  refrescar(); // primer fetch al arrancar
});
