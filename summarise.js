/**
 * summarise.js — the AI step.
 *
 * Takes today's tagged stories and produces the three things the website
 * reads: country briefings, the daily digest, and the quiz bank.
 *
 * Everything here is written to be CHEAP:
 *  - countries are batched three per call, so the long system prompt is paid
 *    for once instead of ten times
 *  - the quiz is generated weekly, not daily
 *  - only headlines and feed summaries are sent, never article text (which is
 *    also the right side of the copyright line)
 */

const { askForJson } = require('./ai');
const { COUNTRIES } = require('./feeds');

// The glossary keys the model is allowed to mark up. These are defined in
// index.html; add there first, then here.
const GLOSSARY_KEYS = ['inflation', 'gilt', 'carry', 'deflation'];

// ---------------------------------------------------------------------------
// Shared rules. The same instructions apply to every prompt, so they live in
// one string — and any change to Ridar's voice happens in one place.
// ---------------------------------------------------------------------------
const HOUSE_RULES = `
You write commercial awareness briefings for finance students. You explain what
happened and why it matters. You never give investment advice, make predictions,
or express political opinions.

RULES
1. Use ONLY the facts in the SOURCES block. If a number, date, vote count or
   name is not there, do not state it. No outside knowledge.
2. Never reproduce source wording. Write every sentence yourself.
3. If the sources are too thin for a story, return fewer stories. Never pad.
4. Write three versions of every text field, keyed "b", "i" and "a":
   b = BEGINNER. No jargon at all. Any unavoidable term is defined in the
       sentence that uses it. Short sentences. Assume no prior knowledge.
   i = INTERMEDIATE. Standard financial vocabulary used correctly, with the
       mechanism named. Assume a second-year economics student.
   a = ADVANCED. Second-order reasoning: the transmission channel, what the
       market is actually pricing, what would falsify the reading. Assume a
       candidate at a final-round interview.
5. In the "i" and "a" text only, you may mark ONE jargon term per story as
   <span class='term' data-t='KEY'>term</span>, using a KEY from GLOSSARY_KEYS.
   Use single quotes inside that tag, exactly as shown, so it stays valid JSON.
   Never invent a key.
6. No hype, no "this could mean", no emoji, no exclamation marks, no rhetorical
   questions. British English.
7. Return ONLY valid JSON matching the requested shape. No commentary.
`.trim();

// ---------------------------------------------------------------------------
// Turn a list of stories into the compact text block the model reads.
// Headline, source, time and feed summary — nothing else. Small input keeps
// the run inside a free tier.
// ---------------------------------------------------------------------------
// The digest, politics and timeline are rendered as escaped text by index.html
// (only the country story body renders raw HTML, for the glossary <span>). If a
// model drops that markup into a plain-text field, strip it back to words.
function plain(v) {
  if (typeof v === 'string') return v.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

function sourceBlock(stories) {
  return stories
    .map((s, i) => `[${i + 1}] ${s.source} | ${s.publishedAt}\n    ${s.headline}\n    ${s.summary || '(no summary in feed)'}\n    ${s.link}`)
    .join('\n');
}

// Build the "Financial Times · Bank of England · 29 Aug" line the panel shows.
function sourceLine(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  const outlets = [...new Set(sources.map((s) => s.outlet).filter(Boolean))].slice(0, 3);
  return outlets.join(' · ');
}

// ---------------------------------------------------------------------------
// 1. Country briefings — batched.
//    Three countries per call. Ten countries becomes four calls.
// ---------------------------------------------------------------------------
async function buildBriefings(byCountry, { batchSize = 1 } = {}) {
  // Skip countries with fewer than two stories: better no briefing than a
  // thin one invented from a single headline.
  const iso3s = Object.keys(byCountry).filter((iso3) => byCountry[iso3].length >= 2);
  const skipped = Object.keys(byCountry).filter((iso3) => !iso3s.includes(iso3));
  if (skipped.length) console.log(`  skipping (too few stories): ${skipped.join(' ')}`);

  const briefings = {};

  for (let i = 0; i < iso3s.length; i += batchSize) {
    const batch = iso3s.slice(i, i + batchSize);
    console.log(`  briefing batch: ${batch.join(' ')}`);

    const system = `${HOUSE_RULES}

GLOSSARY_KEYS: ${GLOSSARY_KEYS.join(', ')}

OUTPUT SHAPE
{"briefings": {
  "<ISO3>": {
    "sub": "one line, max 60 characters, what today is about for this country",
    "stories": [{
      "t": "headline you write yourself",
      "b": "...", "i": "...", "a": "...",
      "gloss": "one GLOSSARY_KEY or null",
      "sources": [{"outlet": "...", "url": "..."}]
    }],
    "politics": {"b": "...", "i": "...", "a": "..."},
    "timeline": [{"date": "12 Aug", "text": "one line, factual"}]
  }
}}

Two or three stories per country. Two to four timeline entries, oldest first,
only events actually named in the sources.`;

    const user = batch
      .map((iso3) => `COUNTRY ${iso3} — ${COUNTRIES[iso3].label}\nSOURCES:\n${sourceBlock(byCountry[iso3])}`)
      .join('\n\n----------------\n\n');

    const result = await askForJson(system, user, { maxTokens: 24000 });

    for (const iso3 of batch) {
      const raw = result.briefings?.[iso3];
      if (!raw) { console.log(`  ! no output for ${iso3}`); continue; }
      briefings[COUNTRIES[iso3].name] = shapeCountry(iso3, raw);
    }
  }

  return briefings;
}

// Reshape the model's output into exactly what index.html expects, and drop
// anything that fails validation.
function shapeCountry(iso3, raw) {
  const stories = (raw.stories || [])
    .filter((s) => s.t && s.b && Array.isArray(s.sources) && s.sources.length)
    .map((s) => ({
      t: s.t,
      src: sourceLine(s.sources),
      b: s.b,
      i: s.i || s.b,
      a: s.a || s.i || s.b,
      gloss: GLOSSARY_KEYS.includes(s.gloss) ? s.gloss : undefined,
      links: s.sources.map((x) => x.url).filter(Boolean),
    }));

  return {
    iso3,
    label: COUNTRIES[iso3].label,
    sub: plain(raw.sub) || '',
    ind: [],                                   // market data: not fetched (see README)
    stories,
    politics: plain(raw.politics) || { b: '', i: '', a: '' },
    timeline: (raw.timeline || []).map((t) => [plain(t.date) || '', plain(t.text) || '']),
  };
}

// ---------------------------------------------------------------------------
// 2. The daily digest — one call, the whole world.
// ---------------------------------------------------------------------------
async function buildDigest(briefings) {
  console.log('  digest');

  const system = `${HOUSE_RULES}

You are writing the one-screen summary of the day, for someone with two minutes.
Name the single thing that mattered most and why. Then three or four one-line
items, each tied to one country. Then say what connects them — and if nothing
does, say the day was quiet rather than manufacturing a narrative.

OUTPUT SHAPE
{"headline": "one sentence, the day in a line",
 "lede": {"b": "...", "i": "...", "a": "..."},
 "items": [{"country": "<exact country name as given>", "b": "...", "i": "...", "a": "..."}],
 "thread": {"b": "...", "i": "...", "a": "..."}}`;

  const user = Object.entries(briefings)
    .map(([name, c]) => `COUNTRY: ${name}\nSUB: ${c.sub}\nSTORIES:\n${c.stories.map((s) => `- ${s.t}: ${s.i}`).join('\n')}`)
    .join('\n\n');

  const raw = await askForJson(system, user, { maxTokens: 24000 });

  return {
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    headline: plain(raw.headline) || '',
    lede: plain(raw.lede) || { b: '', i: '', a: '' },
    items: (raw.items || [])
      .filter((it) => briefings[it.country])
      .map((it) => ({ c: it.country, b: plain(it.b), i: plain(it.i || it.b), a: plain(it.a || it.i || it.b) })),
    thread: plain(raw.thread) || { b: '', i: '', a: '' },
  };
}

// ---------------------------------------------------------------------------
// 3. The quiz — one call per level, run weekly.
//    Eight questions per level; the site serves a deterministic daily five.
//
//    The model always puts the correct answer FIRST and sets a: 0. The site
//    shuffles at render time with a daily seed. Asking a model to distribute
//    correct answers randomly produces a detectable bias; shuffling in code
//    does not.
// ---------------------------------------------------------------------------
async function buildQuiz(briefings) {
  const levels = { b: 'BEGINNER', i: 'INTERMEDIATE', a: 'ADVANCED' };
  const questions = [];

  const context = Object.entries(briefings)
    .map(([name, c]) => `COUNTRY: ${name}\n${c.stories.map((s) => `- ${s.t}\n  ${s.i}\n  ${s.a}`).join('\n')}`)
    .join('\n\n');

  for (const [key, label] of Object.entries(levels)) {
    console.log(`  quiz: ${label.toLowerCase()}`);

    const system = `${HOUSE_RULES}

You write multiple-choice questions that test whether someone understood the
briefings supplied.

QUESTION RULES
1. Answerable from the briefings alone. No outside knowledge, no arithmetic on
   numbers that were not given.
2. Test the mechanism, not recall of a figure. "Why did the share price fall
   despite the earnings beat?" not "What was revenue?"
3. Four options, exactly one correct. Wrong options must be plausible and wrong
   for a reason — the common misconception, never a joke answer.
4. Put the CORRECT option first in the array and set "a": 0. Always.
5. The explanation teaches: why the right answer is right, and why the most
   tempting wrong one is wrong. Two or three sentences.
6. Difficulty for this run: ${label}.
   BEGINNER = definitions and direction of effect.
   INTERMEDIATE = mechanism and second-order effect.
   ADVANCED = what the market is pricing, and what would falsify the reading.
7. Spread the eight questions across different countries and themes.

OUTPUT SHAPE
{"questions": [{
  "tag": "United Kingdom · Fixed income",
  "q": "...",
  "o": ["correct", "wrong", "wrong", "wrong"],
  "a": 0,
  "e": "..."
}]}`;

    const raw = await askForJson(system, `BRIEFINGS\n\n${context}`, { maxTokens: 24000 });

    for (const q of raw.questions || []) {
      if (!q.q || !Array.isArray(q.o) || q.o.length !== 4 || !q.e) continue;
      questions.push({ lvl: key, tag: q.tag || '', q: q.q, o: q.o, a: 0, e: q.e });
    }
  }

  return questions;
}

module.exports = { buildBriefings, buildDigest, buildQuiz, GLOSSARY_KEYS };
