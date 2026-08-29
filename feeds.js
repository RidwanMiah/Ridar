/**
 * feeds.js — where the news comes from, and how stories get tagged.
 *
 * Two kinds of source:
 *  - GENERAL feeds (FT, BBC, Guardian…) cover everything. Stories from
 *    these get tagged by keyword.
 *  - PRIMARY feeds (central banks, statistics agencies) belong to one
 *    country by definition, so they carry an `iso3` and skip tagging.
 *
 * Everything here is free and public. No API keys, no news licence.
 */

// ---------------------------------------------------------------------------
// The ten markets Ridar briefs. The `name` MUST match the country name in
// the world-atlas TopoJSON, because that is what the globe clicks on.
// ---------------------------------------------------------------------------
const COUNTRIES = {
  USA: { name: 'United States of America', label: 'United States' },
  GBR: { name: 'United Kingdom',           label: 'United Kingdom' },
  DEU: { name: 'Germany',                  label: 'Germany' },
  JPN: { name: 'Japan',                    label: 'Japan' },
  CHN: { name: 'China',                    label: 'China' },
  IND: { name: 'India',                    label: 'India' },
  BRA: { name: 'Brazil',                   label: 'Brazil' },
  SAU: { name: 'Saudi Arabia',             label: 'Saudi Arabia' },
  NGA: { name: 'Nigeria',                  label: 'Nigeria' },
  AUS: { name: 'Australia',                label: 'Australia' },
};

// ---------------------------------------------------------------------------
// General feeds. Broad coverage, tagged by keyword after fetching.
// ---------------------------------------------------------------------------
const GENERAL_FEEDS = [
  { source: 'Financial Times',   url: 'https://www.ft.com/rss/home' },
  { source: 'BBC Business',      url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { source: 'Guardian Business', url: 'https://www.theguardian.com/uk/business/rss' },
  { source: 'CNBC',              url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { source: 'MarketWatch',       url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
];

// ---------------------------------------------------------------------------
// Primary feeds. These are the authoritative ones — a rate decision from the
// Bank of England is a fact, not a report of a fact. They also arrive
// pre-tagged, which makes them the most valuable stories in the pipeline.
// ---------------------------------------------------------------------------
const PRIMARY_FEEDS = [
  { source: 'Bank of England',   iso3: 'GBR', url: 'https://www.bankofengland.co.uk/rss/news' },
  { source: 'UK Government',     iso3: 'GBR', url: 'https://www.gov.uk/search/news-and-communications.atom?organisations%5B%5D=hm-treasury' },
  { source: 'Federal Reserve',   iso3: 'USA', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml' },
  { source: 'European Central Bank', iso3: 'DEU', url: 'https://www.ecb.europa.eu/rss/press.html' },
  { source: 'Bank of Japan',     iso3: 'JPN', url: 'https://www.boj.or.jp/en/rss/whatsnew.xml' },
  { source: 'Reserve Bank of India', iso3: 'IND', url: 'https://www.rbi.org.in/pressreleases_rss.xml' },
  { source: 'Reserve Bank of Australia', iso3: 'AUS', url: 'https://www.rba.gov.au/rss/rss-cb-media-releases.xml' },
  // Dropped: US Treasury (serves malformed XML / times out) and the IMF feed
  // (hard 403 to non-browser clients). USA is covered by the Fed feed plus the
  // general feeds; IMF stories still arrive via the 'imf' topic keyword. If
  // either publisher fixes their feed, add the line back here.
];

const FEEDS = [...PRIMARY_FEEDS, ...GENERAL_FEEDS];

// ---------------------------------------------------------------------------
// Keyword tagging.
//
// Crude on purpose. A story is tagged with a country if its headline or
// summary mentions one of that country's terms. Roughly 80% accurate, which
// is enough — the AI step sees the sources and ignores anything irrelevant.
//
// Order matters slightly: more specific terms first avoids "China" matching
// "South China Sea shipping" for the wrong reason. Add terms as you spot
// misses; that is the whole maintenance burden.
// ---------------------------------------------------------------------------
const KEYWORDS = {
  USA: ['federal reserve', 'the fed', 'fomc', 'wall street', 'treasury yield', 'treasuries',
        's&p 500', 'nasdaq', 'dow jones', 'washington', 'united states', 'u.s.', 'us economy',
        'american', 'powell', 'white house'],
  GBR: ['bank of england', 'bank rate', 'gilt', 'gilts', 'ftse', 'sterling', 'the pound',
        'chancellor', 'hm treasury', 'obr', 'westminster', 'uk economy', 'britain', 'british',
        'downing street', 'budget'],
  DEU: ['germany', 'german', 'bundesbank', 'dax', 'bund', 'bunds', 'berlin', 'debt brake',
        'european central bank', 'ecb', 'euro area', 'eurozone', 'lagarde'],
  JPN: ['japan', 'japanese', 'bank of japan', 'boj', 'yen', 'nikkei', 'tokyo', 'jgb',
        'shunto', 'ueda'],
  CHN: ['china', 'chinese', 'beijing', 'pboc', 'yuan', 'renminbi', 'csi 300', 'hang seng',
        'shanghai', 'evergrande', 'loan prime rate'],
  IND: ['india', 'indian', 'reserve bank of india', 'rbi', 'rupee', 'nifty', 'sensex',
        'mumbai', 'new delhi', 'modi'],
  BRA: ['brazil', 'brazilian', 'selic', 'ibovespa', 'real ', 'copom', 'brasilia', 'lula',
        'petrobras'],
  SAU: ['saudi', 'opec', 'aramco', 'riyadh', 'brent crude', 'vision 2030', 'pif',
        'crude output'],
  NGA: ['nigeria', 'nigerian', 'naira', 'abuja', 'lagos', 'central bank of nigeria'],
  AUS: ['australia', 'australian', 'reserve bank of australia', 'rba', 'asx', 'aussie dollar',
        'iron ore', 'canberra', 'sydney'],
};

// ---------------------------------------------------------------------------
// The six cross-cutting themes, tagged the same way. A story can belong to
// several — "OPEC extends cuts" is energy and, arguably, trade.
// ---------------------------------------------------------------------------
const TOPIC_KEYWORDS = {
  rates:  ['interest rate', 'rate cut', 'rate rise', 'rate hike', 'central bank', 'policy rate',
           'inflation', 'cpi', 'monetary policy', 'yield curve', 'bond yield', 'basis points'],
  trade:  ['tariff', 'tariffs', 'trade war', 'export', 'import', 'supply chain', 'wto',
           'trade deficit', 'trade surplus', 'sanction'],
  energy: ['oil', 'crude', 'brent', 'opec', 'natural gas', 'lng', 'electricity', 'power grid',
           'copper', 'iron ore', 'commodity', 'commodities', 'renewable'],
  fiscal: ['budget', 'deficit', 'government borrowing', 'fiscal', 'debt', 'bond sale',
           'issuance', 'tax', 'spending review', 'sovereign'],
  tech:   ['ai', 'artificial intelligence', 'semiconductor', 'chip', 'chips', 'data centre',
           'data center', 'cloud', 'nvidia', 'hyperscaler', 'software'],
  em:     ['emerging market', 'emerging markets', 'imf', 'devaluation', 'currency reform',
           'subsidy', 'capital flows', 'default', 'reform programme'],
};

/**
 * Tag one story. Returns { iso3s: [...], topics: [...] }.
 * Primary-feed stories already know their country, so we trust that and only
 * look for extra mentions.
 */
function tag(story) {
  const haystack = `${story.headline} ${story.summary}`.toLowerCase();

  const iso3s = new Set();
  if (story.iso3) iso3s.add(story.iso3);
  for (const [iso3, words] of Object.entries(KEYWORDS)) {
    if (words.some((w) => haystack.includes(w))) iso3s.add(iso3);
  }

  const topics = Object.entries(TOPIC_KEYWORDS)
    .filter(([, words]) => words.some((w) => haystack.includes(w)))
    .map(([slug]) => slug);

  return { iso3s: [...iso3s], topics };
}

module.exports = { COUNTRIES, FEEDS, GENERAL_FEEDS, PRIMARY_FEEDS, KEYWORDS, TOPIC_KEYWORDS, tag };
