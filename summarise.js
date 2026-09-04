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
You write commercial awareness briefings for people learning how markets work.
You explain what happened and why it matters. You never give investment advice,
make predictions, or express political opinions.

RULES
1. Use ONLY the facts in the SOURCES block. If a number, date, vote count or
   name is not there, do not state it. No outside knowledge.
2. Never reproduce source wording. Write every sentence yourself.
3. If the sources are too thin for a story, return fewer stories. Never pad.
4. Write three versions of every "b" / "i" / "a" text field. They are the SAME
   story told to three different readers. The gap between them should be large.

   b = BEGINNER. The reader has never taken an economics class and does not know
       what a bond, a yield, an index or a central bank is. So tell them, in
       plain words, the first time each one comes up — a short "which is…" or
       "this means…". Use everyday comparisons where they help ("like the
       interest on a loan"). Very short sentences. It is fine to spend a
       sentence explaining how something works — that is the point of this
       level, not padding. 4 to 6 sentences.

   i = INTERMEDIATE. The reader has done an intro course. They know what
       inflation, interest rates, bonds and shares are, but not the plumbing.
       Name the mechanism and the transmission — which lever moved what. Use
       standard terms without stopping to define the basic ones. 4 to 5
       sentences.

   a = ADVANCED. The reader works in or seriously studies markets. Go to
       second-order effects: the transmission channel, what price the market is
       now implying, which assumption would have to break for the read to be
       wrong. Assume all vocabulary. 3 to 5 dense sentences.

   Every version: stop when the facts from the sources run out. The LAST
   sentence states a fact, never a summary or significance line — no "these
   developments reflect / show", no "markets will be watching".
5. GLOSSARY: only in "i" and "a", and only when the exact word appears and fits.
   Wrap it as <span class='term' data-t='KEY'>word</span> with single quotes.
   The KEY must be one of GLOSSARY_KEYS and the wrapped word must BE that term or
   its plural — wrap "inflation", "gilts", "carry trade", "deflation", nothing
   else. If none of the keys genuinely apply, add no span. A wrong tag is worse
   than none. At most one per field.
6. Return ONLY valid JSON matching the requested shape. No commentary.

VOICE — this is what separates a real briefing from filler:
- Lead every sentence with its subject and an active verb. "The Fed held rates."
  Not "A decision was taken to hold rates."
- Numerals for every number and percentage: 2.9%, £4bn, 0.75 points, a 6-3 vote.
- Put one concrete fact — a figure, a name, a date from the sources — in most
  sentences.
- Short sentences, rarely over 25 words. Vary the length.
- No sentence whose only job is to say something is important, watched, or worth
  understanding. State the fact and move on. (Exception: in the BEGINNER version,
  a sentence that explains what a term means or how a mechanism works is not
  filler — keep it.)
- Never use: navigate/navigated, grapple, landscape, cross-currents, amid,
  underscore, "highlights" as a verb, "it is worth noting", "plays a key/crucial/
  pivotal role", "in an effort to", "signals a shift", "remains to be seen", "a
  mixed picture", "paints a picture", "poised to", "set to".
- No stacked hedges ("could potentially perhaps"). No emoji, no exclamation
  marks, no rhetorical questions. British English.
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

// Like plain(), but keeps the one <span class='term' …> glossary tag and drops
// everything else — for fields index.html renders as HTML.
function keepSpans(v) {
  if (typeof v === 'string') {
    return v
      .replace(/<(?!\/?span\b)[^>]+>/gi, '')
      .replace(/<span\b(?![^>]*class=['"]term['"])[^>]*>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keepSpans(x)]));
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

    // One country failing (bad JSON the retries couldn't save) shouldn't sink
    // the whole run — skip it and keep the rest. Its last good briefing stays.
    let result;
    try {
      result = await askForJson(system, user, { maxTokens: 24000 });
    } catch (err) {
      console.log(`  ! skipping ${batch.join(' ')} — ${err.message.split('\n')[0]}`);
      continue;
    }

    for (const iso3 of batch) {
      const raw = result.briefings?.[iso3];
      if (!raw) { console.log(`  ! no output for ${iso3}`); continue; }
      briefings[COUNTRIES[iso3].name] = shapeCountry(iso3, raw);
    }
  }

  if (!Object.keys(briefings).length) {
    throw new Error('every briefing batch failed — not writing an empty file');
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

You are writing the summary of the day.

- "headline": name the ONE biggest concrete event of the day in plain words —
  who did what. Good: "The Bank of Japan raised rates as the Fed held and the
  pound fell to a two-week low." Bad (a theme, a noun-list): "Global markets
  reacted to shifting rate expectations and central bank operations." If several
  things matter, pick the biggest and name it; mention one other at most.
- "lede": the main briefing. First sentence: the single thing that mattered
  most, stated flat. Then the mechanism, then the knock-on. Follow the three
  reader levels from the VOICE rules — the "b" version explains what each term
  means as it appears and can run a little longer; "a" is dense and assumes
  everything. No scene-setting first sentence, no significance sentence at the
  end.
- "items": three or four, each ONE line, tied to one country.
- "thread": two or three sentences on what actually connects the items — or say
  the day was quiet. Do not force a narrative.

OUTPUT SHAPE
{"headline": "one plain sentence",
 "lede": {"b": "paragraph", "i": "paragraph", "a": "paragraph"},
 "items": [{"country": "<exact country name as given>", "b": "one line", "i": "one line", "a": "one line"}],
 "thread": {"b": "...", "i": "...", "a": "..."}}`;

  const user = Object.entries(briefings)
    .map(([name, c]) => `COUNTRY: ${name}\nSUB: ${c.sub}\nSTORIES:\n${c.stories.map((s) => `- ${s.t}: ${s.i}`).join('\n')}`)
    .join('\n\n');

  const raw = await askForJson(system, user, { maxTokens: 24000 });

  return {
    date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    headline: plain(raw.headline) || '',
    // lede keeps its glossary <span>s — index.html renders it as HTML and wires
    // up the definition boxes, same as a country story body.
    lede: keepSpans(raw.lede) || { b: '', i: '', a: '' },
    items: (raw.items || [])
      .filter((it) => briefings[it.country])
      .map((it) => ({ c: it.country, b: plain(it.b), i: plain(it.i || it.b), a: plain(it.a || it.i || it.b) })),
    thread: plain(raw.thread) || { b: '', i: '', a: '' },
  };
}

// ---------------------------------------------------------------------------
// 3. The quiz — one call per level, run weekly.
//    Eighteen questions per level; the site serves a deterministic daily fifteen.
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
7. Write EIGHTEEN questions, spread across as many different countries and
   themes as the briefings allow. No two questions on the same fact.

OUTPUT SHAPE
{"questions": [{
  "tag": "United Kingdom · Fixed income",
  "q": "...",
  "o": ["correct", "wrong", "wrong", "wrong"],
  "a": 0,
  "e": "..."
}]}`;

    // One level failing (e.g. a sustained AI outage) shouldn't lose the other
    // two — skip it and carry on.
    let raw;
    try {
      raw = await askForJson(system, `BRIEFINGS\n\n${context}`, { maxTokens: 24000 });
    } catch (err) {
      console.log(`  ! skipping ${label.toLowerCase()} quiz — ${err.message.split('\n')[0]}`);
      continue;
    }

    for (const q of raw.questions || []) {
      if (!q.q || !Array.isArray(q.o) || q.o.length !== 4 || !q.e) continue;
      questions.push({ lvl: key, tag: q.tag || '', q: q.q, o: q.o, a: 0, e: q.e });
    }
  }

  return questions;
}

module.exports = { buildBriefings, buildDigest, buildQuiz, GLOSSARY_KEYS };
