// Builds news.json from the BMIT News page on the Scroll site.
//
// Usage:
//   node scripts/build-news.mjs [output-path] [--file local.html]
//
// It reads the News page (current year), takes the newest article headings in
// page order (articles are H3 headings under a year H2 such as "2026"), and
// writes the top items to news.json for latest-news.html to display.
// If the News page has fewer than MAX_ITEMS articles (e.g. early in a new
// year), it continues into News's sub-pages in the order the site menu lists
// them (e.g. 2025, 2024, Older) until it has enough. No years are hard-coded.

import { load } from 'cheerio';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---- Settings you may want to change ---------------------------------------
const NEWS_URL = 'https://bmit.scroll.site/biomedical-imaging-and-therapy-facility/news';
const MAX_ITEMS = 5;
// Heading level used for individual articles on the News page.
// If none are found at this level, the script falls back to H2 headings
// that are not just a year.
const ARTICLE_LEVEL = 'h3';
// Most sub-pages to read after the News page when topping up the list.
const MAX_EXTRA_PAGES = 3;
// -----------------------------------------------------------------------------

const args = process.argv.slice(2);
// --file maps page URLs to local files for testing: --file news=a.html,2025=b.html
const fileIdx = args.indexOf('--file');
const localFiles = fileIdx >= 0
  ? Object.fromEntries(args[fileIdx + 1].split(',').map((p) => p.split('=')))
  : null;
const outPath = args.filter((a, i) => a !== '--file' && i !== fileIdx + 1)[0] || 'news.json';

const normalize = (u) => {
  const x = new URL(u, NEWS_URL);
  x.hash = '';
  x.search = '';
  return x.href.replace(/\/+$/, '');
};

async function getHtml(url) {
  if (localFiles) {
    const key = normalize(url).split('/').pop();
    if (!localFiles[key]) throw new Error(`No test file for ${key}`);
    return readFile(localFiles[key], 'utf8');
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BMIT-latest-news-builder (GitHub Actions)', Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

// Finds News's sub-pages from the site menu: the links nested under the menu
// entry that points at the News page, in menu order.
function subPages($) {
  const news = normalize(NEWS_URL);
  const found = [];
  $('a[href]').each((_, a) => {
    if (found.length) return;
    let href;
    try { href = normalize($(a).attr('href')); } catch { return; }
    if (href !== news) return;
    const li = $(a).closest('li');
    if (!li.length) return;
    li.find('ul a[href], ol a[href]').each((__, child) => {
      try {
        const u = normalize($(child).attr('href'));
        if (u !== news && u.startsWith(new URL(news).origin) && !found.includes(u)) found.push(u);
      } catch { /* ignore bad links */ }
    });
  });
  return found;
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// Scroll Sites builds heading anchors by replacing spaces with hyphens.
const slug = (s) => clean(s).replace(/ /g, '-');

function pickRoot($) {
  for (const sel of ['#content', 'main', 'article', 'body']) {
    const el = $(sel).first();
    if (el.length && el.find('h2, h3').length) return el;
  }
  return $('body');
}

function headingInfo($, el, pageUrl) {
  const $h = $(el);
  const title = clean($h.text());
  const id =
    $h.attr('id') ||
    $h.find('[id]').first().attr('id') ||
    $h.prev('[id]:empty, a[id]').attr('id') ||
    slug(title);

  // Look through the content after this heading, up to the next heading,
  // for the "Posted on" date and the first image.
  let date = '';
  let image = '';
  let node = $h.next();
  let guard = 0;
  while (node.length && !node.is('h1, h2, h3') && guard++ < 25) {
    if (!date) {
      const m = clean(node.text()).match(/Posted on\s+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
      if (m) date = m[1];
    }
    if (!image) {
      const img = node.is('img') ? node : node.find('img').first();
      if (img.length) image = img.attr('src') || '';
    }
    node = node.next();
  }

  return {
    title,
    url: `${pageUrl}#${id}`,
    external: $h.find('a[href]').first().attr('href') || '',
    date,
    image: image ? new URL(image, pageUrl).href : '',
  };
}

function articlesOn($, pageUrl) {
  const root = pickRoot($);
  let headings = root.find(ARTICLE_LEVEL).toArray();
  if (!headings.length) {
    headings = root.find('h2').toArray().filter((h) => !/^\d{4}$/.test(clean($(h).text())));
  }
  return headings.map((h) => headingInfo($, h, pageUrl)).filter((it) => it.title);
}

async function main() {
  const newsUrl = normalize(NEWS_URL);
  const $news = load(await getHtml(newsUrl));
  const items = articlesOn($news, newsUrl).slice(0, MAX_ITEMS);
  console.log(`News page: ${items.length} item(s)`);

  if (items.length < MAX_ITEMS) {
    const pages = subPages($news).slice(0, MAX_EXTRA_PAGES);
    if (!pages.length) console.log('No sub-pages found under News in the site menu.');
    for (const page of pages) {
      if (items.length >= MAX_ITEMS) break;
      try {
        const more = articlesOn(load(await getHtml(page)), page);
        console.log(`${page}: ${more.length} item(s)`);
        items.push(...more.slice(0, MAX_ITEMS - items.length));
      } catch (err) {
        console.log(`Skipped ${page}: ${err.message}`);
      }
    }
  }

  if (!items.length) {
    throw new Error('No news headings found on the News page. Has its layout changed?');
  }

  // No timestamp in the file, so it only changes (and is only saved) when the news changes.
  const data = { source: NEWS_URL, items };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${items.length} items to ${outPath}:`);
  for (const it of items) console.log(`  - ${it.title}${it.date ? ` (${it.date})` : ''}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
