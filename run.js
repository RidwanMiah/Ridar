/**
 * run.js — the daily job.
 *
 * fetch news → decide whether anything changed → summarise → write JSON.
 *
 *   node run.js              # normal run: skips the AI if nothing changed
 *   node run.js --force      # summarise regardless
 *   node run.js --dry        # fetch and report, make no AI calls, write nothing
 *   node run.js --only GBR   # one country, for testing prompts cheaply
 *
 * Output goes to data/. Those files are what the website reads, and what the
 * GitHub Action commits back to the repo. There is no database.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { fetchStories, groupByCountry } = require('./fetch-news');
const { buildBriefings, buildDigest, buildQuiz } = require('./summarise');
const { PROVIDER, MODEL } = require('./ai');

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  briefings: path.join(DATA_DIR, 'briefings.json'),
  quiz: path.join(DATA_DIR, 'quiz.json'),
  state: path.join(DATA_DIR, 'state.json'),
};

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry');
const ONLY = args.includes('--only') ? (args[args.indexOf('--only') + 1] || '').toUpperCase() : null;

// Regenerate the quiz at most once every N days. This is the single biggest
// saving in the pipeline — seven calls a week become one.
const QUIZ_MAX_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Small file helpers. Missing files are normal on a first run.
// ---------------------------------------------------------------------------
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`  wrote ${path.relative(__dirname, file)} (${(fs.statSync(file).size / 1024).toFixed(1)}kB)`);
}

// ---------------------------------------------------------------------------
// Change detection.
//
// Hash the set of headlines per country. If a country's headlines are the same
// as last run, its briefing is already correct and we skip the AI call for it.
// On a quiet day this can skip the whole run, which costs nothing at all.
// ---------------------------------------------------------------------------
function hashStories(stories) {
  const key = stories.map((s) => s.headline).sort().join('|');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  console.log(`\nRidar daily run — ${new Date().toISOString()}`);
  console.log(`provider: ${PROVIDER} · model: ${MODEL}${DRY ? ' · DRY RUN' : ''}\n`);

  // ---- 1. fetch -----------------------------------------------------------
  console.log('fetching feeds…');
  const { stories, failures } = await fetchStories({ hours: 24 });
  console.log(`  ${stories.length} stories in the last 24h`);
  if (failures.length) failures.forEach((f) => console.log(`  ! ${f.source}: ${f.reason}`));

  let byCountry = groupByCountry(stories);
  if (ONLY) {
    byCountry = { [ONLY]: byCountry[ONLY] || [] };
    console.log(`  --only ${ONLY}: ${byCountry[ONLY].length} stories`);
  }

  const counts = Object.entries(byCountry).map(([iso3, list]) => `${iso3}:${list.length}`).join('  ');
  console.log(`  per country — ${counts}`);

  // ---- 2. decide what needs regenerating ---------------------------------
  const state = readJson(FILES.state, { hashes: {}, quizGeneratedAt: null, lastRun: null });
  const previous = readJson(FILES.briefings, { countries: {} });

  const changed = [];
  const nextHashes = {};
  for (const [iso3, list] of Object.entries(byCountry)) {
    const hash = hashStories(list);
    nextHashes[iso3] = hash;
    if (list.length >= 2 && (FORCE || state.hashes?.[iso3] !== hash)) changed.push(iso3);
  }

  console.log(changed.length
    ? `\n${changed.length} countries with new stories: ${changed.join(' ')}`
    : '\nNo new stories since the last run. Nothing to summarise.');

  if (DRY) {
    console.log('\nDry run — stopping before any AI call.\n');
    return;
  }

  if (!changed.length && previous.countries && Object.keys(previous.countries).length) {
    // Keep yesterday's file live. Touch nothing.
    state.lastRun = new Date().toISOString();
    writeJson(FILES.state, state);
    console.log('Kept the existing briefings. Zero AI calls, zero cost.\n');
    return;
  }

  // ---- 3. summarise the changed countries --------------------------------
  console.log('\nsummarising…');
  const subset = {};
  for (const iso3 of changed) subset[iso3] = byCountry[iso3];

  const fresh = await buildBriefings(subset);

  // Merge: new briefings over yesterday's, so a country whose feeds were quiet
  // keeps its last good briefing instead of disappearing off the globe.
  const countries = { ...(previous.countries || {}), ...fresh };

  // ---- 4. digest ---------------------------------------------------------
  // If the digest call can't be salvaged, keep yesterday's rather than failing
  // the whole run — the country briefings are the important part.
  let digest = previous.digest || null;
  try {
    digest = await buildDigest(countries);
  } catch (err) {
    console.log(`  ! digest failed (${err.message.split('\n')[0]}) — keeping the previous one`);
  }

  // ---- 5. quiz, weekly ---------------------------------------------------
  let quiz = readJson(FILES.quiz, { questions: [] });
  const quizAge = daysSince(state.quizGeneratedAt);
  if (FORCE || quizAge >= QUIZ_MAX_AGE_DAYS || !quiz.questions?.length) {
    console.log(`\nquiz is ${quizAge === Infinity ? 'missing' : `${quizAge.toFixed(1)} days old`} — regenerating`);
    const questions = await buildQuiz(countries);
    if (questions.length) {
      quiz = { generated: new Date().toISOString(), questions };
      state.quizGeneratedAt = quiz.generated;
    } else {
      console.log('  ! no valid questions returned; keeping the existing quiz');
    }
  } else {
    console.log(`\nquiz is ${quizAge.toFixed(1)} days old — reusing it (saves 3 calls)`);
  }

  // ---- 6. write ----------------------------------------------------------
  console.log('\nwriting…');
  writeJson(FILES.briefings, {
    generated: new Date().toISOString(),
    provider: PROVIDER,
    model: MODEL,
    digest,
    countries,
  });
  writeJson(FILES.quiz, quiz);

  state.hashes = { ...(state.hashes || {}), ...nextHashes };
  state.lastRun = new Date().toISOString();
  writeJson(FILES.state, state);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nDone in ${seconds}s. ${Object.keys(countries).length} countries live, ${quiz.questions.length} quiz questions.\n`);
}

main().catch((error) => {
  console.error('\nRun failed:', error.message);
  console.error('The existing data/ files are untouched, so the site still shows the last good day.\n');
  process.exit(1);
});
