/**
 * ai.js — one function that talks to whichever AI provider you're using.
 *
 * Ridar is built to run on a FREE tier. Google's Gemini Flash and Groq both
 * give away more daily requests than this pipeline needs (about 5 calls a
 * day). Anthropic is included because it writes the best summaries, but it
 * is pay-as-you-go — see the note at the bottom.
 *
 * Configure with two environment variables:
 *   AI_PROVIDER = gemini | groq | anthropic     (default: gemini)
 *   AI_API_KEY  = your key
 * Optionally:
 *   AI_MODEL    = override the default model name
 *
 * Node 18+ has fetch built in, so there is no SDK to install.
 */

const PROVIDER = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const API_KEY = process.env.AI_API_KEY || '';

// Default models: the cheapest capable option for each provider. If a name
// stops working, the provider renamed it — set AI_MODEL to the current one.
const DEFAULT_MODELS = {
  gemini: 'gemini-flash-lite-latest',
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-3-5-haiku-latest',
};
const MODEL = process.env.AI_MODEL || DEFAULT_MODELS[PROVIDER];

/**
 * Ask the model for JSON and return it parsed.
 *
 * @param {string} system  the instructions (who the model is, the rules)
 * @param {string} user    the input (today's sources)
 * @returns {Promise<object>}
 */
async function askForJson(system, user, { maxTokens = 8000, temperature = 0.3 } = {}) {
  if (!API_KEY) {
    throw new Error('No AI_API_KEY set. Export it, or put it in a .env and use --env-file=.env');
  }

  const text = await callProvider(system, user, { maxTokens, temperature });
  return parseJson(text);
}

async function callProvider(system, user, opts) {
  if (PROVIDER === 'gemini') return callGemini(system, user, opts);
  if (PROVIDER === 'groq') return callGroq(system, user, opts);
  if (PROVIDER === 'anthropic') return callAnthropic(system, user, opts);
  throw new Error(`Unknown AI_PROVIDER "${PROVIDER}". Use gemini, groq or anthropic.`);
}

// --- Google Gemini (free tier) ---------------------------------------------
async function callGemini(system, user, { maxTokens, temperature }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      // Asking for JSON as the response type is what keeps the output clean.
      generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: maxTokens },
    }),
  });
  const data = await readJson(response, 'Gemini');
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
}

// --- Groq (free tier, OpenAI-compatible) -----------------------------------
async function callGroq(system, user, { maxTokens, temperature }) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      temperature,
      max_tokens: maxTokens,
    }),
  });
  const data = await readJson(response, 'Groq');
  return data.choices?.[0]?.message?.content || '';
}

// --- Anthropic (pay as you go) ---------------------------------------------
async function callAnthropic(system, user, { maxTokens, temperature }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await readJson(response, 'Anthropic');
  return data.content?.map((c) => c.text || '').join('') || '';
}

// --- shared plumbing -------------------------------------------------------

async function readJson(response, label) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned something that wasn't JSON: ${body.slice(0, 200)}`);
  }
}

/**
 * Pull the first balanced {...} object out of a string, honouring quotes and
 * escapes. Small models sometimes trail junk after the JSON (repeated braces,
 * a second copy, a stray sentence); lastIndexOf('}') would swallow it.
 */
function firstJsonObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * Models sometimes wrap JSON in ```json fences, add a sentence before it, or
 * trail junk after it. Try progressively more forgiving extractions.
 */
function parseJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  const candidates = [cleaned, firstJsonObject(cleaned)];

  // Weaker models sometimes emit the <span class='term' …> markup with literal
  // double quotes, which breaks the surrounding JSON string. Re-quote any tag
  // attributes with single quotes, then re-extract.
  const requoted = cleaned.replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(/"/g, "'"));
  candidates.push(requoted, firstJsonObject(requoted));

  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* try next */ }
  }

  throw new Error(`Could not parse the model's JSON. First 300 chars:\n${cleaned.slice(0, 300)}`);
}

module.exports = { askForJson, PROVIDER, MODEL };

/**
 * COST NOTE
 *
 * This pipeline makes about 4–6 calls per run: three or four batched country
 * calls, one digest, and one quiz call per week.
 *
 * On a free tier (gemini / groq) that is £0. The limits are per-minute and
 * per-day request caps, which a once-daily batch never approaches.
 *
 * On Anthropic Haiku it is roughly 50k input and 20k output tokens a day,
 * which comes to a few pence a day — around £35 a year if you run it daily.
 * If you want Anthropic quality inside a £5 budget, set the schedule to
 * weekly in .github/workflows/daily.yml.
 */
