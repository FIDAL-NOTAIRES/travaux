// TRAVAUX — POST /api/autorisations
//
// Porte serveur de TRAVAUX, ajoutée le 09/11/2026 pour MARTEAU. Elle rend,
// parcelle par parcelle, ce que la page de TRAVAUX calcule déjà :
//   - les autorisations d'urbanisme de la base Sitadel (depuis 2013),
//     lues par le portail de données ouvertes Koumoul : permis de
//     construire et déclarations (logements, locaux), permis d'aménager,
//     permis de démolir ;
//   - l'emprise bâtie de la parcelle selon le plan cadastral et selon la
//     BD TOPO de l'IGN, et l'écart entre les deux (mêmes seuils que la
//     page : 5 %, rien sous 20 m²).
// La « date d'apparition » de la BD TOPO est rendue telle quelle : c'est
// la date d'entrée du bâtiment dans la base de l'IGN, PAS sa date de
// construction (arbitrage du 09/11/2026 : elle ne fonde jamais un orange).
//
// Entrée  : { parcelles: ["14715000AD0811", …] }   (INSEE 5 + préfixe 3
//           + section 2 + numéro 4)
// Sortie  : { interroge_le, parcelles: { "<code>": { statut, … } } }
//           statut : ok | introuvable | erreur
//
// Limites voulues : 20 parcelles par appel (chacune coûte 12 requêtes à
// Sitadel), 6 requêtes Sitadel et 2 parcelles en même temps, 8 s par
// requête. Une parcelle en échec n'arrête pas les autres.

import * as turf from '@turf/turf';

const KOUMOUL = 'https://opendata.koumoul.com/data-fair/api/v1/datasets/';
const APICARTO = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const WFS = 'https://data.geopf.fr/wfs/ows';
const MAX_PARCELLES = 20;
const PARCELLES_SIMULTANEES = 2;
const SITADEL_SIMULTANEES = 6;
const DELAI = 8000;
const SEUIL_ECART = 0.05;
const SURFACE_MIN = 20;

const JEUX = [
  { id: 'sitadel-logements', type: null, num: 'NUM_DAU', etat: 'ETAT_DAU', famille: 'logements' },
  { id: 'sitadel-locaux',    type: null, num: 'NUM_DAU', etat: 'ETAT_DAU', famille: 'locaux' },
  { id: 'sitadel-pa',        type: 'PA', num: 'NUM_PA',  etat: 'ETAT_PA',  famille: 'aménagement' },
  { id: 'sitadel-pd',        type: 'PD', num: 'NUM_PD',  etat: 'ETAT_PD',  famille: 'démolition' },
];
const ETATS = { 2: 'autorisé', 4: 'annulé', 5: 'commencé', 6: 'terminé' };
const NATURES = { 1: 'nouvelle construction', 2: 'transformation sans extension', 3: 'transformation avec extension',
  4: 'transformation avec diminution', 5: 'extension sans transformation', 6: 'diminution sans transformation' };

// Communes à arrondissements : le cadastre de l'IGN attend le code de la
// ville entière, l'arrondissement à part (même règle qu'URBA).
function codesCadastre(insee) {
  if (/^751(0[1-9]|1\d|20)$/.test(insee)) return { code_insee: '75056', code_arr: insee.slice(2) };
  if (/^6938[1-9]$/.test(insee)) return { code_insee: '69123', code_arr: insee.slice(2) };
  if (/^132(0[1-9]|1[0-6])$/.test(insee)) return { code_insee: '13055', code_arr: insee.slice(2) };
  return { code_insee: insee };
}

async function jget(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), DELAI);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// File commune aux requêtes Sitadel : le portail limite les appels.
let actives = 0; const attente = [];
function passer() {
  if (actives >= SITADEL_SIMULTANEES || !attente.length) return;
  actives++; const t = attente.shift();
  t.fn().then(t.res, t.rej).finally(() => { actives--; passer(); });
}
const enFile = (fn) => new Promise((res, rej) => { attente.push({ fn, res, rej }); passer(); });

const d = (x) => (x == null || x === '' ? null : String(x).slice(0, 10));

function normaliser(brut, jeu) {
  return {
    numero: brut[jeu.num] || null,
    type: jeu.type || brut.TYPE_DAU || null,
    famille: jeu.famille,
    etat: ETATS[brut[jeu.etat]] || null,
    depot: d(brut.DR_DEPOT),
    autorise_le: d(brut.DATE_REELLE_AUTORISATION),
    ouverture_chantier: d(brut.DATE_REELLE_DOC),
    achevement_declare: d(brut.DATE_REELLE_DAACT),
    nature: NATURES[brut.NATURE_PROJET_COMPLETEE] || NATURES[brut.NATURE_PROJET_DECLAREE] || null,
    demandeur: brut.DENOM_DEM || null,
  };
}

async function sitadel(insee, section, numero) {
  const sec = section.toUpperCase().replace(/^0+(?=[A-Z])/, '');
  const num = String(parseInt(numero, 10));
  const taches = [];
  for (const jeu of JEUX) {
    for (const pos of [1, 2, 3]) {
      const p = new URLSearchParams({ size: '100', COMM_eq: insee,
        ['SEC_CADASTRE' + pos + '_eq']: sec, ['NUM_CADASTRE' + pos + '_eq']: num });
      taches.push(enFile(() => jget(KOUMOUL + jeu.id + '/lines?' + p))
        .then((j) => ({ jeu, lignes: (j && j.results) || [] }), () => ({ jeu, erreur: true })));
    }
  }
  const retours = await Promise.all(taches);
  const vues = new Map(); const indisponibles = new Set();
  for (const r of retours) {
    if (r.erreur) { indisponibles.add(r.jeu.famille); continue; }
    for (const brut of r.lignes) {
      const cle = r.jeu.id + '|' + (brut[r.jeu.num] || JSON.stringify(brut).slice(0, 80));
      if (!vues.has(cle)) vues.set(cle, normaliser(brut, r.jeu));
    }
  }
  return {
    autorisations: [...vues.values()].sort((a, b) => (b.autorise_le || '').localeCompare(a.autorise_le || '')),
    indisponibles: [...indisponibles],
  };
}

async function batiments(typename, bb) {
  const url = WFS + '?service=WFS&version=2.0.0&request=GetFeature&typenames=' + typename +
    '&outputFormat=application/json&count=1000&bbox=' + bb[1] + ',' + bb[0] + ',' + bb[3] + ',' + bb[2] +
    ',urn:ogc:def:crs:EPSG::4326';
  return (await jget(url)).features || [];
}

function surParcelle(feats, parcelle) {
  let total = 0; const retenus = [];
  for (const f of feats) {
    let inter = null;
    try { inter = turf.intersect(turf.featureCollection([f, parcelle])); } catch (e) { /* géométrie invalide */ }
    if (inter) { const a = turf.area(inter); if (a > 0.5) { total += a; retenus.push({ f, aire: a }); } }
  }
  return { total, retenus };
}

async function emprises(parcelle) {
  const bb = turf.bbox(parcelle); const m = 0.0005; // ~50 m
  const bbe = [bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m];
  const [cad, topo] = await Promise.all([
    batiments('CADASTRALPARCELS.PARCELLAIRE_EXPRESS:batiment', bbe),
    batiments('BDTOPO_V3:batiment', bbe),
  ]);
  const A = surParcelle(cad, parcelle), B = surParcelle(topo, parcelle);
  let alerte = false;
  if (A.total < SURFACE_MIN && B.total >= SURFACE_MIN) alerte = true;
  else if (A.total >= SURFACE_MIN && (B.total - A.total) / A.total > SEUIL_ECART) alerte = true;
  return {
    cadastre_m2: Math.round(A.total),
    ign_m2: Math.round(B.total),
    ecart: A.total > 0 ? Math.round(((B.total - A.total) / A.total) * 1000) / 1000 : null,
    ecart_significatif: alerte,
    bati: B.total >= SURFACE_MIN || A.total >= SURFACE_MIN,
    batiments: B.retenus.map(({ f, aire }) => {
      const pr = f.properties || {};
      let app = pr.date_d_apparition ?? null;
      if (app && parseInt(String(app).slice(0, 4), 10) < 1900) app = null; // valeur conventionnelle IGN
      return { aire_m2: Math.round(aire), usage: pr.usage_1 ?? null, apparition_ign: app ? String(app).slice(0, 10) : null };
    }).sort((a, b) => b.aire_m2 - a.aire_m2),
  };
}

async function traiterParcelle(code) {
  const insee = code.slice(0, 5), prefixe = code.slice(5, 8), section = code.slice(8, 10), numero = code.slice(10, 14);
  if (!/^[0-9AB][0-9]{4}$/.test(insee) || !/^\d{4}$/.test(numero)) return { statut: 'erreur', raison: 'identifiant de parcelle illisible' };
  const q = new URLSearchParams({ ...codesCadastre(insee), section, numero });
  if (prefixe && prefixe !== '000') q.set('com_abs', prefixe);

  const [sit, geo] = await Promise.all([
    sitadel(insee, section, numero).catch(() => null),
    jget(APICARTO + '?' + q).then((fc) => (fc.features && fc.features[0]) || null).catch(() => undefined),
  ]);
  let emp = null;
  if (geo) { try { emp = await emprises(geo); } catch (e) { emp = { erreur: 'bâti de l\'IGN injoignable' }; } }
  else if (geo === undefined) emp = { erreur: 'cadastre injoignable' };
  else emp = { erreur: 'parcelle absente du cadastre en ligne' };

  if (!sit) return { statut: 'erreur', raison: 'base Sitadel injoignable', emprises: emp };
  return {
    statut: 'ok',
    autorisations: sit.autorisations,
    sitadel_partiel: sit.indisponibles, // familles de la base qui n'ont pas répondu
    emprises: emp,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
  let corps = req.body;
  if (typeof corps === 'string') { try { corps = JSON.parse(corps); } catch { corps = {}; } }
  const demandees = [...new Set((corps?.parcelles ?? []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))];
  if (!demandees.length) return res.status(400).json({ erreur: 'parcelles requises' });

  const lot = demandees.slice(0, MAX_PARCELLES);
  const sortie = {};
  let i = 0;
  const ouvrier = async () => {
    while (i < lot.length) {
      const code = lot[i++];
      try { sortie[code] = await traiterParcelle(code); }
      catch (e) { sortie[code] = { statut: 'erreur', raison: e.message }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARCELLES_SIMULTANEES, lot.length) }, ouvrier));

  return res.status(200).json({
    interroge_le: new Date().toISOString(),
    source: 'base Sitadel (Koumoul) ; plan cadastral et BD TOPO (IGN)',
    non_traitees: demandees.length - lot.length,
    parcelles: sortie,
  });
}
