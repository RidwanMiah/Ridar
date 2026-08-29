# Ridar

Commercial awareness briefings on an interactive globe. Ten markets, explained at
three levels, with a daily quiz. Summaries are written by AI from public RSS
feeds and always link back to the source.

Running cost: **£0**, apart from a domain if you want one.

---

## What's in here

| File | What it does |
|---|---|
| `index.html` | The website. Opens in a browser on its own. |
| `handoff.html` | The build spec: architecture, schema, prompts, licensing. |
| `feeds.js` | The feed list and the keyword tagging that assigns stories to countries and themes. |
| `fetch-news.js` | Fetches and tags the news. Run it alone to see the raw material. |
| `ai.js` | One function that talks to Gemini, Groq or Anthropic. Swap providers with an env var. |
| `summarise.js` | The prompts. Turns tagged stories into three-level briefings, a digest and a quiz. |
| `run.js` | The daily job: fetch → detect change → summarise → write `data/`. |
| `.github/workflows/daily.yml` | Runs `run.js` every morning and commits the result. |
| `data/` | Generated. `briefings.json`, `quiz.json`, `state.json`. |

---

## Setup, in order

### 1. Install

```bash
npm install
```

Node 18 or newer. `rss-parser` is the only dependency.

### 2. See the news arriving

```bash
node fetch-news.js          # last 24h, grouped by source, with country tags
node fetch-news.js 48 GBR   # last 48h, UK-tagged stories only
```

No API key needed. If a feed fails it says so at the bottom — publishers change
URLs, and fixing one is a one-line edit in `feeds.js`.

### 3. Get a free AI key

Either works, both have free tiers well above what this needs (about five calls
a day):

- **Google AI Studio** → create a key → `AI_PROVIDER=gemini`
- **Groq Console** → create a key → `AI_PROVIDER=groq`

Put them in a `.env` file next to `package.json`:

```
AI_PROVIDER=gemini
AI_API_KEY=your-key-here
```

Never commit `.env`. Add it to `.gitignore`.

### 4. Test the prompts on one country

```bash
node --env-file=.env run.js --only GBR --force
```

Then open `data/briefings.json` and **read the output at all three levels**. This
is the step that tells you whether the product works. Expect to spend an evening
adjusting `HOUSE_RULES` in `summarise.js` — that string is the whole editorial
voice of the site.

### 5. Run the real thing

```bash
node --env-file=.env run.js
```

Then open `index.html`. The header badge changes from "Sample data" to "Updated
just now".

> Browsers block `fetch` on `file://` URLs, so opening the file directly will
> still show sample content. Serve it locally instead:
> `npx serve .` or `python3 -m http.server`

### 6. Automate it

Push to GitHub, then in the repo settings:

- **Settings → Secrets and variables → Actions → Secrets**: add `AI_API_KEY`
- **Variables**: add `AI_PROVIDER` (`gemini` or `groq`)

The workflow runs at 06:10 UTC daily and commits the new JSON. Trigger it by hand
first from the **Actions** tab to check it works.

### 7. Deploy

Cloudflare Pages, Netlify or GitHub Pages, pointed at the repo. It's a static
site — no build step, no server. Free.

---

## How it stays free

| Lever | Saving |
|---|---|
| Countries batched three per AI call | 10 calls → 4 |
| Quiz generated weekly, not daily | 21 calls/week → 3 |
| Headline hashing: unchanged country, no call | 30–60% on quiet days |
| Headlines and feed summaries only, never article text | smaller inputs, and stays inside copyright |
| Everything stored as JSON in the repo | no database |

About five AI calls a day, which sits inside a free tier indefinitely. If you
move to a paid provider, switch the cron in `daily.yml` to weekly
(`'10 6 * * 1'`) — roughly £5 a year on a cheap model.

**Deliberately not included:** live market data. Free tiers are fiddly and the
indicator strip is the least important thing on the panel, so briefings ship with
`ind: []` and the strip hides itself. Add a provider later if you want it.

---

## Things you'll hit

**A country has no briefing.** Fewer than two tagged stories in 24 hours, so it
was skipped — better than a briefing invented from one headline. Add keywords in
`feeds.js` or add a primary feed for that country.

**A story is tagged wrong.** Keyword matching is roughly 80% accurate. Add or
remove terms in `KEYWORDS`. That's the entire maintenance burden.

**The model returned bad JSON.** `ai.js` strips code fences and retries on the
outermost braces. If it still fails, the run exits and `data/` is left untouched,
so the site keeps showing the last good day.

**Country names.** Keys in `briefings.json` must match the country names in the
world-atlas TopoJSON exactly — "United States of America", not "United States".
`feeds.js` holds the mapping.

---

## Before showing it to anyone

Two lines belong on the site, and they're in `index.html` already — keep them:

- summaries are AI-written from named public sources, and readers should follow
  the links for the reporting itself
- this is education, not investment advice

Article text from the FT, Bloomberg and other publishers is licensed. Ridar reads
headlines and feed summaries, works primarily from central bank and government
releases, writes its own sentences, and links out. Stay on that side of the line.
