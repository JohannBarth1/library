const { onRequest } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

function esc(s) {
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

function renderPreview({ hostname, bookId, title, description, image, redirectUrl }) {
  const t = esc(title);
  const d = esc(description);
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
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta property="og:url" content="https://${esc(hostname)}/book/${esc(bookId)}">
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}
<meta http-equiv="refresh" content="0; url=${esc(redirectUrl)}">
<script>location.replace(${JSON.stringify(redirectUrl)});</script>
</head><body>
<p>Opening &ldquo;${t}&rdquo; in eLibrary&hellip; <a href="${esc(redirectUrl)}">Tap here if you're not redirected.</a></p>
</body></html>`;
}

// /book/:bookId — a real visitor gets bounced straight into the signed-in
// app (same as before this existed); a link-preview crawler (WhatsApp,
// iMessage, Slack, Facebook, etc.) reads the OG tags on this page directly,
// since none of them run the redirect JS or follow the meta-refresh.
//
// Only `public`/`restricted` books get their real title/cover in the
// preview — the Admin SDK here bypasses Firestore rules entirely, so a
// `private` book intentionally gets a generic, non-revealing preview
// instead of exposing its details to anyone who ends up with the link.
exports.bookShare = onRequest({ region: 'us-central1', cors: false }, async (req, res) => {
  const bookId = (req.path.match(/^\/?book\/([^/?]+)/) || [])[1] || '';
  const hostname = req.hostname;
  const appRoot = `https://${hostname}/`;
  const redirectUrl = bookId ? `${appRoot}#book=${encodeURIComponent(bookId)}` : appRoot;

  let book = null;
  if (bookId) {
    try {
      const snap = await db.collection('books').doc(bookId).get();
      if (snap.exists) book = snap.data();
    } catch (e) {
      console.error('bookShare lookup failed', e);
    }
  }

  res.set('Cache-Control', 'public, max-age=300, s-maxage=600');

  if (!book) {
    // Deleted / bad id — nothing to preview, just send them into the app.
    res.status(200).send(renderPreview({
      hostname, bookId,
      title: 'eLibrary', description: 'Open this book in eLibrary.',
      image: '', redirectUrl,
    }));
    return;
  }

  const isShareable = book.visibility === 'public' || book.visibility === 'restricted';
  if (!isShareable) {
    res.status(200).send(renderPreview({
      hostname, bookId,
      title: 'A private book on eLibrary',
      description: 'Sign in to eLibrary to view this item.',
      image: '', redirectUrl,
    }));
    return;
  }

  const title = book.title || 'A book on eLibrary';
  const author = book.author ? String(book.author) : '';
  const description = plainText(book.description, 200) || (author ? `By ${author}` : 'Shared from eLibrary');

  res.status(200).send(renderPreview({
    hostname, bookId, title, description,
    image: book.coverUrl || '', redirectUrl,
  }));
});
