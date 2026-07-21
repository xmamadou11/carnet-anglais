/* ============================================================
   CARNET — English C1 learning app
   Vanilla JS, no build step. Sections:
   1. IndexedDB helper (kv store for data cache + audio dir handle)
   2. App state + persistence (localStorage progress/meta)
   3. SM-2 spaced repetition
   4. Data loading (fetch from ./data on GitHub Pages, with local
      file-picker fallback), audio loading
   5. Unified item registry (vocab, grammar, phrasal verbs, idioms,
      connectors, collocations, nuances) — one shared SRS queue
   6. Exercise generation, one builder per "kind"
   7. Screen renderers
   8. Router
   ============================================================ */

/* ---------- 1. IndexedDB helper ---------- */
const IDB = (() => {
  let dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('carnet-db', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function set(key, val) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  return { get, set };
})();

/* ---------- 2. App state ---------- */
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const KIND_LABELS = {
  vocab: 'Vocabulaire', grammar: 'Grammaire', phrasalverb: 'Phrasal verbs',
  idiom: 'Idiomes', connector: 'Connecteurs', collocation: 'Collocations',
  nuance: 'Nuances de sens', expression: 'Expressions verbales'
};

const State = {
  vocab: null, byId: null,
  grammar: null, phrasalverbs: null, idioms: null, connectors: null,
  collocations: null, nuances: null, expressions: null,
  registry: null,      // Map key -> { kind, level, data }
  newOrder: null,       // array of keys, ordered for "new item" introduction
  audioIndex: null,     // Map wordId -> File/handle/URL
  audioDirHandle: null,
  audioManifestMode: false, // true if using data/audio-index.json + fetch
  currentObjectURL: null,
  progress: {},         // { [key]: {ef, interval, reps, due, lapses} }
  meta: {
    streak: 0, lastActiveDay: null, totalReviews: 0, dailyNewGoal: 15,
    historyByDay: {}
  },
  session: null
};

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function loadLocalState() {
  try {
    const p = localStorage.getItem('carnet_progress');
    if (p) State.progress = migrateProgressKeys(JSON.parse(p));
  } catch (e) { State.progress = {}; }
  try {
    const m = localStorage.getItem('carnet_meta');
    if (m) State.meta = Object.assign(State.meta, JSON.parse(m));
  } catch (e) { /* keep defaults */ }
}

// Old versions of the app stored plain numeric vocab ids as progress keys.
// New keys are namespaced ("v:123"). This migrates old saves once.
function migrateProgressKeys(progress) {
  const out = {};
  for (const k of Object.keys(progress || {})) {
    if (/^\d+$/.test(k)) out['v:' + k] = progress[k];
    else out[k] = progress[k];
  }
  return out;
}

function saveProgress() { localStorage.setItem('carnet_progress', JSON.stringify(State.progress)); }
function saveMeta() { localStorage.setItem('carnet_meta', JSON.stringify(State.meta)); }

function touchStreak() {
  const today = todayKey();
  if (State.meta.lastActiveDay === today) return;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
  if (State.meta.lastActiveDay === yesterday) State.meta.streak += 1;
  else if (State.meta.lastActiveDay !== today) State.meta.streak = 1;
  State.meta.lastActiveDay = today;
  saveMeta();
}

function dayHistory() {
  const k = todayKey();
  if (!State.meta.historyByDay[k]) State.meta.historyByDay[k] = { newCount: 0, reviewCount: 0 };
  return State.meta.historyByDay[k];
}

/* ---------- 3. SM-2 spaced repetition ----------
   card: { ef, interval, reps, due, lapses }
   quality: again=1, hard=3, good=4, easy=5
*/
function sm2(card, quality) {
  let { ef = 2.5, interval = 0, reps = 0, lapses = 0 } = card || {};
  if (quality < 3) { reps = 0; interval = 1; lapses += 1; }
  else {
    if (reps === 0) interval = 1;
    else if (reps === 1) interval = 6;
    else interval = Math.round(interval * ef);
    reps += 1;
  }
  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) ef = 1.3;
  const due = Date.now() + interval * 24 * 60 * 60 * 1000;
  return { ef, interval, reps, due, lapses };
}

function gradeItem(key, quality) {
  const card = State.progress[key] || {};
  const wasNew = !State.progress[key];
  State.progress[key] = sm2(card, quality);
  State.meta.totalReviews += 1;
  const h = dayHistory();
  h.reviewCount += 1;
  if (wasNew) h.newCount += 1;
  saveProgress();
  saveMeta();
}

function isKnown(key) { return !!State.progress[key]; }

function getDueKeys() {
  const now = Date.now();
  return Object.keys(State.progress).filter(k => State.progress[k].due <= now);
}

/* ---------- 4. Data loading ---------- */
async function fetchJSON(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

// Tries to auto-load everything from ./data (works on GitHub Pages or any
// static server). Falls back to manual pickers (setup screen) if the vocab
// file can't be fetched (e.g. opened directly as a local file:// page).
async function tryAutoLoadAll() {
  const [vocab, grammar, phrasalverbs, idioms, connectors, collocations, nuances, expressions, audioManifest] = await Promise.all([
    fetchJSON('data/vocab.json'),
    fetchJSON('data/grammar.json'),
    fetchJSON('data/phrasalverbs.json'),
    fetchJSON('data/idioms.json'),
    fetchJSON('data/connectors.json'),
    fetchJSON('data/collocations.json'),
    fetchJSON('data/nuances.json'),
    fetchJSON('data/expressions.json'),
    fetchJSON('data/audio-index.json'),
  ]);
  if (!vocab) return false;
  setVocab(vocab);
  State.grammar = grammar || [];
  State.phrasalverbs = phrasalverbs || [];
  State.idioms = idioms || [];
  State.connectors = connectors || [];
  State.collocations = collocations || [];
  State.nuances = nuances || [];
  State.expressions = expressions || [];
  if (audioManifest) {
    State.audioIndex = new Map(Object.entries(audioManifest).map(([id, cats]) => [parseInt(id, 10), cats]));
    State.audioManifestMode = true;
  }
  buildRegistry();
  return true;
}

async function tryAutoLoadCachedVocabOnly() {
  const cached = await IDB.get('vocab');
  if (cached && Array.isArray(cached) && cached.length) {
    setVocab(cached);
    State.grammar = State.grammar || [];
    State.phrasalverbs = State.phrasalverbs || [];
    State.idioms = State.idioms || [];
    State.connectors = State.connectors || [];
    State.collocations = State.collocations || [];
    State.nuances = State.nuances || [];
    State.expressions = State.expressions || [];
    buildRegistry();
    return true;
  }
  return false;
}

function setVocab(arr) {
  State.vocab = arr;
  State.byId = new Map(arr.map(w => [w.id, w]));
}

async function handleVocabFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  setVocab(data);
  IDB.set('vocab', data).catch(() => {});
  buildRegistry();
}

const AUDIO_CATEGORIES = ['mot', 'definition', 'senses', 'examples', 'sensExamples', 'collocations', 'expressions', 'phrasalVerbs'];
const CATEGORY_GENDER = { mot: 'female', definition: 'female', senses: 'female', examples: 'male', sensExamples: 'male', collocations: 'male', expressions: 'male', phrasalVerbs: 'male' };
const CATEGORY_FR = { mot: 'Prononciation', definition: 'Définition', senses: 'Sens', examples: 'Exemples', sensExamples: 'Exemples (sens)', collocations: 'Collocations', expressions: 'Expressions', phrasalVerbs: 'Phrasal verbs' };

function showCompanion(category) {
  const gender = CATEGORY_GENDER[category] || 'female';
  const box = document.getElementById('audioCompanion');
  const fem = document.getElementById('avatarFemale');
  const male = document.getElementById('avatarMale');
  if (!box || !fem || !male) return;
  box.classList.remove('hidden');
  fem.classList.toggle('av-active', gender === 'female');
  male.classList.toggle('av-active', gender === 'male');
  fem.classList.toggle('speaking', gender === 'female');
  male.classList.toggle('speaking', gender === 'male');
  document.getElementById('companionLabel').textContent = CATEGORY_FR[category] || '';
}
function hideCompanion() {
  const box = document.getElementById('audioCompanion');
  if (!box) return;
  document.getElementById('avatarFemale').classList.remove('speaking');
  document.getElementById('avatarMale').classList.remove('speaking');
  setTimeout(() => { box.classList.add('hidden'); }, 250);
}

// Filenames look like "42_abandon_mot.mp3", "42_abandon_examples.mp3", etc.
// (word text sanitised in the middle may itself contain underscores, so we
// match the category from the known list rather than splitting blindly.)
function parseAudioFilename(name) {
  const m = name.match(/^(\d+)_.+_(mot|definition|senses|examples|sensExamples|collocations|expressions|phrasalVerbs)\.\w+$/);
  if (!m) return null;
  return { id: parseInt(m[1], 10), category: m[2] };
}

// ---- Zip-based audio (for phone-only publishing: a handful of .zip parts
// instead of thousands of individual mp3 uploads). An audio-index.json entry
// can be either:
//   "audio/42_abandon_mot.mp3"                  -> plain fetch (old mode)
//   { "zip": "audio-part1.zip", "name": "audio/42_abandon_mot.mp3" }  -> zip mode
//
// PHASE 0.1 — logs systématiques (0.1.1) + cache mémoire ET IndexedDB des
// zips déjà téléchargés, pour ne plus jamais retélécharger un zip une fois
// qu'il a été lu une première fois (0.1.4 / 0.1.5).
const ZipCache = new Map(); // zip filename -> Promise<JSZip>
async function loadZipPart(zipName) {
  if (ZipCache.has(zipName)) {
    console.log(`[Audio] ${zipName} : déjà en cache mémoire.`);
    return ZipCache.get(zipName);
  }
  const p = (async () => {
    const t0 = performance.now();
    // 1) IndexedDB d'abord : si on l'a déjà téléchargé une fois, on ne
    // retélécharge plus jamais ce zip, même après un rechargement de page.
    try {
      const cached = await IDB.get('zip:' + zipName);
      if (cached) {
        console.log(`[Audio] ${zipName} : trouvé dans IndexedDB, pas de nouveau téléchargement (${(performance.now() - t0).toFixed(0)}ms).`);
        return await JSZip.loadAsync(cached);
      }
    } catch (e) { console.warn(`[Audio] Lecture IndexedDB échouée pour ${zipName}, on retélécharge :`, e); }

    console.log(`[Audio] ${zipName} : téléchargement demandé…`);
    let res;
    try {
      res = await fetch('audio-zips/' + zipName, { cache: 'force-cache' });
    } catch (e) {
      console.error(`[Audio] ${zipName} : échec réseau du téléchargement.`, e);
      throw e;
    }
    if (!res.ok) {
      console.error(`[Audio] ${zipName} : 404/erreur HTTP ${res.status} sur audio-zips/${zipName}. Vérifie que ce fichier existe bien à cet emplacement exact sur GitHub Pages.`);
      throw new Error('zip fetch failed: ' + zipName + ' (HTTP ' + res.status + ')');
    }
    const buf = await res.arrayBuffer();
    console.log(`[Audio] ${zipName} : téléchargement réussi (${(buf.byteLength / 1024 / 1024).toFixed(1)} Mo, ${(performance.now() - t0).toFixed(0)}ms). Extraction…`);
    IDB.set('zip:' + zipName, buf).catch(e => console.warn(`[Audio] Impossible de mettre ${zipName} en cache IndexedDB :`, e));
    try {
      const zip = await JSZip.loadAsync(buf);
      console.log(`[Audio] ${zipName} : extraction réussie.`);
      return zip;
    } catch (e) {
      console.error(`[Audio] ${zipName} : échec d'extraction du zip.`, e);
      throw e;
    }
  })();
  ZipCache.set(zipName, p);
  p.catch(() => ZipCache.delete(zipName)); // un échec ne doit pas rester en cache indéfiniment
  return p;
}

// 0.1.6 — précharge en tâche de fond le(s) zip(s) contenant l'audio d'un
// autre mot (typiquement le mot suivant dans la liste), sans bloquer la
// lecture en cours. N'importe quelle erreur est juste loguée.
function preloadAudioFor(id) {
  if (!State.audioIndex || !State.audioIndex.has(id)) return;
  const cats = State.audioIndex.get(id);
  const zipNames = new Set();
  for (const cat of AUDIO_CATEGORIES) {
    const entry = cats[cat];
    if (entry && typeof entry === 'object' && entry.zip) zipNames.add(entry.zip);
  }
  for (const zipName of zipNames) {
    if (!ZipCache.has(zipName)) {
      console.log(`[Audio] Préchargement en arrière-plan de ${zipName} (mot id=${id}).`);
      loadZipPart(zipName).catch(e => console.warn(`[Audio] Préchargement de ${zipName} échoué (sans gravité) :`, e));
    }
  }
}

function indexAudioFiles(files) {
  const idx = new Map();
  for (const f of files) {
    const base = f.name || (f.webkitRelativePath ? f.webkitRelativePath.split('/').pop() : '');
    if (!/\.(mp3|wav)$/i.test(base)) continue;
    const parsed = parseAudioFilename(base);
    if (!parsed) continue;
    if (!idx.has(parsed.id)) idx.set(parsed.id, {});
    idx.get(parsed.id)[parsed.category] = f;
  }
  State.audioIndex = idx;
  State.audioManifestMode = false;
}

async function indexAudioDirHandle(dirHandle) {
  const idx = new Map();
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    if (!/\.(mp3|wav)$/i.test(name)) continue;
    const parsed = parseAudioFilename(name);
    if (!parsed) continue;
    if (!idx.has(parsed.id)) idx.set(parsed.id, {});
    idx.get(parsed.id)[parsed.category] = handle;
  }
  State.audioIndex = idx;
  State.audioDirHandle = dirHandle;
  State.audioManifestMode = false;
}

async function playAudioFor(id, category) {
  category = category || 'mot';
  const t0 = performance.now();
  if (!State.audioIndex || !State.audioIndex.has(id)) {
    console.warn(`[Audio] Aucune entrée audio-index pour id=${id} (mot sans audio du tout, ou audio-index.json pas chargé).`);
    return false;
  }
  const entry = State.audioIndex.get(id)[category];
  if (!entry) {
    console.warn(`[Audio] id=${id} : pas d'audio pour la catégorie "${category}".`);
    return false;
  }
  try {
    let audio;
    if (entry && typeof entry === 'object' && entry.zip) {
      // Zip mode: fetch (and cache) the zip part, pull the one file out of it.
      const zip = await loadZipPart(entry.zip);
      const zipFile = zip.file(entry.name);
      if (!zipFile) {
        console.error(`[Audio] id=${id}/${category} : fichier "${entry.name}" introuvable à l'intérieur de ${entry.zip} (le zip a été téléchargé mais ne contient pas ce nom exact).`);
        return false;
      }
      const blob = await zipFile.async('blob');
      if (State.currentObjectURL) URL.revokeObjectURL(State.currentObjectURL);
      const url = URL.createObjectURL(blob);
      State.currentObjectURL = url;
      audio = new Audio(url);
    } else if (State.audioManifestMode) {
      // entry is a relative path string, e.g. "audio/42_abandon_mot.mp3"
      console.log(`[Audio] id=${id}/${category} : mode manifeste "à plat" (${entry}). Ce fichier doit exister littéralement à cette URL sur GitHub Pages — si l'audio a été publié en .zip dans audio-zips/, régénère data/audio-index.json avec l'outil zip pour que cette entrée devienne { zip, name } au lieu d'un simple chemin.`);
      audio = new Audio(entry);
    } else {
      let file;
      if (entry instanceof File) file = entry;
      else file = await entry.getFile();
      if (State.currentObjectURL) URL.revokeObjectURL(State.currentObjectURL);
      const url = URL.createObjectURL(file);
      State.currentObjectURL = url;
      audio = new Audio(url);
    }
    showCompanion(category);
    audio.addEventListener('ended', hideCompanion);
    audio.addEventListener('error', (e) => { console.error(`[Audio] id=${id}/${category} : l'élément <audio> n'a pas pu lire le fichier (fichier corrompu ou introuvable).`, e); hideCompanion(); });
    await audio.play();
    console.log(`[Audio] id=${id}/${category} : lecture démarrée avec succès (${(performance.now() - t0).toFixed(0)}ms depuis la demande).`);
    preloadAudioFor(id + 1);
    return true;
  } catch (e) { console.error(`[Audio] id=${id}/${category} : échec de lecture.`, e); hideCompanion(); return false; }
}

function hasAudio(id, category) { category = category || 'mot'; return !!(State.audioIndex && State.audioIndex.has(id) && State.audioIndex.get(id)[category]); }
function fsAccessSupported() { return typeof window.showDirectoryPicker === 'function'; }

/* ---------- 5. Unified item registry ---------- */
// Every learnable "thing" gets a namespaced key:
//   v:<id>            vocab word
//   g:<pointId>:<drillId>   one grammar drill
//   p:<id>            phrasal verb
//   i:<id>            idiom
//   c:<id>            connector
//   o:<id>            collocation ("o" to avoid clashing with connector "c")
//   n:<groupId>       nuance group (one MCQ per group, word chosen at random each time)
function buildRegistry() {
  const reg = new Map();
  for (const w of State.vocab) reg.set('v:' + w.id, { kind: 'vocab', level: w.level || 'B1', freq: w.frequency || 0 });
  for (const pt of State.grammar) {
    for (const d of pt.drills) reg.set(`g:${pt.id}:${d.id}`, { kind: 'grammar', level: (pt.level || 'B2').split('/')[0] });
  }
  for (const it of State.phrasalverbs) reg.set('p:' + it.id, { kind: 'phrasalverb', level: it.level || 'B2' });
  for (const it of State.idioms) reg.set('i:' + it.id, { kind: 'idiom', level: it.level || 'B2' });
  for (const it of State.connectors) reg.set('c:' + it.id, { kind: 'connector', level: it.level || 'B2' });
  for (const it of State.collocations) reg.set('o:' + it.id, { kind: 'collocation', level: it.level || 'B1' });
  for (const it of State.nuances) reg.set('n:' + it.id, { kind: 'nuance', level: 'B2' });
  for (const it of State.expressions) reg.set('x:' + it.id, { kind: 'expression', level: it.level || 'B2' });
  State.registry = reg;
  computeNewOrder();
}

function computeNewOrder() {
  const rank = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 };
  // Bucket keys by level, then within a level interleave kinds round-robin
  // (vocab / grammar / phrasal verbs / idioms / connectors / collocations /
  // nuances) so a session naturally mixes modules instead of exhausting one.
  const buckets = {};
  LEVELS.forEach(l => buckets[l] = {});
  for (const [key, meta] of State.registry.entries()) {
    const lvl = LEVELS.includes(meta.level) ? meta.level : 'B2';
    buckets[lvl][meta.kind] = buckets[lvl][meta.kind] || [];
    buckets[lvl][meta.kind].push([key, meta]);
  }
  // sort vocab within a level by frequency (most frequent first)
  LEVELS.forEach(l => {
    if (buckets[l].vocab) buckets[l].vocab.sort((a, b) => (b[1].freq || 0) - (a[1].freq || 0));
  });
  const order = [];
  const kindOrder = ['vocab', 'grammar', 'phrasalverb', 'idiom', 'connector', 'collocation', 'nuance', 'expression'];
  for (const l of LEVELS) {
    const lists = kindOrder.map(k => buckets[l][k] || []).filter(a => a.length);
    let i = 0;
    while (lists.some(a => i < a.length)) {
      for (const a of lists) if (i < a.length) order.push(a[i][0]);
      i++;
    }
  }
  State.newOrder = order;
}

function pickNewKeys(count) {
  const out = [];
  for (const key of State.newOrder) {
    if (out.length >= count) break;
    if (!isKnown(key)) out.push(key);
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9' -]/g, '').trim();
}
function looseMatch(input, answer) {
  const variants = String(answer).split(';').map(s => s.trim());
  const n = normalize(input);
  return variants.some(v => normalize(v) === n);
}

/* ---------- 6. Exercise generation ---------- */
function firstTranslation(t) {
  if (!t) return '';
  let base = t;
  const parenIdx = base.indexOf('(');
  if (parenIdx > 0) base = base.slice(0, parenIdx);
  return base.split(/[,/]/)[0].trim();
}
function wordVariants(w) {
  const set = new Set([w.word]);
  if (w.verbForms) ['base','thirdPerson','ing','past','pastParticiple'].forEach(k => { if (w.verbForms[k]) set.add(w.verbForms[k]); });
  return Array.from(set);
}
function findClozeExample(w) {
  const pools = [];
  if (Array.isArray(w.examples)) pools.push(...w.examples);
  if (Array.isArray(w.senses)) w.senses.forEach(s => { if (Array.isArray(s.examples)) pools.push(...s.examples); });
  const variants = wordVariants(w).sort((a, b) => b.length - a.length);
  for (const ex of pools) {
    if (!ex || !ex.en) continue;
    for (const variant of variants) {
      const re = new RegExp('\\b' + variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      const match = ex.en.match(re);
      if (match) return { sentence: ex.en, fr: ex.fr, matched: match[0] };
    }
  }
  return null;
}
function randomOtherWords(excludeId, level, count) {
  const pool = State.vocab.filter(w => w.id !== excludeId && w.level === level);
  const source = pool.length >= count ? pool : State.vocab.filter(w => w.id !== excludeId);
  const chosen = []; const used = new Set();
  while (chosen.length < count && chosen.length < source.length) {
    const w = source[Math.floor(Math.random() * source.length)];
    if (!used.has(w.id)) { used.add(w.id); chosen.push(w); }
  }
  return chosen;
}

function buildExercise(key, forceNewFlashcard) {
  const meta = State.registry.get(key);
  if (!meta) throw new Error('clé absente du registre: ' + key);
  const kind = meta.kind;
  if (kind === 'vocab') return buildVocabExercise(key, forceNewFlashcard);
  if (kind === 'grammar') return buildGrammarExercise(key);
  if (kind === 'phrasalverb') return buildPhraseExercise(key, State.phrasalverbs, 'p:', forceNewFlashcard);
  if (kind === 'idiom') return buildPhraseExercise(key, State.idioms, 'i:', forceNewFlashcard);
  if (kind === 'connector') return buildConnectorExercise(key, forceNewFlashcard);
  if (kind === 'expression') return buildPhraseExercise(key, State.expressions, 'x:', forceNewFlashcard);
  if (kind === 'collocation') return buildCollocationExercise(key);
  if (kind === 'nuance') return buildNuanceExercise(key);
}

/* ----- vocab (unchanged behaviour from the original app) ----- */
function buildVocabExercise(key, forceNewFlashcard) {
  const id = parseInt(key.slice(2), 10);
  const w = State.byId.get(id);
  if (!w) throw new Error('mot introuvable pour id=' + id);
  const card = State.progress[key];
  const reps = card ? card.reps : 0;
  let type = forceNewFlashcard ? 'flashcard' : null;
  if (!type) {
    if (!card || reps === 0) type = 'flashcard';
    else {
      const options = ['flashcard', 'mcq_trans', 'mcq_word', 'cloze'];
      if (hasAudio(id)) options.push('listening', 'listening');
      type = options[Math.floor(Math.random() * options.length)];
    }
  }
  if (type === 'cloze') {
    const found = findClozeExample(w);
    if (!found) type = 'mcq_trans';
    else return { type, key, id, word: w, sentence: found.sentence, fr: found.fr, answer: found.matched };
  }
  if (type === 'listening' && !hasAudio(id)) type = 'flashcard';
  if (type === 'mcq_trans') {
    const distractors = randomOtherWords(id, w.level, 3);
    const options = shuffle([firstTranslation(w.translation), ...distractors.map(d => firstTranslation(d.translation))]);
    return { type, key, id, word: w, options, answer: firstTranslation(w.translation) };
  }
  if (type === 'mcq_word') {
    const distractors = randomOtherWords(id, w.level, 3);
    const options = shuffle([w.word, ...distractors.map(d => d.word)]);
    return { type, key, id, word: w, options, answer: w.word };
  }
  if (type === 'listening') return { type, key, id, word: w, answer: w.word };
  return { type: 'flashcard', key, id, word: w };
}

/* ----- grammar drills ----- */
function buildGrammarExercise(key) {
  const [, ptId, drId] = key.split(':');
  const point = State.grammar.find(p => String(p.id) === ptId);
  if (!point) throw new Error('point de grammaire introuvable: ' + ptId);
  const drill = point.drills.find(d => String(d.id) === drId);
  if (!drill) throw new Error('exercice de grammaire introuvable: ' + ptId + ':' + drId);
  if (drill.type === 'mcq') {
    // BUG CORRIGÉ : "answer" n'était jamais mis sur l'exercice lui-même
    // (seulement sur drill.answer). answerMcq() compare "chosen === ex.answer",
    // donc ex.answer valait undefined et AUCUNE réponse ne pouvait jamais être
    // reconnue comme correcte — tous les QCM de grammaire étaient impossibles
    // à réussir, quelle que soit l'option choisie.
    return { type: 'grammar_mcq', key, point, drill, options: shuffle(drill.options), answer: drill.answer };
  }
  const blanks = (drill.prompt.match(/___/g) || []).length || 1;
  const answers = String(drill.answer).split('/').map(s => s.trim());
  return { type: 'grammar_gap', key, point, drill, blanks, answers };
}

/* ----- phrasal verbs & idioms share the same shape ----- */
function buildPhraseExercise(key, list, prefix, forceNewFlashcard) {
  const id = parseInt(key.slice(prefix.length), 10);
  const item = list.find(x => x.id === id);
  if (!item) throw new Error('item introuvable pour ' + prefix + id);
  const card = State.progress[key];
  let type = forceNewFlashcard ? 'flashcard' : null;
  if (!type) {
    const canCloze = item.example && item.example.en && item.example.en.toLowerCase().includes(item.phrase.toLowerCase());
    const options = ['flashcard', 'mcq_trans'];
    if (canCloze) options.push('cloze');
    type = (!card || card.reps === 0) ? 'flashcard' : options[Math.floor(Math.random() * options.length)];
  }
  if (type === 'cloze') {
    const re = new RegExp(item.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (!re.test(item.example.en)) type = 'mcq_trans';
    else return { type, key, item, sentence: item.example.en, fr: item.example.fr, answer: item.phrase };
  }
  if (type === 'mcq_trans') {
    const distractors = shuffle(list.filter(x => x.id !== id)).slice(0, 3);
    const options = shuffle([item.translation, ...distractors.map(d => d.translation)]);
    return { type, key, item, options, answer: item.translation };
  }
  return { type: 'flashcard', key, item };
}

/* ----- connectors ----- */
function buildConnectorExercise(key, forceNewFlashcard) {
  const id = parseInt(key.slice(2), 10);
  const item = State.connectors.find(x => x.id === id);
  if (!item) throw new Error('connecteur introuvable pour id=' + id);
  const card = State.progress[key];
  const canGap = item.example.en.toLowerCase().includes(item.connector.toLowerCase());
  const types = ['flashcard', 'mcq_function'];
  if (canGap) types.push('gap');
  const type = forceNewFlashcard || !card || card.reps === 0 ? 'flashcard' : types[Math.floor(Math.random() * types.length)];
  if (type === 'gap') {
    return { type, key, item, sentence: item.example.en, fr: item.example.fr, answer: item.connector };
  }
  if (type === 'mcq_function') {
    const distractors = shuffle(State.connectors.filter(x => x.id !== id)).slice(0, 3);
    const options = shuffle([item.connector, ...distractors.map(d => d.connector)]);
    return { type, key, item, options, answer: item.connector };
  }
  return { type: 'flashcard', key, item };
}

/* ----- collocations: "spot the real one" MCQ (no translation data needed) ----- */
function buildCollocationExercise(key) {
  const id = parseInt(key.slice(2), 10);
  const item = State.collocations.find(x => x.id === id);
  if (!item) throw new Error('collocation introuvable pour id=' + id);
  const tokens = item.text.split(' ');
  const pool = shuffle(State.collocations.filter(x => x.id !== id && x.text.split(' ').length >= 2)).slice(0, 6);
  const fakes = [];
  for (const other of pool) {
    if (fakes.length >= 3) break;
    const otherTokens = other.text.split(' ');
    const fake = tokens.slice(0, -1).concat(otherTokens[otherTokens.length - 1]).join(' ');
    if (fake.toLowerCase() !== item.text.toLowerCase() && !fakes.includes(fake)) fakes.push(fake);
  }
  const fillers = [' up', ' out', ' on', ' through'];
  let fi = 0;
  while (fakes.length < 3) { fakes.push(item.text + fillers[fi % fillers.length]); fi++; }
  const options = shuffle([item.text, ...fakes.slice(0, 3)]);
  // BUG CORRIGÉ : le champ s'appelait "item" avant, ce qui entrait en collision
  // avec le test générique "else if (ex.item)" dans renderSession (destiné aux
  // phrasal verbs / idiomes / connecteurs) — CE test passait avant le test
  // spécifique "ex.type === 'collocation_mcq'", donc CHAQUE exercice de
  // collocation était routé vers phraseBodyHTML(), qui ne connaît pas ce type
  // et renvoie une chaîne vide → carte blanche. Avec 42 917 collocations
  // (contre quelques centaines pour les autres catégories), ce bug se
  // déclenchait très souvent dans une session. Renommé en "colloc" pour lever
  // toute ambiguïté.
  return { type: 'collocation_mcq', key, colloc: item, options, answer: item.text };
}

/* ----- nuances: pick the right word for the example sentence ----- */
function buildNuanceExercise(key) {
  const id = parseInt(key.slice(2), 10);
  const group = State.nuances.find(x => x.id === id);
  if (!group || !group.words || !group.words.length) throw new Error('groupe de nuances introuvable pour id=' + id);
  const idx = Math.floor(Math.random() * group.words.length);
  const target = group.words[idx];
  const options = shuffle(group.words.map(w => w.word));
  return { type: 'nuance_mcq', key, group, target, sentence: target.example, options, answer: target.word };
}

function qualityFromCorrectness(correct, wasNew) {
  if (wasNew) return correct ? 4 : 2;
  return correct ? 4 : 1;
}

/* ---------- Session runner ---------- */
function startSession() {
  const goal = State.meta.dailyNewGoal;
  const introducedToday = dayHistory().newCount;
  const remainingNew = Math.max(0, goal - introducedToday);
  const due = getDueKeys();
  const fresh = pickNewKeys(remainingNew);

  const items = [];
  const maxLen = Math.max(due.length, fresh.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < due.length) items.push({ key: due[i], isNew: false });
    if (i < fresh.length) items.push({ key: fresh[i], isNew: true });
  }
  if (items.length === 0) {
    State.session = { queue: [], total: 0, done: 0, correct: 0 };
    Router.go('summary');
    return;
  }
  State.session = { queue: shuffleSessionKeepingNewFirst(items), total: items.length, done: 0, correct: 0, currentExercise: null };
  Router.current = 'session';
  nextExerciseInSession();
}

// Light shuffle: keeps due/new mixed (already interleaved by construction)
// but avoids long runs of the same kind back to back.
function shuffleSessionKeepingNewFirst(items) { return items; }

// PHASE 0.2 — une carte dont les données sont incohérentes (id manquant,
// item introuvable dans sa liste, etc.) ne doit jamais planter toute la
// session : on logue l'incident, on retire la clé fautive et on passe à la
// carte suivante, au lieu de laisser l'exception remonter et blanchir l'écran.
function nextExerciseInSession(skipCount) {
  skipCount = skipCount || 0;
  const s = State.session;
  if (!s.queue.length) { Router.go('summary'); return; }
  const item = s.queue.shift();
  s.currentItem = item;
  try {
    s.currentExercise = buildExercise(item.key, item.isNew);
    if (!s.currentExercise) throw new Error('buildExercise a retourné undefined pour ' + item.key);
  } catch (err) {
    console.error(`[Carnet] Carte illisible pour la clé "${item.key}", elle est ignorée :`, err);
    if (skipCount > 50) { console.error('[Carnet] Trop de cartes cassées d\'affilée, arrêt de la session.'); Router.go('summary'); return; }
    nextExerciseInSession(skipCount + 1);
    return;
  }
  try {
    renderSession();
  } catch (err) {
    renderFatalScreenError('session', err);
  }
}

function submitSessionAnswer(quality, correct) {
  const s = State.session;
  const item = s.currentItem;
  gradeItem(item.key, quality);
  s.done += 1;
  if (correct) s.correct += 1;
  if (quality < 3) {
    const reinsertAt = Math.min(s.queue.length, 3);
    s.queue.splice(reinsertAt, 0, { key: item.key, isNew: false });
    s.total += 1;
  }
  touchStreak();
}

/* ---------- 7. Screen renderers ---------- */
const screensEl = () => document.getElementById('screens');

function renderSetup() {
  document.getElementById('topbar').classList.add('hidden');
  document.getElementById('tabbar').classList.add('hidden');
  const vocabDone = !!State.vocab;
  const audioDone = !!(State.audioIndex && State.audioIndex.size);
  const fsSupported = fsAccessSupported();

  screensEl().innerHTML = `
    <div class="screen">
      <div class="setup-hero">
        <p class="mark-big" style="font-family:var(--serif)">Carnet</p>
        <p class="lede">Vocabulaire, grammaire, phrasal verbs, idiomes, connecteurs et nuances de sens — tout au même endroit, avec répétition espacée, pour atteindre le C1.</p>
      </div>
      <p class="page-sub" style="text-align:center">Impossible de charger automatiquement <code>data/vocab.json</code> (le site n'est peut-être pas servi via un serveur/GitHub Pages). Tu peux charger les fichiers à la main :</p>
      <div class="card setup-steps">
        <div class="step-row ${vocabDone ? 'done' : ''}">
          <div class="step-num">${vocabDone ? '✓' : '1'}</div>
          <div class="step-text">
            <div class="t">Charger la base de vocabulaire</div>
            <div class="s">${vocabDone ? State.vocab.length + ' mots chargés' : 'Le fichier vocab.json'}</div>
          </div>
          <button class="btn ${vocabDone ? 'btn-ghost' : 'btn-primary'}" onclick="document.getElementById('vocabFileInput').click()">${vocabDone ? 'Changer' : 'Choisir'}</button>
          <input type="file" id="vocabFileInput" accept="application/json,.json" onchange="onVocabFileChosen(event)">
        </div>
        <div class="step-row ${audioDone ? 'done' : ''}">
          <div class="step-num">${audioDone ? '✓' : '2'}</div>
          <div class="step-text">
            <div class="t">Charger le dossier audio (.mp3)</div>
            <div class="s">${audioDone ? State.audioIndex.size + ' mots avec audio' : 'Fichiers nommés "id_mot_categorie.mp3"'}</div>
          </div>
          <button class="btn ${audioDone ? 'btn-ghost' : 'btn-primary'}" onclick="chooseAudioFolder()">${audioDone ? 'Changer' : 'Choisir'}</button>
          <input type="file" id="audioFolderInput" webkitdirectory multiple onchange="onAudioFolderChosen(event)">
        </div>
      </div>
      <button class="btn btn-teal btn-lg btn-block" style="margin-top:22px" ${vocabDone ? '' : 'disabled'} onclick="finishSetup()">
        ${audioDone ? 'Commencer' : "Continuer sans audio pour l'instant"}
      </button>
      ${!fsSupported ? "<p class=\"page-sub\" style=\"text-align:center;margin-top:14px\">Ton navigateur ne permet pas de garder l'accès au dossier audio d'une session à l'autre &mdash; Chrome/Edge le permettent.</p>" : ''}
    </div>
  `;
}

async function onVocabFileChosen(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  await handleVocabFile(file);
  renderSetup();
}
async function chooseAudioFolder() {
  if (fsAccessSupported()) {
    try { const dir = await window.showDirectoryPicker(); await indexAudioDirHandle(dir); renderSetup(); return; }
    catch (e) { /* cancelled */ }
  }
  document.getElementById('audioFolderInput').click();
}
function onAudioFolderChosen(evt) {
  const files = Array.from(evt.target.files || []);
  indexAudioFiles(files);
  renderSetup();
}
function finishSetup() { loadLocalState(); Router.go('dashboard'); }

function levelDistribution() {
  const counts = {};
  LEVELS.forEach(l => counts[l] = { total: 0, known: 0 });
  for (const w of State.vocab) {
    counts[w.level].total += 1;
    if (isKnown('v:' + w.id)) counts[w.level].known += 1;
  }
  return counts;
}

function kindCounts() {
  const out = {};
  for (const [key, meta] of State.registry.entries()) {
    out[meta.kind] = out[meta.kind] || { total: 0, known: 0 };
    out[meta.kind].total += 1;
    if (isKnown(key)) out[meta.kind].known += 1;
  }
  return out;
}

function renderDashboard() {
  document.getElementById('topbar').classList.remove('hidden');
  document.getElementById('tabbar').classList.remove('hidden');
  document.getElementById('streakPill').textContent = '🔥 ' + State.meta.streak;

  const due = getDueKeys().length;
  const known = Object.keys(State.progress).length;
  const mastered = Object.values(State.progress).filter(c => c.interval >= 21).length;
  const dist = levelDistribution();
  const kc = kindCounts();
  const goal = State.meta.dailyNewGoal;
  const introducedToday = dayHistory().newCount;

  const levelRows = LEVELS.map(l => {
    const d = dist[l];
    const pct = d.total ? Math.round((d.known / d.total) * 100) : 0;
    return `<div class="level-bar-row">
      <span class="level-tag lvl-${l}">${l}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-count">${d.known}/${d.total}</span>
    </div>`;
  }).join('');

  const kindRows = Object.keys(KIND_LABELS).filter(k => kc[k]).map(k => {
    const d = kc[k];
    const pct = d.total ? Math.round((d.known / d.total) * 100) : 0;
    return `<div class="level-bar-row">
      <span class="kind-tag">${KIND_LABELS[k]}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-count">${d.known}/${d.total}</span>
    </div>`;
  }).join('');

  screensEl().innerHTML = `
    <div class="screen">
      <h1 class="page-title">Bonjour</h1>
      <p class="page-sub">${known} éléments en révision (tous modules confondus)</p>

      <div class="stat-grid">
        <div class="stat-box"><div class="num">${due}</div><div class="lab">À réviser</div></div>
        <div class="stat-box"><div class="num">${Math.max(0, goal - introducedToday)}</div><div class="lab">Nouveaux dispo.</div></div>
        <div class="stat-box"><div class="num">${mastered}</div><div class="lab">Maîtrisés</div></div>
      </div>

      <div class="card cta-block">
        <div class="goal-line">${due + Math.max(0, goal - introducedToday)} carte(s) dans la session du jour, tous modules mélangés</div>
        <button class="btn btn-primary btn-lg btn-block" onclick="startSession()">Commencer la session du jour</button>
      </div>

      <div class="card card-pad">
        <div class="section-title">Progression par niveau CECRL (vocabulaire)</div>
        <div class="level-bars">${levelRows}</div>
      </div>
      <div class="card card-pad" style="margin-top:16px">
        <div class="section-title">Progression par module</div>
        <div class="level-bars">${kindRows}</div>
      </div>
    </div>
  `;
}

/* ---------- Explorer screen (multi-module) ---------- */
const BrowseState = { module: 'vocab', level: 'A1', query: '' };

function renderBrowse() {
  document.getElementById('topbar').classList.remove('hidden');
  document.getElementById('tabbar').classList.remove('hidden');

  const moduleChips = Object.keys(KIND_LABELS).map(k =>
    `<button class="chip ${BrowseState.module === k ? 'active' : ''}" onclick="setBrowseModule('${k}')">${KIND_LABELS[k]}</button>`
  ).join('');

  let body = '';
  if (BrowseState.module === 'vocab') body = renderBrowseVocab();
  else if (BrowseState.module === 'grammar') body = renderBrowseGrammar();
  else if (BrowseState.module === 'phrasalverb') body = renderBrowsePhraseList(State.phrasalverbs, 'p');
  else if (BrowseState.module === 'idiom') body = renderBrowsePhraseList(State.idioms, 'i');
  else if (BrowseState.module === 'connector') body = renderBrowseConnectors();
  else if (BrowseState.module === 'collocation') body = renderBrowseCollocations();
  else if (BrowseState.module === 'nuance') body = renderBrowseNuances();
  else if (BrowseState.module === 'expression') body = renderBrowsePhraseList(State.expressions, 'x');

  screensEl().innerHTML = `
    <div class="screen">
      <h1 class="page-title">Explorer</h1>
      <p class="page-sub">Parcours chaque module, ou recherche un élément précis.</p>
      <div class="chip-row">${moduleChips}</div>
      ${body}
    </div>
  `;
}
function setBrowseModule(k) { BrowseState.module = k; BrowseState.query = ''; renderBrowse(); }
function onBrowseSearch(evt) { BrowseState.query = evt.target.value; renderBrowse(); }

function renderBrowseVocab() {
  const chips = LEVELS.map(l =>
    `<button class="chip ${BrowseState.level === l ? 'active' : ''}" onclick="setBrowseLevel('${l}')">${l}</button>`
  ).join('') + `<button class="chip ${BrowseState.level === 'ALL' ? 'active' : ''}" onclick="setBrowseLevel('ALL')">Tous</button>`;

  let list = State.vocab.filter(w => BrowseState.level === 'ALL' || w.level === BrowseState.level);
  if (BrowseState.query) {
    const q = normalize(BrowseState.query);
    list = list.filter(w => normalize(w.word).includes(q) || normalize(w.translation).includes(q));
  }
  list = list.slice(0, 200);
  const rows = list.map(w => `
    <div class="word-row" onclick="openWordDetail(${w.id})">
      ${isKnown('v:' + w.id) ? '<span class="badge-known"></span>' : '<span style="width:8px"></span>'}
      <span class="w">${w.word}</span>
      <span class="p">${firstTranslation(w.translation)}</span>
      <span class="level-tag lvl-${w.level}">${w.level}</span>
    </div>
  `).join('') || '<p class="page-sub">Aucun mot ne correspond.</p>';

  return `
    <input class="search-box" placeholder="Rechercher un mot ou une traduction…" value="${BrowseState.query}" oninput="onBrowseSearch(event)">
    <div class="chip-row">${chips}</div>
    <div class="word-list">${rows}</div>
  `;
}
function setBrowseLevel(l) { BrowseState.level = l; renderBrowse(); }

function renderBrowseGrammar() {
  const rows = State.grammar.map(pt => `
    <div class="word-row" style="cursor:default" onclick="openGrammarDetail(${pt.id})">
      <span class="w">${pt.title}</span>
      <span class="p">${pt.drills.length} exercices</span>
      <span class="level-tag lvl-${(pt.level||'B2').split('/')[0]}">${pt.level}</span>
    </div>
  `).join('');
  return `<div class="word-list">${rows}</div>`;
}
// PHASE 0.2 — même filet de sécurité que openWordDetail pour toutes les
// autres popups de détail (grammaire, phrasal verbs/idiomes/expressions,
// connecteurs) : jamais de page/popup blanche, toujours un log + fallback.
function withDetailErrorBoundary(name, fn) {
  return function (...args) {
    try { fn(...args); }
    catch (err) {
      console.error(`[Carnet] ${name} a échoué (${JSON.stringify(args)}):`, err);
      document.querySelectorAll('.detail-overlay').forEach(el => el.remove());
      const overlay = document.createElement('div');
      overlay.className = 'detail-overlay';
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
      overlay.innerHTML = `<div class="detail-sheet"><div class="def-line">Contenu indisponible.</div>
        <button class="btn btn-ghost btn-block" style="margin-top:16px" onclick="this.closest('.detail-overlay').remove()">Fermer</button></div>`;
      document.body.appendChild(overlay);
    }
  };
}

const openGrammarDetail = withDetailErrorBoundary('openGrammarDetail', function (ptId) {
  const pt = State.grammar.find(p => p.id === ptId);
  if (!pt) throw new Error('point de grammaire introuvable: ' + ptId);
  const examples = (pt.examples || []).map(e => `<div class="example-line"><div class="en">${e.en}</div><div class="fr">${e.fr}</div></div>`).join('');
  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="detail-sheet">
      <div class="detail-head">
        <div><div class="detail-word">${pt.title}</div><div class="detail-phon">Niveau ${pt.level}</div></div>
        <button class="close-x" onclick="this.closest('.detail-overlay').remove()">✕</button>
      </div>
      <div class="def-line">${pt.explanation}</div>
      <div class="detail-section"><div class="h">Exemples</div>${examples}</div>
    </div>
  `;
  document.body.appendChild(overlay);
});

function renderBrowsePhraseList(list, prefix) {
  let items = list;
  if (BrowseState.query) {
    const q = normalize(BrowseState.query);
    items = items.filter(x => normalize(x.phrase).includes(q) || normalize(x.translation).includes(q));
  }
  const rows = items.map(x => `
    <div class="word-row" onclick="openPhraseDetail('${prefix}', ${x.id})">
      ${isKnown(prefix + ':' + x.id) ? '<span class="badge-known"></span>' : '<span style="width:8px"></span>'}
      <span class="w">${x.phrase}</span>
      <span class="p">${x.translation}</span>
      <span class="level-tag lvl-${x.level}">${x.level}</span>
    </div>
  `).join('') || '<p class="page-sub">Aucun résultat.</p>';
  return `<input class="search-box" placeholder="Rechercher…" value="${BrowseState.query}" oninput="onBrowseSearch(event)"><div class="word-list">${rows}</div>`;
}
const openPhraseDetail = withDetailErrorBoundary('openPhraseDetail', function (prefix, id) {
  const list = prefix === 'p' ? State.phrasalverbs : (prefix === 'x' ? State.expressions : State.idioms);
  const item = list.find(x => x.id === id);
  if (!item) throw new Error('item introuvable: ' + prefix + id);
  const key = prefix + ':' + id;
  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="detail-sheet">
      <div class="detail-head">
        <div><div class="detail-word">${item.phrase} <span class="level-tag lvl-${item.level}">${item.level}</span></div></div>
        <button class="close-x" onclick="this.closest('.detail-overlay').remove()">✕</button>
      </div>
      <div class="translation-line">${item.translation}</div>
      <div class="def-line">${item.definition}</div>
      <div class="detail-section"><div class="h">Exemple</div><div class="example-line"><div class="en">${item.example.en}</div><div class="fr">${item.example.fr}</div></div></div>
      <button class="btn btn-teal btn-block" style="margin-top:20px" onclick="addKeyToReviewNow('${key}'); this.closest('.detail-overlay').remove();">
        ${isKnown(key) ? 'Déjà dans mes révisions' : 'Ajouter à mes révisions'}
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
});

function renderBrowseConnectors() {
  let items = State.connectors;
  if (BrowseState.query) {
    const q = normalize(BrowseState.query);
    items = items.filter(x => normalize(x.connector).includes(q));
  }
  const rows = items.map(x => `
    <div class="word-row" onclick="openConnectorDetail(${x.id})">
      ${isKnown('c:' + x.id) ? '<span class="badge-known"></span>' : '<span style="width:8px"></span>'}
      <span class="w">${x.connector}</span>
      <span class="p">${x.function}</span>
      <span class="level-tag lvl-${x.level}">${x.level}</span>
    </div>
  `).join('');
  return `<input class="search-box" placeholder="Rechercher…" value="${BrowseState.query}" oninput="onBrowseSearch(event)"><div class="word-list">${rows}</div>`;
}
const openConnectorDetail = withDetailErrorBoundary('openConnectorDetail', function (id) {
  const item = State.connectors.find(x => x.id === id);
  if (!item) throw new Error('connecteur introuvable: ' + id);
  const key = 'c:' + id;
  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="detail-sheet">
      <div class="detail-head"><div><div class="detail-word">${item.connector}</div><div class="detail-phon">${item.function}</div></div>
      <button class="close-x" onclick="this.closest('.detail-overlay').remove()">✕</button></div>
      <div class="detail-section"><div class="h">Exemple</div><div class="example-line"><div class="en">${item.example.en}</div><div class="fr">${item.example.fr}</div></div></div>
      <button class="btn btn-teal btn-block" style="margin-top:20px" onclick="addKeyToReviewNow('${key}'); this.closest('.detail-overlay').remove();">
        ${isKnown(key) ? 'Déjà dans mes révisions' : 'Ajouter à mes révisions'}
      </button>
    </div>`;
  document.body.appendChild(overlay);
});

function renderBrowseCollocations() {
  let items = State.collocations;
  if (BrowseState.query) {
    const q = normalize(BrowseState.query);
    items = items.filter(x => normalize(x.text).includes(q));
  } else {
    items = items.slice(0, 150);
  }
  const rows = items.slice(0, 200).map(x => `
    <div class="word-row" style="cursor:default">
      ${isKnown('o:' + x.id) ? '<span class="badge-known"></span>' : '<span style="width:8px"></span>'}
      <span class="w">${x.text}</span>
      <span class="p">${x.sourceWord}</span>
      <span class="level-tag lvl-${x.level}">${x.level || ''}</span>
    </div>
  `).join('');
  return `<input class="search-box" placeholder="Rechercher une collocation…" value="${BrowseState.query}" oninput="onBrowseSearch(event)">
    <p class="page-sub">${State.collocations.length} collocations au total — recherche pour en trouver une précise.</p>
    <div class="word-list">${rows}</div>`;
}

function renderBrowseNuances() {
  const rows = State.nuances.map(g => `
    <div class="card card-pad" style="margin-bottom:12px">
      <div class="section-title">${g.title}</div>
      ${g.words.map(w => `<div class="example-line"><div class="en"><strong>${w.word}</strong> — ${w.nuance}</div><div class="fr">${w.example}</div></div>`).join('')}
    </div>
  `).join('');
  return rows;
}

function openWordDetail(id) {
  try {
    openWordDetailUnsafe(id);
  } catch (err) {
    console.error('[Carnet] openWordDetail a échoué pour id=' + id + ':', err);
    document.querySelectorAll('.detail-overlay').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'detail-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `<div class="detail-sheet"><div class="def-line">Contenu indisponible pour ce mot.</div>
      <button class="btn btn-ghost btn-block" style="margin-top:16px" onclick="this.closest('.detail-overlay').remove()">Fermer</button></div>`;
    document.body.appendChild(overlay);
  }
}
function openWordDetailUnsafe(id) {
  const w = State.byId.get(id);
  if (!w) throw new Error('mot introuvable pour id=' + id);
  const collocations = (w.collocations || []);
  const phrasal = (w.phrasalVerbs || []);
  const expressions = (w.expressions || []);
  const synonyms = (w.synonyms || []);
  const audioAvailable = hasAudio(id, 'mot');
  const key = 'v:' + id;

  // Plus de bouton "Écouter" séparé : on appuie directement sur le texte
  // (définition, exemple, mot, section) et l'audio correspondant se lance.
  // Sections narrated as ONE audio file covering several items in a row,
  // with a 4s silence between each — the numbered list here follows the
  // exact same order the audio reads them in, so you can follow along.
  const narratedList = (title, category, items) => {
    if (!items || !items.length) return '';
    const tappable = hasAudio(id, category);
    const rows = items.map((x, i) => `<div class="numbered-row"><span class="num-idx">${i + 1}</span><span>${x}</span></div>`).join('');
    return `<div class="detail-section${tappable ? ' tap-audio' : ''}" ${tappable ? `onclick="playAudioFor(${id}, '${category}')"` : ''}>
      <div class="h">${title}${tappable ? '<span class="audio-cue">♪</span>' : ''}</div>
      ${items.length > 1 ? '<div class="mini-note">Un seul fichier audio lit ces éléments à la suite, dans cet ordre, avec 4s de silence entre chacun.</div>' : ''}
      ${rows}
    </div>`;
  };

  const examplesList = (w.examples || []);
  const examplesTappable = hasAudio(id, 'examples');
  const examplesBlock = examplesList.length ? `<div class="detail-section${examplesTappable ? ' tap-audio' : ''}" ${examplesTappable ? `onclick="playAudioFor(${id}, 'examples')"` : ''}>
      <div class="h">Exemples${examplesTappable ? '<span class="audio-cue">♪</span>' : ''}</div>
      ${examplesList.length > 1 ? '<div class="mini-note">Un seul fichier audio lit ces phrases à la suite, avec 4s de silence entre chacune.</div>' : ''}
      ${examplesList.map((e, i) => `<div class="example-line"><div class="en">${examplesList.length > 1 ? (i + 1) + '. ' : ''}${e.en}</div><div class="fr">${e.fr}</div></div>`).join('')}
    </div>` : '';

  const defTappable = hasAudio(id, 'definition');
  const tagBlock = (title, items) => items && items.length ? `
    <div class="detail-section"><div class="h">${title}</div><div class="tag-cloud">${items.map(x => `<span class="tag-pill">${x}</span>`).join('')}</div></div>` : '';

  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="detail-sheet">
      <div class="detail-head">
        <div><div class="detail-word">${w.word} <span class="level-tag lvl-${w.level}">${w.level}</span></div>
        <div class="detail-phon">${w.phonetic || ''} &middot; ${w.partOfSpeech}</div></div>
        <button class="close-x" onclick="this.closest('.detail-overlay').remove()">✕</button>
      </div>
      <div class="translation-line${audioAvailable ? ' tap-audio' : ''}" style="margin-top:14px" ${audioAvailable ? `onclick="playAudioFor(${id}, 'mot')"` : ''}>
        ${w.translation}${audioAvailable ? '<span class="audio-cue">♪</span>' : ''}
      </div>
      <div class="def-line${defTappable ? ' tap-audio' : ''}" ${defTappable ? `onclick="playAudioFor(${id}, 'definition')"` : ''}>
        ${w.definition}${defTappable ? '<span class="audio-cue">♪</span>' : ''}
      </div>
      ${examplesBlock}
      ${narratedList('Collocations', 'collocations', collocations)}
      ${narratedList('Verbes à particule', 'phrasalVerbs', phrasal)}
      ${narratedList('Expressions', 'expressions', expressions)}
      ${tagBlock('Synonymes', synonyms)}
      ${w.frequentErrors ? `<div class="detail-section"><div class="h">Erreur fréquente (FR &rarr; EN)</div><div class="error-note">${w.frequentErrors}</div></div>` : ''}
      <button class="btn btn-teal btn-block" style="margin-top:20px" onclick="addKeyToReviewNow('${key}'); this.closest('.detail-overlay').remove();">
        ${isKnown(key) ? 'Déjà dans mes révisions' : 'Ajouter à mes révisions'}
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function addKeyToReviewNow(key) {
  if (isKnown(key)) return;
  State.progress[key] = sm2({}, 4);
  saveProgress();
}

/* ---------- Stats screen ---------- */
function renderStats() {
  document.getElementById('topbar').classList.remove('hidden');
  document.getElementById('tabbar').classList.remove('hidden');
  const known = Object.keys(State.progress).length;
  const mastered = Object.values(State.progress).filter(c => c.interval >= 21).length;
  const lapses = Object.values(State.progress).reduce((s, c) => s + (c.lapses || 0), 0);
  const days = Object.keys(State.meta.historyByDay).sort().slice(-14);
  const barMax = Math.max(1, ...days.map(d => (State.meta.historyByDay[d].reviewCount || 0) + (State.meta.historyByDay[d].newCount || 0)));
  const bars = days.map(d => {
    const h = State.meta.historyByDay[d];
    const total = (h.reviewCount || 0) + (h.newCount || 0);
    const pct = Math.round((total / barMax) * 100);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1">
      <div style="width:100%;height:70px;display:flex;align-items:flex-end"><div style="width:100%;background:var(--ochre);border-radius:4px;height:${pct}%"></div></div>
      <div style="font-family:var(--mono);font-size:9.5px;color:var(--ink-soft)">${d.slice(5)}</div>
    </div>`;
  }).join('');

  screensEl().innerHTML = `
    <div class="screen">
      <h1 class="page-title">Statistiques</h1>
      <p class="page-sub">Ta progression dans le carnet, tous modules confondus.</p>
      <div class="stat-grid">
        <div class="stat-box"><div class="num">${known}</div><div class="lab">En révision</div></div>
        <div class="stat-box"><div class="num">${mastered}</div><div class="lab">Maîtrisés (21j+)</div></div>
        <div class="stat-box"><div class="num">${State.meta.totalReviews}</div><div class="lab">Révisions totales</div></div>
      </div>
      <div class="card card-pad">
        <div class="section-title">Activité (14 derniers jours)</div>
        <div style="display:flex;gap:6px;align-items:flex-end">${bars || '<p class="page-sub">Pas encore de données.</p>'}</div>
      </div>
      <div class="card card-pad" style="margin-top:16px">
        <div class="section-title">Fiabilité</div>
        <p class="page-sub" style="margin-bottom:0">Total d'échecs corrigés : <strong>${lapses}</strong></p>
      </div>
    </div>
  `;
}

/* ---------- Settings screen ---------- */
function renderSettings() {
  document.getElementById('topbar').classList.remove('hidden');
  document.getElementById('tabbar').classList.remove('hidden');
  screensEl().innerHTML = `
    <div class="screen">
      <h1 class="page-title">Réglages</h1>
      <div class="card card-pad">
        <div class="setting-row">
          <div><div class="t">Nouveaux éléments par jour</div><div class="s">Objectif quotidien, tous modules mélangés</div></div>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="range" min="5" max="50" step="5" value="${State.meta.dailyNewGoal}" oninput="setDailyGoal(this.value)">
            <span style="font-family:var(--mono);width:24px" id="goalVal">${State.meta.dailyNewGoal}</span>
          </div>
        </div>
        <div class="setting-row">
          <div><div class="t">Base de vocabulaire</div><div class="s">${State.vocab.length} mots chargés</div></div>
          <button class="btn" onclick="Router.go('setup')">Recharger</button>
        </div>
        <div class="setting-row">
          <div><div class="t">Dossier audio</div><div class="s">${State.audioIndex ? State.audioIndex.size + ' mots avec audio' : 'Non chargé'}</div></div>
          <button class="btn" onclick="chooseAudioFolder()">Recharger</button>
        </div>
        <div class="setting-row">
          <div><div class="t">Réinitialiser ma progression</div><div class="s">Efface tout l'historique de tous les modules</div></div>
          <button class="btn danger-btn" onclick="resetProgress()">Réinitialiser</button>
        </div>
      </div>
    </div>
  `;
}
function setDailyGoal(v) { State.meta.dailyNewGoal = parseInt(v, 10); saveMeta(); document.getElementById('goalVal').textContent = v; }
function resetProgress() {
  if (!confirm('Effacer toute ta progression ? Cette action est irréversible.')) return;
  State.progress = {}; State.meta.totalReviews = 0; State.meta.streak = 0; State.meta.historyByDay = {};
  saveProgress(); saveMeta(); renderSettings();
}

/* ---------- Session screen (exercise runner) ---------- */
function renderSession() {
  document.getElementById('topbar').classList.add('hidden');
  document.getElementById('tabbar').classList.add('hidden');
  const s = State.session;
  const ex = s.currentExercise;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 100;
  const header = `
    <div class="session-top">
      <button class="exit-x" onclick="if(confirm('Quitter la session en cours ?')) Router.go('dashboard')">✕</button>
      <div class="session-progress-track"><div class="session-progress-fill" style="width:${pct}%"></div></div>
      <div class="session-count">${s.done}/${s.total}</div>
    </div>
  `;
  let body = '';
  if (ex.word) {
    // vocab exercise
    if (ex.type === 'flashcard') body = flashcardHTML(ex);
    else if (ex.type === 'mcq_trans') body = mcqHTML(ex, 'Quelle est la traduction ?', ex.word.word, ex.word.phonetic);
    else if (ex.type === 'mcq_word') body = mcqHTML(ex, 'Quel mot correspond à cette traduction ?', firstTranslation(ex.word.translation), '');
    else if (ex.type === 'cloze') body = clozeHTML(ex);
    else if (ex.type === 'listening') body = listeningHTML(ex);
  } else if (ex.item) {
    // phrasal verb / idiom / connector exercise
    body = phraseBodyHTML(ex);
  } else if (ex.type === 'grammar_mcq') body = grammarMcqHTML(ex);
  else if (ex.type === 'grammar_gap') body = grammarGapHTML(ex);
  else if (ex.type === 'collocation_mcq') body = collocationMcqHTML(ex);
  else if (ex.type === 'nuance_mcq') body = nuanceMcqHTML(ex);

  // PHASE 0.2 — dernier filet : si malgré tout aucune branche ci-dessus n'a
  // produit de contenu (type d'exercice non reconnu), on log l'anomalie au
  // lieu de laisser une carte muette/blanche, et on passe à la carte
  // suivante automatiquement après un court délai.
  if (!body) {
    console.error('[Carnet] renderSession: aucun gabarit ne correspond à cet exercice, carte ignorée :', ex);
    body = `<div class="def-line">Contenu indisponible pour cette carte (passage automatique à la suivante).</div>`;
    setTimeout(() => nextExerciseInSession(), 600);
  }

  screensEl().innerHTML = `<div class="screen">${header}<div class="card ex-card">${body}</div></div>`;
  const auto = document.getElementById('autoPlayAudio');
  if (auto && ex.id != null) playAudioFor(ex.id);
}

function phraseBodyHTML(ex) {
  if (ex.type === 'flashcard') return phraseFlashcardHTML(ex);
  if (ex.type === 'mcq_trans') return mcqHTML({ ...ex, word: null }, 'Quelle est la traduction ?', ex.item.phrase, '');
  if (ex.type === 'cloze') return phraseClozeHTML(ex);
  if (ex.type === 'gap') return connectorGapHTML(ex);
  if (ex.type === 'mcq_function') return connectorMcqHTML(ex);
  return '';
}

function flashcardHTML(ex) {
  const w = ex.word;
  const audioAvailable = hasAudio(ex.id, 'mot');
  const defTappable = hasAudio(ex.id, 'definition');
  const exTappable = hasAudio(ex.id, 'examples');
  return `
    <div class="ex-kind">Carte &middot; <span class="level-tag lvl-${w.level}">${w.level}</span></div>
    <div class="ex-body">
      <div class="${audioAvailable ? 'tap-audio' : ''}" ${audioAvailable ? `onclick="playAudioFor(${ex.id}, 'mot')"` : ''}>
        <div class="ex-prompt-word">${w.word}${audioAvailable ? '<span class="audio-cue">♪</span>' : ''}</div>
        <div class="ex-prompt-phon">${w.phonetic || ''}</div>
      </div>
      <div id="fc-reveal" class="hidden">
        <div class="translation-line">${w.translation}</div>
        <div class="def-line${defTappable ? ' tap-audio' : ''}" ${defTappable ? `onclick="playAudioFor(${ex.id}, 'definition')"` : ''}>${w.definition}${defTappable ? '<span class="audio-cue">♪</span>' : ''}</div>
        ${w.examples && w.examples[0] ? `<div class="example-line${exTappable ? ' tap-audio' : ''}" style="border-top:none" ${exTappable ? `onclick="playAudioFor(${ex.id}, 'examples')"` : ''}><div class="en">${w.examples[0].en}${exTappable ? '<span class="audio-cue">♪</span>' : ''}</div><div class="fr">${w.examples[0].fr}</div></div>` : ''}
      </div>
      <button class="btn btn-ghost" id="fc-reveal-btn" onclick="revealFlashcard()">Afficher la traduction</button>
      <div id="fc-grades" class="grade-row hidden">
        <button class="grade-btn grade-again" onclick="answerFlashcard(1)">Encore</button>
        <button class="grade-btn grade-hard" onclick="answerFlashcard(3)">Difficile</button>
        <button class="grade-btn grade-good" onclick="answerFlashcard(4)">Bien</button>
        <button class="grade-btn grade-easy" onclick="answerFlashcard(5)">Facile</button>
      </div>
    </div>
  `;
}
function revealFlashcard() {
  document.getElementById('fc-reveal').classList.remove('hidden');
  document.getElementById('fc-reveal-btn').classList.add('hidden');
  document.getElementById('fc-grades').classList.remove('hidden');
}
function answerFlashcard(quality) { submitSessionAnswer(quality, quality >= 3); nextExerciseInSession(); }

function phraseFlashcardHTML(ex) {
  const it = ex.item;
  return `
    <div class="ex-kind">Carte &middot; <span class="level-tag lvl-${it.level}">${it.level}</span></div>
    <div class="ex-body">
      <div class="ex-prompt-word" style="font-size:26px">${it.phrase}</div>
      <div id="fc-reveal" class="hidden">
        <div class="translation-line">${it.translation}</div>
        <div class="def-line">${it.definition}</div>
        <div class="example-line" style="border-top:none"><div class="en">${it.example.en}</div><div class="fr">${it.example.fr}</div></div>
      </div>
      <button class="btn btn-ghost" id="fc-reveal-btn" onclick="revealFlashcard()">Afficher la traduction</button>
      <div id="fc-grades" class="grade-row hidden">
        <button class="grade-btn grade-again" onclick="answerFlashcard(1)">Encore</button>
        <button class="grade-btn grade-hard" onclick="answerFlashcard(3)">Difficile</button>
        <button class="grade-btn grade-good" onclick="answerFlashcard(4)">Bien</button>
        <button class="grade-btn grade-easy" onclick="answerFlashcard(5)">Facile</button>
      </div>
    </div>
  `;
}

function mcqHTML(ex, question, promptWord, phon) {
  const w = ex.word;
  const audioAvailable = w && hasAudio(ex.id, 'mot') && ex.type === 'mcq_trans';
  return `
    <div class="ex-kind">${question}</div>
    <div class="ex-body">
      <div class="${audioAvailable ? 'tap-audio' : ''}" ${audioAvailable ? `onclick="playAudioFor(${ex.id}, 'mot')"` : ''}>
        <div class="ex-prompt-word">${promptWord}${audioAvailable ? '<span class="audio-cue">♪</span>' : ''}</div>
        ${phon ? `<div class="ex-prompt-phon">${phon}</div>` : ''}
      </div>
      <div class="mcq-grid" id="mcq-grid">${ex.options.map((o, i) => `<button class="mcq-opt" onclick="answerMcqByIndex(this, ${i})">${o}</button>`).join('')}</div>
    </div>
  `;
}
// Bug corrigé : l'ancienne version injectait le texte de l'option directement
// dans l'attribut onclick (avec un échappement partiel des apostrophes).
// Toute option contenant un guillemet double cassait l'attribut HTML et
// pouvait laisser la carte illisible/blanche. On passe désormais par l'index
// de l'option dans ex.options, jamais par le texte brut.
function answerMcqByIndex(btn, idx) {
  const ex = State.session.currentExercise;
  answerMcq(btn, ex.options[idx]);
}
function answerMcq(btn, chosen) {
  const ex = State.session.currentExercise;
  const correct = chosen === ex.answer;
  document.querySelectorAll('#mcq-grid .mcq-opt').forEach(b => {
    b.onclick = null;
    if (b.textContent === String(ex.answer)) b.classList.add('correct');
    else if (b === btn && !correct) b.classList.add('wrong');
  });
  setTimeout(() => { submitSessionAnswer(qualityFromCorrectness(correct, false), correct); nextExerciseInSession(); }, 700);
}

function clozeHTML(ex) {
  const sentence = ex.sentence.replace(new RegExp('\\b' + ex.answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), '<span class="blank">&nbsp;</span>');
  const canListen = hasAudio(ex.id, 'examples');
  return `
    <div class="ex-kind">Complète la phrase &middot; <span class="level-tag lvl-${ex.word.level}">${ex.word.level}</span></div>
    <div class="ex-body">
      <div class="ex-prompt-sentence${canListen ? ' tap-audio' : ''}" ${canListen ? `onclick="playAudioFor(${ex.id}, 'examples')"` : ''}>${sentence}${canListen ? '<span class="audio-cue">♪</span>' : ''}</div>
      <div style="font-size:13px;color:var(--ink-soft)">${ex.fr || ''}</div>
      <input class="text-answer" id="clozeInput" placeholder="mot manquant" autocomplete="off" onkeydown="if(event.key==='Enter') submitCloze()">
      <div id="clozeFeedback" class="feedback-line"></div>
      <button class="btn btn-primary" onclick="submitCloze()">Valider</button>
    </div>
  `;
}
function submitCloze() {
  const ex = State.session.currentExercise;
  const input = document.getElementById('clozeInput');
  const correct = normalize(input.value) === normalize(ex.answer);
  input.classList.add(correct ? 'correct' : 'wrong'); input.disabled = true;
  document.getElementById('clozeFeedback').innerHTML = correct ? '<span class="feedback-line correct">Exact !</span>' : `<span class="feedback-line wrong">Réponse : ${ex.answer}</span>`;
  document.querySelector('.ex-body .btn-primary').textContent = 'Continuer';
  document.querySelector('.ex-body .btn-primary').onclick = () => { submitSessionAnswer(qualityFromCorrectness(correct, false), correct); nextExerciseInSession(); };
}

function phraseClozeHTML(ex) {
  const re = new RegExp(ex.answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const sentence = ex.sentence.replace(re, '<span class="blank">&nbsp;</span>');
  return `
    <div class="ex-kind">Complète la phrase (verbe à particule / idiome)</div>
    <div class="ex-body">
      <div class="ex-prompt-sentence">${sentence}</div>
      <div style="font-size:13px;color:var(--ink-soft)">${ex.fr || ''}</div>
      <input class="text-answer" id="clozeInput" placeholder="expression manquante" autocomplete="off" onkeydown="if(event.key==='Enter') submitCloze()">
      <div id="clozeFeedback" class="feedback-line"></div>
      <button class="btn btn-primary" onclick="submitCloze()">Valider</button>
    </div>
  `;
}

function listeningHTML(ex) {
  return `
    <div class="ex-kind">Dictée audio &middot; <span class="level-tag lvl-${ex.word.level}">${ex.word.level}</span></div>
    <div class="ex-body">
      <div class="tap-audio" style="font-size:13px;color:var(--ink-soft)" onclick="playAudioFor(${ex.id}, 'mot')">Écoute et écris le mot entendu. <span class="audio-cue">♪ Réécouter</span></div>
      <input class="text-answer" id="listenInput" placeholder="…" autocomplete="off" onkeydown="if(event.key==='Enter') submitListening()">
      <div id="listenFeedback" class="feedback-line"></div>
      <button class="btn btn-primary" onclick="submitListening()">Valider</button>
    </div>
    <span id="autoPlayAudio" class="hidden"></span>
  `;
}
function submitListening() {
  const ex = State.session.currentExercise;
  const input = document.getElementById('listenInput');
  const correct = normalize(input.value) === normalize(ex.answer);
  input.classList.add(correct ? 'correct' : 'wrong'); input.disabled = true;
  document.getElementById('listenFeedback').innerHTML = correct ? '<span class="feedback-line correct">Exact !</span>' : `<span class="feedback-line wrong">Réponse : ${ex.answer}</span>`;
  document.querySelector('.ex-body .btn-primary').textContent = 'Continuer';
  document.querySelector('.ex-body .btn-primary').onclick = () => { submitSessionAnswer(qualityFromCorrectness(correct, false), correct); nextExerciseInSession(); };
}

/* ----- grammar exercise UIs ----- */
function grammarMcqHTML(ex) {
  return `
    <div class="ex-kind">Grammaire &middot; ${ex.point.title} &middot; <span class="level-tag lvl-${ex.point.level.split('/')[0]}">${ex.point.level}</span></div>
    <div class="ex-body">
      <div class="ex-prompt-sentence">${ex.drill.prompt}</div>
      <div class="mcq-grid" id="mcq-grid">${ex.options.map((o, i) => `<button class="mcq-opt" onclick="answerMcqByIndex(this, ${i})">${o}</button>`).join('')}</div>
    </div>
  `;
}
function grammarGapHTML(ex) {
  const inputs = ex.answers.map((a, i) => `<input class="text-answer" id="gGap${i}" placeholder="…" autocomplete="off" style="margin-bottom:8px">`).join('');
  window.__gapCount = ex.answers.length;
  return `
    <div class="ex-kind">Grammaire &middot; ${ex.point.title} &middot; <span class="level-tag lvl-${ex.point.level.split('/')[0]}">${ex.point.level}</span></div>
    <div class="ex-body">
      <div class="ex-prompt-sentence">${ex.drill.prompt}</div>
      ${inputs}
      <div id="gapFeedback" class="feedback-line"></div>
      <button class="btn btn-primary" onclick="submitGrammarGap()">Valider</button>
    </div>
  `;
}
function submitGrammarGap() {
  const ex = State.session.currentExercise;
  let allCorrect = true;
  const results = ex.answers.map((a, i) => {
    const el = document.getElementById('gGap' + i);
    const ok = looseMatch(el.value, a);
    el.classList.add(ok ? 'correct' : 'wrong'); el.disabled = true;
    if (!ok) allCorrect = false;
    return ok;
  });
  document.getElementById('gapFeedback').innerHTML = allCorrect
    ? '<span class="feedback-line correct">Exact !</span>'
    : `<span class="feedback-line wrong">Réponse attendue : ${ex.answers.join(' / ')}</span>`;
  const btn = document.querySelector('.ex-body .btn-primary');
  btn.textContent = 'Continuer';
  btn.onclick = () => { submitSessionAnswer(qualityFromCorrectness(allCorrect, false), allCorrect); nextExerciseInSession(); };
}

/* ----- connector exercise UIs ----- */
function connectorGapHTML(ex) {
  const re = new RegExp(ex.answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const sentence = ex.sentence.replace(re, '<span class="blank">&nbsp;</span>');
  return `
    <div class="ex-kind">Connecteur logique &middot; ${ex.item.function}</div>
    <div class="ex-body">
      <div class="ex-prompt-sentence">${sentence}</div>
      <div style="font-size:13px;color:var(--ink-soft)">${ex.fr || ''}</div>
      <input class="text-answer" id="clozeInput" placeholder="connecteur manquant" autocomplete="off" onkeydown="if(event.key==='Enter') submitCloze()">
      <div id="clozeFeedback" class="feedback-line"></div>
      <button class="btn btn-primary" onclick="submitCloze()">Valider</button>
    </div>
  `;
}
function connectorMcqHTML(ex) {
  return `
    <div class="ex-kind">Quel connecteur convient ? &middot; ${ex.item.function}</div>
    <div class="ex-body">
      <div class="ex-prompt-sentence">${ex.item.example.en.replace(new RegExp(ex.item.connector, 'i'), '<span class="blank">&nbsp;</span>')}</div>
      <div class="mcq-grid" id="mcq-grid">${ex.options.map((o, i) => `<button class="mcq-opt" onclick="answerMcqByIndex(this, ${i})">${o}</button>`).join('')}</div>
    </div>
  `;
}

/* ----- collocation & nuance UIs ----- */
function collocationMcqHTML(ex) {
  return `
    <div class="ex-kind">Quelle est la collocation correcte ?</div>
    <div class="ex-body">
      <div class="mcq-grid" id="mcq-grid">${ex.options.map((o, i) => `<button class="mcq-opt" onclick="answerMcqByIndex(this, ${i})">${o}</button>`).join('')}</div>
    </div>
  `;
}
function nuanceMcqHTML(ex) {
  const sentence = ex.sentence.replace(new RegExp('\\b' + ex.answer + '\\b', 'i'), '<span class="blank">&nbsp;</span>');
  return `
    <div class="ex-kind">Nuance de sens &middot; ${ex.group.title}</div>
    <div class="ex-body">
      <div class="ex-prompt-sentence">${sentence}</div>
      <div class="mcq-grid" id="mcq-grid">${ex.options.map((o, i) => `<button class="mcq-opt" onclick="answerMcqByIndex(this, ${i})">${o}</button>`).join('')}</div>
    </div>
  `;
}

/* ---------- Summary screen ---------- */
function renderSummary() {
  document.getElementById('topbar').classList.remove('hidden');
  document.getElementById('tabbar').classList.remove('hidden');
  const s = State.session || { done: 0, correct: 0 };
  const pct = s.done ? Math.round((s.correct / s.done) * 100) : 100;
  screensEl().innerHTML = `
    <div class="screen">
      <h1 class="page-title" style="text-align:center">Session terminée</h1>
      <div class="summary-stamp">${pct}%</div>
      <p class="page-sub" style="text-align:center">${s.done} carte${s.done > 1 ? 's' : ''} travaillée${s.done > 1 ? 's' : ''} &middot; série actuelle : ${State.meta.streak} jour${State.meta.streak > 1 ? 's' : ''}</p>
      <div class="row-actions">
        <button class="btn btn-primary" onclick="Router.go('dashboard')">Retour à l'accueil</button>
        <button class="btn btn-teal" onclick="startSession()">Nouvelle session</button>
      </div>
    </div>
  `;
}

/* ---------- 8. Router ---------- */
// PHASE 0.2 — plus jamais d'écran blanc : toute exception pendant le rendu
// d'un écran est loguée en console (avec l'écran et la stack) et remplacée
// par un écran "Contenu indisponible" avec un bouton retour, au lieu de
// laisser une page blanche silencieuse.
function renderFatalScreenError(screen, err) {
  console.error(`[Carnet] Échec du rendu de l'écran "${screen}":`, err);
  const el = screensEl();
  if (!el) return;
  el.innerHTML = `
    <div class="screen">
      <div class="card" style="text-align:center;padding:40px 20px">
        <p style="font-size:17px;font-weight:600;margin-bottom:8px">Contenu indisponible</p>
        <p class="page-sub">Une erreur est survenue en affichant cet écran (${screen}). Détail dans la console.</p>
        <button class="btn btn-primary" style="margin-top:16px" onclick="Router.go('dashboard')">Retour à l'accueil</button>
      </div>
    </div>`;
}
const Router = {
  current: 'setup',
  go(screen) {
    this.current = screen;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === screen));
    try {
      if (screen === 'setup') renderSetup();
      else if (screen === 'dashboard') renderDashboard();
      else if (screen === 'browse') renderBrowse();
      else if (screen === 'stats') renderStats();
      else if (screen === 'settings') renderSettings();
      else if (screen === 'session') renderSession();
      else if (screen === 'summary') renderSummary();
    } catch (err) {
      renderFatalScreenError(screen, err);
    }
    window.scrollTo(0, 0);
  }
};
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => Router.go(b.dataset.screen)));

/* ---------- Init ---------- */
(async function init() {
  loadLocalState();
  const auto = await tryAutoLoadAll();
  if (auto) { Router.go('dashboard'); return; }
  const cached = await tryAutoLoadCachedVocabOnly();
  if (cached) { Router.go('dashboard'); return; }
  Router.go('setup');
})();
