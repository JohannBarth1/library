/**
 * importRecipeFromUrl — callable Cloud Function for eLibrary/eRecipe.
 *
 * Takes a public recipe URL, fetches the page server-side (the browser can't:
 * CORS), reduces it to something small and clean, and asks Claude to return a
 * recipe in exactly the shape eRecipe's data model uses:
 *
 *   { title, desc, ingredients[], steps[], tip, chapterName, language, coverUrl }
 *
 * Nothing is written to Firestore here — the client drops the result into the
 * existing recipe editor so the user reviews and saves it through the normal
 * saveRecipeFromEditor() path (which is what registers new categories).
 */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Change this one line to move to a different model.
const MODEL = 'claude-sonnet-5';

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_TEXT_CHARS = 18000;

// ── URL safety ───────────────────────────────────────────────────────────────
// Only public http(s). Blocks the obvious SSRF targets so this function can't
// be used as a proxy into private networks or cloud metadata endpoints.
function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpsError('invalid-argument', 'That doesn\'t look like a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpsError('invalid-argument', 'Only http:// and https:// links are supported.');
  }
  const h = u.hostname.toLowerCase();
  const blocked =
    h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal') ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h);
  if (blocked) throw new HttpsError('invalid-argument', 'That address isn\'t publicly reachable.');
  return u;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // Plenty of recipe sites serve a stub or a 403 to an unknown agent.
        'User-Agent': 'Mozilla/5.0 (compatible; eRecipeImporter/1.0; +https://johannbarth1.github.io)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new HttpsError('deadline-exceeded', 'That site took too long to respond.');
    throw new HttpsError('unavailable', 'Could not reach that page.');
  }
  clearTimeout(timer);

  if (!res.ok) throw new HttpsError('unavailable', `That page returned HTTP ${res.status}.`);
  const ctype = res.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(ctype)) {
    throw new HttpsError('invalid-argument', 'That link isn\'t a web page.');
  }
  const html = await res.text();
  if (html.length > MAX_HTML_BYTES) throw new HttpsError('invalid-argument', 'That page is too large to import.');
  return html;
}

// ── Structured data ──────────────────────────────────────────────────────────
// Most recipe sites publish schema.org/Recipe as JSON-LD. When it's there it's
// far cleaner (and far cheaper) to hand Claude that than the whole page.
function extractRecipeJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const t = node['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (types.some(x => typeof x === 'string' && x.toLowerCase() === 'recipe')) found.push(node);
    if (node['@graph']) walk(node['@graph']);
  };
  for (const b of blocks) {
    try { walk(JSON.parse(b[1].trim())); } catch { /* malformed block — skip it */ }
  }
  return found[0] || null;
}

function metaContent(html, patterns) {
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function extractCoverUrl(html, jsonLd, baseUrl) {
  let img = '';
  const j = jsonLd && jsonLd.image;
  if (typeof j === 'string') img = j;
  else if (Array.isArray(j)) img = typeof j[0] === 'string' ? j[0] : (j[0] && j[0].url) || '';
  else if (j && typeof j === 'object') img = j.url || '';
  if (!img) {
    img = metaContent(html, [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]);
  }
  if (!img) return null;
  try { return new URL(img, baseUrl.href).href; } catch { return null; }
}

// Crude but effective readability pass for pages with no JSON-LD.
function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

// ── Claude ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You convert web recipes into a strict JSON record for a personal recipe app.

Respond with a single JSON object and NOTHING else — no prose, no markdown fences.

Schema:
{
  "title": string,
  "desc": string,
  "ingredients": string[],
  "steps": string[],
  "tip": string,
  "chapterName": string,
  "language": string,
  "servings": string,
  "notFound": boolean
}

Rules:
- "ingredients": one per line, quantity first, in the page's original units. Keep the author's wording; don't convert or round. A group heading becomes its own entry ending in a colon, e.g. "For the topping:".
- "steps": one instruction per entry, in order, as full sentences with no leading numbering. A stage heading becomes its own entry ending in a colon, e.g. "To assemble:".
- "desc": one or two sentences. If the page has no real description, write a short neutral one from the recipe itself. Never copy long passages of the page's prose — always write it in your own words.
- "tip": any make-ahead, storage, or substitution advice, in your own words, condensed to a sentence or two. Empty string if there is none.
- "chapterName": a single broad category, title case. Prefer one of: Breakfast, Starters, Soups, Salads, Mains, Sides, Baking, Cakes, Desserts, Sauces, Drinks, Preserves, Snacks. Use another single word only if none of those fit.
- "language": ISO code of the recipe's language, e.g. "en".
- "servings": as stated on the page, e.g. "Serves 4". Empty string if absent.
- Never invent ingredients, quantities, or steps that aren't supported by the page.
- If the page is not a recipe, set "notFound": true and leave the other fields empty.`;

async function callClaude(apiKey, userContent) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch {
    throw new HttpsError('unavailable', 'Could not reach the AI service.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Anthropic API error', res.status, body.slice(0, 500));
    if (res.status === 401) throw new HttpsError('failed-precondition', 'The AI API key is missing or invalid.');
    if (res.status === 429) throw new HttpsError('resource-exhausted', 'AI rate limit hit — try again in a moment.');
    throw new HttpsError('internal', 'The AI service returned an error.');
  }

  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: pull the outermost object out of any stray wrapper text.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    console.error('Unparseable model output:', cleaned.slice(0, 500));
    throw new HttpsError('internal', 'The AI response could not be read.');
  }
}

// ── Normalisation ────────────────────────────────────────────────────────────
const strArray = v => (Array.isArray(v) ? v : [])
  .map(x => (typeof x === 'string' ? x : (x && (x.text || x.name)) || ''))
  .map(s => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
  .slice(0, 200);

exports.importRecipeFromUrl = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: 'us-central1', cors: true, timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in first.');

    const raw = (request.data && request.data.url || '').toString().trim();
    if (!raw) throw new HttpsError('invalid-argument', 'No link was provided.');

    const url = assertSafeUrl(raw);
    const html = await fetchPage(url);
    const jsonLd = extractRecipeJsonLd(html);
    const coverUrl = extractCoverUrl(html, jsonLd, url);

    // Feed Claude the structured data when the site publishes it, and the
    // readable page text otherwise. Same prompt either way.
    let userContent;
    if (jsonLd) {
      userContent = `Source: ${url.href}\n\nThis page publishes schema.org Recipe data:\n\n${JSON.stringify(jsonLd).slice(0, MAX_TEXT_CHARS)}`;
    } else {
      const text = htmlToText(html);
      if (text.length < 200) throw new HttpsError('invalid-argument', 'There was no readable content on that page.');
      const pageTitle = metaContent(html, [/<title[^>]*>([^<]+)<\/title>/i]);
      userContent = `Source: ${url.href}\nPage title: ${pageTitle}\n\nPage text:\n\n${text}`;
    }

    const out = await callClaude(ANTHROPIC_API_KEY.value(), userContent);

    if (out.notFound) throw new HttpsError('not-found', 'That page doesn\'t appear to contain a recipe.');

    const ingredients = strArray(out.ingredients);
    const steps = strArray(out.steps);
    if (!ingredients.length || !steps.length) {
      throw new HttpsError('not-found', 'No ingredients or method could be read from that page.');
    }

    // Provenance goes in desc because the app's recipe model has no source
    // field — keeps the credit visible without a schema change.
    const desc = [
      (out.desc || '').toString().trim(),
      (out.servings || '').toString().trim(),
      `Source: ${url.hostname.replace(/^www\./, '')}`,
    ].filter(Boolean).join('\n\n');

    return {
      title: (out.title || '').toString().trim().slice(0, 200) || 'Imported Recipe',
      desc,
      ingredients,
      steps,
      tip: (out.tip || '').toString().trim(),
      chapterName: (out.chapterName || '').toString().trim() || 'Uncategorised',
      language: (out.language || '').toString().trim().slice(0, 10),
      coverUrl,
      sourceUrl: url.href,
    };
  }
);
/**
 * bookShare — /book/:bookId, reached via a Hosting rewrite.
 *
 * A real visitor gets bounced straight into the signed-in app (same as
 * clicking a normal in-app book link). A link-preview crawler (WhatsApp,
 * iMessage, Slack, Facebook, etc.) never runs that redirect or follows the
 * meta-refresh — it just reads the og: and twitter: meta tags on this page
 * directly, which is what puts the cover image in the shared-link preview.
 *
 * Only `public`/`restricted` books get their real title/cover in the
 * preview. This function reads Firestore with the Admin SDK, which bypasses
 * security rules entirely, so a `private` book intentionally gets a
 * generic, non-revealing preview instead of leaking its details to anyone
 * who ends up with the link.
 */

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Strips HTML and trims to a preview-friendly length so a rich-text
// description doesn't leak markup into the meta description tag.
function plainText(s, maxLen) {
  const t = String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1).trimEnd() + '…' : t;
}

function renderBookPreview({ hostname, bookId, title, description, image, redirectUrl }) {
  const t = escHtml(title);
  const d = escHtml(description);
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${t}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${d}">
<meta property="og:type" content="book">
<meta property="og:site_name" content="eLibrary">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
${image ? `<meta property="og:image" content="${escHtml(image)}">
<meta property="og:image:alt" content="${t}">` : ''}
<meta property="og:url" content="https://${escHtml(hostname)}/book/${escHtml(bookId)}">
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${image ? `<meta name="twitter:image" content="${escHtml(image)}">` : ''}
<meta http-equiv="refresh" content="0; url=${escHtml(redirectUrl)}">
<script>location.replace(${JSON.stringify(redirectUrl)});</script>
</head><body>
<p>Opening &ldquo;${t}&rdquo; in eLibrary&hellip; <a href="${escHtml(redirectUrl)}">Tap here if you're not redirected.</a></p>
</body></html>`;
}

// One handler behind three Hosting rewrites (`/book/**`, `/recipe/**`,
// `/audio/**`), all pointing at this same function — books, recipes, and
// audio each live in their own Firestore collection (books / recipes /
// audioFiles respectively), and recipes use `desc` where the other two use
// `description`. `kind` also becomes the hash the client-side app opens
// (`#book=`, `#recipe=`, `#audio=`), matching how each type is opened
// in-app elsewhere in the client.
const SHARE_KINDS = {
  book:   { collection: 'books',      noun: 'book',      descField: 'description' },
  recipe: { collection: 'recipes',    noun: 'recipe',     descField: 'desc' },
  audio:  { collection: 'audioFiles', noun: 'audiobook',  descField: 'description' },
};

exports.bookShare = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  const match = req.path.match(/^\/?(book|recipe|audio)\/([^/?]+)/);
  const kind = match ? match[1] : 'book';
  const itemId = match ? match[2] : '';
  const { collection, noun, descField } = SHARE_KINDS[kind];

  // Behind a Hosting rewrite the original host arrives in X-Forwarded-Host;
  // prefer it so og:url and the redirect always use the public domain.
  const hostname = String(req.headers['x-forwarded-host'] || req.hostname || '').split(',')[0].trim();
  const appRoot = `https://${hostname}/`;
  const redirectUrl = itemId ? `${appRoot}#${kind}=${encodeURIComponent(itemId)}` : appRoot;

  let item = null;
  if (itemId) {
    try {
      const snap = await db.collection(collection).doc(itemId).get();
      if (snap.exists) item = snap.data();
    } catch (e) {
      console.error('bookShare lookup failed', e);
    }
  }

  res.set('Cache-Control', 'public, max-age=300, s-maxage=600');

  if (!item) {
    // Deleted / bad id — nothing to preview, just send them into the app.
    res.status(200).send(renderBookPreview({
      hostname, bookId: itemId,
      title: 'eLibrary', description: `Open this ${noun} in eLibrary.`,
      image: '', redirectUrl,
    }));
    return;
  }

  const isShareable = item.visibility === 'public' || item.visibility === 'restricted';
  if (!isShareable) {
    res.status(200).send(renderBookPreview({
      hostname, bookId: itemId,
      title: `A private ${noun} on eLibrary`,
      description: 'Sign in to eLibrary to view this item.',
      image: '', redirectUrl,
    }));
    return;
  }

  const title = item.title || `A ${noun} on eLibrary`;
  const author = item.author ? String(item.author) : '';
  const description = plainText(item[descField], 200) || (author ? `By ${author}` : 'Shared from eLibrary');

  res.status(200).send(renderBookPreview({
    hostname, bookId: itemId, title, description,
    image: item.coverUrl || '', redirectUrl,
  }));
});
