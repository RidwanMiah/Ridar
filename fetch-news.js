/**
 * fetch-news.js — Ridar, step 1
 *
 * Pulls headlines from public RSS feeds, keeps the ones published in the last
 * 24 hours, tags each with the countries and themes it mentions, and hands
 * back a clean list.
 *
 * Run on its own to see what the pipeline is working with:
 *   node fetch-news.js            # last 24 hours, grouped by source
 *   node fetch-news.js 48         # last 48 hours
 *   node fetch-news.js 24 GBR     # only stories tagged United Kingdom
 *
 * It is also imported by run.js, which is what the daily job calls.
 */

const Parser = require('rss-parser');
const { FEEDS, COUNTRIES, tag } = require('./feeds');

// ---------------------------------------------------------------------------
// The parser. rss-parser downloads the XML and hands back a JS object. The
// timeout stops one slow feed hanging the run; the User-Agent matters because
// some publishers reject requests that don't send one.
// ---------------------------------------------------------------------------
const parser = new Parser({
  timeout: 15000,
  headers: {
    // Some publishers (RBI, others) reject or 406/418 anything that doesn't
    // look like a browser, so send a full browser-ish header set.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Feed summaries are full of HTML. Strip the tags, decode the entities that
// matter, collapse whitespace, and trim to a sensible length.
function cleanText(html, maxLength = 400) {
  if (!html) return '';
  const text = String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength - 1).trimEnd() + '…' : text;
}

// Feeds disagree about which field holds the timestamp. Try the usual ones.
function readDate(item) {
  const raw = item.isoDate || item.pubDate || item.published || item.updated;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeTime(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Fetch one feed and normalise it into the shape the rest of Ridar uses.
// ---------------------------------------------------------------------------
async function fetchFeed(feed, cutoff) {
  const parsed = await parser.parseURL(feed.url);

  return (parsed.items || [])
    .map((item) => {
      const publishedAt = readDate(item);
      const story = {
        source: feed.source,
        iso3: feed.iso3 || null,
        headline: cleanText(item.title, 220),
        summary: cleanText(item.contentSnippet || item.content || item.summary),
        link: item.link || '',
        publishedAt: publishedAt ? publishedAt.toISOString() : null,
      };
      return story;
    })
    .filter((s) => s.headline && s.link && s.publishedAt && new Date(s.publishedAt) >= cutoff)
    .map((s) => ({ ...s, ...tag(s) }));   // adds iso3s + topics
}

// ---------------------------------------------------------------------------
// Fetch everything in parallel.
//
// Promise.allSettled runs all requests at once and — unlike Promise.all —
// does not abandon the rest when one fails. A dead feed becomes a warning,
// not a crashed script. Publishers change URLs and rate-limit; expect this.
// ---------------------------------------------------------------------------
async function fetchStories({ hours = 24 } = {}) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  const results = await Promise.allSettled(FEEDS.map((f) => fetchFeed(f, cutoff)));

  const stories = [];
  const failures = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') stories.push(...result.value);
    else failures.push({ source: FEEDS[i].source, reason: result.reason?.message || String(result.reason) });
  });

  return { stories: dedupe(stories), failures, cutoff: cutoff.toISOString(), hours };
}

// ---------------------------------------------------------------------------
// Remove duplicates. Wire copy gets syndicated, so the same story appears
// under several publishers. Keying on a normalised headline keeps the first
// copy and drops the rest.
// ---------------------------------------------------------------------------
function dedupe(stories) {
  const seen = new Set();
  return stories.filter((s) => {
    const key = s.headline.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 70);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Group stories by country. Used by the summariser: each country gets the
// stories that mention it, newest first, capped so one AI call stays small.
// ---------------------------------------------------------------------------
function groupByCountry(stories, { maxPerCountry = 12 } = {}) {
  const byCountry = {};
  for (const iso3 of Object.keys(COUNTRIES)) byCountry[iso3] = [];

  for (const story of stories) {
    for (const iso3 of story.iso3s) {
      if (byCountry[iso3]) byCountry[iso3].push(story);
    }
  }

  for (const iso3 of Object.keys(byCountry)) {
    byCountry[iso3].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    // Primary sources first — a central bank release outranks a comment piece.
    byCountry[iso3].sort((a, b) => (b.iso3 ? 1 : 0) - (a.iso3 ? 1 : 0));
    byCountry[iso3] = byCountry[iso3].slice(0, maxPerCountry);
  }

  return byCountry;
}

// ---------------------------------------------------------------------------
// Printing, for when this file is run directly.
// ---------------------------------------------------------------------------
function print({ stories, failures, hours }, filterIso3) {
  const shown = filterIso3 ? stories.filter((s) => s.iso3s.includes(filterIso3)) : stories;

  console.log(`\nRidar — news fetch (last ${hours}h)`);
  console.log(`${shown.length} stories${filterIso3 ? ` tagged ${filterIso3}` : ''}, ${FEEDS.length - failures.length}/${FEEDS.length} feeds responded\n`);

  const bySource = {};
  for (const s of shown) (bySource[s.source] ||= []).push(s);

  for (const source of Object.keys(bySource)) {
    const group = bySource[source].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    console.log('='.repeat(72));
    console.log(`${source.toUpperCase()}  (${group.length})`);
    console.log('='.repeat(72));
    group.forEach((s, i) => {
      console.log(`\n${String(i + 1).padStart(2, '0')}. ${s.headline}`);
      console.log(`    ${relativeTime(s.publishedAt)} · ${s.iso3s.join(' ') || 'untagged'} · ${s.topics.join(' ') || 'no theme'}`);
      if (s.summary) console.log(`    ${s.summary.slice(0, 200)}`);
      console.log(`    ${s.link}`);
    });
    console.log('');
  }

  // A quick tally, so you can see where coverage is thin.
  const counts = {};
  for (const s of stories) for (const iso3 of s.iso3s) counts[iso3] = (counts[iso3] || 0) + 1;
  console.log('Stories per country:');
  Object.keys(COUNTRIES).forEach((iso3) => console.log(`  ${iso3}  ${counts[iso3] || 0}`));

  if (failures.length) {
    console.log('\nFeeds that failed this run:');
    failures.forEach((f) => console.log(`  ${f.source}: ${f.reason}`));
    console.log('A feed failing is normal. Swap the URL in feeds.js if it stays broken.');
  }
  console.log('');
}

module.exports = { fetchStories, groupByCountry, cleanText };

// Only runs when you type `node fetch-news.js` — not when run.js imports it.
if (require.main === module) {
  const hours = Number(process.argv[2]) || 24;
  const filter = process.argv[3] ? process.argv[3].toUpperCase() : null;
  fetchStories({ hours })
    .then((result) => print(result, filter))
    .catch((error) => { console.error('\nStopped:', error.message); process.exit(1); });
}
