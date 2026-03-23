#!/usr/bin/env node

/**
 * Static site crawler for paloozafoundation.org
 * Downloads all pages and assets, strips JS (SSR-only), rewrites URLs to local paths.
 */

import { writeFile, mkdir } from "fs/promises";
import { dirname, join, extname } from "path";
import { createHash } from "crypto";
import { URL } from "url";

const SITE_ORIGIN = "https://paloozafoundation.org";
const OUTPUT_DIR = join(process.cwd(), "dist");

// Pages to crawl (known from site navigation)
const PAGES = ["/", "/photos", "/about", "/www"];

// Domains whose assets we download locally
const ASSET_DOMAINS = [
  "asset.mmm.page",
  "static.mmm.dev",
  "static.mmm.page",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

// Track downloaded assets to avoid duplicates
const assetMap = new Map(); // original URL -> local path
const downloadedUrls = new Set();
const failedUrls = new Set();

// Rate limiting
let lastFetch = 0;
const FETCH_DELAY = 100; // ms between fetches

async function rateLimitedFetch(url, opts = {}) {
  const now = Date.now();
  const wait = FETCH_DELAY - (now - lastFetch);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

function hashUrl(url) {
  return createHash("md5").update(url).digest("hex").slice(0, 12);
}

function guessExtension(url, contentType) {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname);
    if (ext && ext.length <= 6) return ext;
  } catch {}

  const typeMap = {
    "text/css": ".css",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "font/ttf": ".ttf",
    "application/font-woff2": ".woff2",
    "application/font-woff": ".woff",
    "application/x-font-ttf": ".ttf",
  };

  if (contentType) {
    const base = contentType.split(";")[0].trim();
    if (typeMap[base]) return typeMap[base];
  }

  return "";
}

function getLocalAssetPath(url) {
  if (assetMap.has(url)) return assetMap.get(url);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  let pathname = parsed.pathname;
  if (pathname === "/" || pathname === "") pathname = "/index";

  if (parsed.hostname === "fonts.googleapis.com") {
    const hash = hashUrl(url);
    const localPath = `assets/fonts/google_${hash}.css`;
    assetMap.set(url, localPath);
    return localPath;
  }

  if (parsed.hostname === "fonts.gstatic.com") {
    const localPath = `assets/fonts${pathname}`;
    assetMap.set(url, localPath);
    return localPath;
  }

  if (parsed.hostname === "static.mmm.dev") {
    // Only download CSS files, skip JS
    if (!pathname.endsWith(".css")) return null;
    const localPath = `assets/static${pathname}`;
    assetMap.set(url, localPath);
    return localPath;
  }

  if (parsed.hostname === "static.mmm.page") {
    const localPath = `assets/icons${pathname}`;
    assetMap.set(url, localPath);
    return localPath;
  }

  if (parsed.hostname === "asset.mmm.page") {
    const localPath = `assets/media${pathname}`;
    assetMap.set(url, localPath);
    return localPath;
  }

  return null;
}

async function downloadAsset(url) {
  if (downloadedUrls.has(url) || failedUrls.has(url)) return;
  downloadedUrls.add(url);

  const localPath = getLocalAssetPath(url);
  if (!localPath) return;

  const fullPath = join(OUTPUT_DIR, localPath);

  try {
    console.log(`  Downloading: ${url.slice(0, 100)}...`);
    const res = await rateLimitedFetch(url);
    if (!res.ok) {
      console.warn(`  WARN: ${res.status} for ${url.slice(0, 80)}`);
      failedUrls.add(url);
      return;
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    let savePath = fullPath;
    if (!extname(savePath)) {
      const ct = res.headers.get("content-type");
      const ext = guessExtension(url, ct);
      if (ext) {
        savePath += ext;
        assetMap.set(url, localPath + ext);
      }
    }

    await mkdir(dirname(savePath), { recursive: true });
    await writeFile(savePath, buffer);

    // If it's a CSS file, parse it for additional asset URLs (fonts, images)
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/css") || savePath.endsWith(".css")) {
      const cssText = buffer.toString("utf-8");
      await processCssAssets(cssText, url, savePath);
    }
  } catch (err) {
    console.warn(`  ERROR downloading ${url.slice(0, 80)}: ${err.message}`);
    failedUrls.add(url);
  }
}

async function processCssAssets(cssText, cssUrl, cssFilePath) {
  const urlRegex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  let match;
  const urls = [];

  while ((match = urlRegex.exec(cssText)) !== null) {
    let assetUrl = match[1];
    if (assetUrl.startsWith("data:")) continue;

    try {
      assetUrl = new URL(assetUrl, cssUrl).href;
    } catch {
      continue;
    }

    const parsed = new URL(assetUrl);
    if (ASSET_DOMAINS.includes(parsed.hostname)) {
      urls.push(assetUrl);
    }
  }

  for (const u of urls) {
    await downloadAsset(u);
  }

  // Rewrite CSS file with local paths
  let rewritten = cssText;
  for (const [origUrl, localRelPath] of assetMap) {
    if (rewritten.includes(origUrl)) {
      const cssDir = dirname(cssFilePath);
      const assetFullPath = join(OUTPUT_DIR, localRelPath);
      let relPath = relativePath(cssDir, assetFullPath);
      rewritten = rewritten.split(origUrl).join(relPath);
    }
  }

  if (rewritten !== cssText) {
    await writeFile(cssFilePath, rewritten, "utf-8");
  }
}

function relativePath(from, to) {
  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const downs = toParts.slice(common);
  const rel = [...Array(ups).fill(".."), ...downs].join("/");
  return rel || ".";
}

/** Decode common HTML entities in URLs */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractAssetUrls(html) {
  const urls = new Set();

  const patterns = [
    /(?:src|href|content)=["']([^"']+)["']/g,
    /url\(\s*['"]?([^'")]+)['"]?\s*\)/g,
    /data-href=["']([^"']+)["']/g,
    // Also match HTML-entity-encoded url() in inline styles
    /url\(&#x27;([^&]+)&#x27;\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      let url = match[1];
      if (url.startsWith("data:") || url.startsWith("#") || url.startsWith("javascript:")) continue;

      // Decode HTML entities
      url = decodeHtmlEntities(url);

      try {
        if (!url.startsWith("http")) {
          url = new URL(url, SITE_ORIGIN).href;
        }
        const parsed = new URL(url);
        if (ASSET_DOMAINS.includes(parsed.hostname)) {
          if (parsed.pathname === "/" && !parsed.search) continue;
          urls.add(url);
        }
      } catch {}
    }
  }

  return [...urls];
}

/** Extract code-embed content from __NEXT_DATA__ JSON */
function extractCodeEmbeds(html) {
  const embeds = new Map(); // htmlId -> embed HTML
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return embeds;

  try {
    const data = JSON.parse(match[1]);
    const body = data?.props?.pageProps?.pageEnvelope?.body;
    if (!body?.things) return embeds;

    for (const thing of body.things) {
      if (thing.type === "code-embed" && thing.content?.ceCode) {
        const htmlId = thing.properties?.htmlId;
        if (htmlId) {
          embeds.set(htmlId, thing.content.ceCode);
        }
      }
    }
  } catch {}

  return embeds;
}

/** Inject code-embed content into empty embed divs */
function injectCodeEmbeds(html, embeds) {
  let result = html;
  for (const [htmlId, embedCode] of embeds) {
    // Find the empty embed div and inject the content
    const pattern = new RegExp(
      `(<div[^>]*id="${htmlId}"[^>]*data-type="code-embed"[^>]*>` +
      `<div class="block-content"[^>]*>)` +
      `<div data-type="code-embed"></div>`,
      "g"
    );
    result = result.replace(pattern, `$1<div data-type="code-embed">${embedCode}</div>`);
  }
  return result;
}

/** Strip all <script> tags and their content from HTML */
function stripScripts(html) {
  let result = html;

  // Remove all <script> ... </script> blocks
  result = result.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // Remove any self-closing script tags
  result = result.replace(/<script\b[^>]*\/>/gi, "");

  // Remove the noscript data-n-css tag (Next.js artifact)
  result = result.replace(/<noscript\s+data-n-css="">\s*<\/noscript>/gi, "");

  // Remove preload hints for JS files
  result = result.replace(/<link\s+rel="preload"[^>]+as="script"[^>]*\/?>/gi, "");

  // Remove modulepreload links
  result = result.replace(/<link\s+rel="modulepreload"[^>]*\/?>/gi, "");

  return result;
}

function rewriteHtml(html, pagePath) {
  let result = html;

  // Calculate depth for relative paths
  const depth = pagePath.split("/").filter(Boolean).length;
  const prefix = depth > 0 ? "../".repeat(depth) : "./";

  // Inject code-embed content before stripping scripts (needs __NEXT_DATA__)
  const embeds = extractCodeEmbeds(result);
  if (embeds.size > 0) {
    console.log(`  Injecting ${embeds.size} code embed(s)`);
    result = injectCodeEmbeds(result, embeds);
  }

  // Strip all scripts - the SSR HTML has all content, JS just breaks things
  result = stripScripts(result);

  // Convert data-href font loading to regular href (must happen before URL replacements)
  result = result.replace(
    /(<link[^>]*?)data-href=["']([^"']+)["']([^>]*?)data-optimized-fonts=["']true["']([^>]*?>)/g,
    (match, before, url, mid, after) => {
      // Decode HTML entities in the URL
      const decodedUrl = decodeHtmlEntities(url);
      const localPath = assetMap.get(decodedUrl);
      if (localPath) {
        return `${before}href="${prefix}${localPath}"${mid}${after}`;
      }
      return `${before}href="${decodedUrl}"${mid}${after}`;
    }
  );

  // Sort asset map entries by URL length (longest first) to prevent partial matches
  const sortedEntries = [...assetMap.entries()]
    .filter(([url]) => !failedUrls.has(url))
    .sort((a, b) => b[0].length - a[0].length);

  // Replace asset URLs with local paths
  for (const [origUrl, localPath] of sortedEntries) {
    try {
      const parsed = new URL(origUrl);
      if (parsed.pathname === "/" && !parsed.search) continue;
    } catch {}

    const escaped = origUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), prefix + localPath);
  }

  // Handle HTML-encoded versions of URLs (&amp; for &)
  for (const [origUrl, localPath] of sortedEntries) {
    try {
      const parsed = new URL(origUrl);
      if (parsed.pathname === "/" && !parsed.search) continue;
    } catch {}

    const htmlEncoded = origUrl.replace(/&/g, "&amp;");
    if (htmlEncoded !== origUrl && result.includes(htmlEncoded)) {
      result = result.split(htmlEncoded).join(prefix + localPath);
    }
  }

  // Handle &#x27; encoded URLs in inline styles (e.g. background-image:url(&#x27;https://...&#x27;))
  for (const [origUrl, localPath] of sortedEntries) {
    try {
      const parsed = new URL(origUrl);
      if (parsed.pathname === "/" && !parsed.search) continue;
    } catch {}

    const entityEncoded = origUrl.replace(/'/g, "&#x27;");
    if (result.includes(entityEncoded)) {
      result = result.split(entityEncoded).join(prefix + localPath);
    }
  }

  // Rewrite asset.mmm.dev responsive image URLs to local asset.mmm.page copies
  // asset.mmm.dev URLs are the same images but with ?width= params for responsive sizing
  // Map them to our local copies (which are full-size from asset.mmm.page)
  result = result.replace(
    /https:\/\/asset\.mmm\.dev\/([^"'\s?]+)\?width=\d+/g,
    (match, path) => {
      const localPath = assetMap.get(`https://asset.mmm.page/${path}`);
      if (localPath) {
        return prefix + localPath;
      }
      return match;
    }
  );

  // Remove preconnect links for localized domains
  result = result.replace(
    /<link\s+rel="preconnect"\s+href="https:\/\/fonts\.(googleapis\.com|gstatic\.com)"[^>]*\/?>/g,
    ""
  );

  // Rewrite internal navigation links
  const internalLinks = ["/photos", "/about", "/www"];
  for (const link of internalLinks) {
    const linkRegex = new RegExp(`href=["']${link}["']`, "g");
    result = result.replace(linkRegex, `href="${prefix}${link.slice(1)}/index.html"`);
  }

  // Rewrite root link
  result = result.replace(/href=["']\/["']/g, `href="${prefix}index.html"`);

  // Add Google Analytics back as a simple snippet (without the nonce)
  const gaSnippet = `
<script async src="https://www.googletagmanager.com/gtag/js?id=G-8BJLZRVJ25"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-8BJLZRVJ25');</script>`;

  // Fix for mmm.page text rendering: the --scaler CSS variable is normally
  // set by JavaScript at runtime. Without it, text-content elements compute
  // to absurd widths (millions of px) and text becomes invisible.
  // Setting --scaler: 1 as a default restores correct text rendering.
  const cssFixSnippet = `
<style>
.text-content { --scaler: 1 !important; }
</style>`;

  result = result.replace("</head>", `${cssFixSnippet}\n${gaSnippet}\n</head>`);

  // Replace Cloudflare email-obfuscated hello@ with plain contact@ email
  result = result.replace(
    /<a[^>]*href="\/cdn-cgi\/l\/email-protection[^"]*"[^>]*><span class="__cf_email__"[^>]*>\[email[^<]*\]<\/span><\/a>/g,
    '<a href="mailto:contact@paloozafoundation.org">contact@paloozafoundation.org</a>'
  );

  return result;
}

async function crawlPage(pagePath) {
  const url = `${SITE_ORIGIN}${pagePath}`;
  console.log(`\nCrawling page: ${url}`);

  try {
    const res = await rateLimitedFetch(url);
    if (!res.ok) {
      console.error(`  Failed: ${res.status} ${res.statusText}`);
      return;
    }

    const html = await res.text();

    // Extract and download assets
    const assetUrls = extractAssetUrls(html);
    console.log(`  Found ${assetUrls.length} assets to download`);

    // Pre-register all asset paths
    for (const assetUrl of assetUrls) {
      getLocalAssetPath(assetUrl);
    }

    // Download all assets
    for (const assetUrl of assetUrls) {
      await downloadAsset(assetUrl);
    }

    // Rewrite HTML
    const rewritten = rewriteHtml(html, pagePath);

    // Save page
    let outputPath;
    if (pagePath === "/") {
      outputPath = join(OUTPUT_DIR, "index.html");
    } else {
      outputPath = join(OUTPUT_DIR, pagePath.slice(1), "index.html");
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, rewritten, "utf-8");
    console.log(`  Saved: ${outputPath}`);
  } catch (err) {
    console.error(`  ERROR crawling ${url}: ${err.message}`);
  }
}

async function createCNAME() {
  await writeFile(join(OUTPUT_DIR, "CNAME"), "paloozafoundation.org\n");
}

async function createNojekyll() {
  await writeFile(join(OUTPUT_DIR, ".nojekyll"), "");
}

async function create404() {
  try {
    const { readFile } = await import("fs/promises");
    const index = await readFile(join(OUTPUT_DIR, "index.html"), "utf-8");
    await writeFile(join(OUTPUT_DIR, "404.html"), index);
  } catch {}
}

async function main() {
  console.log("=== Palooza Foundation Static Site Crawler ===\n");
  console.log(`Output directory: ${OUTPUT_DIR}`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const page of PAGES) {
    await crawlPage(page);
  }

  // Discover additional pages
  console.log("\n--- Scanning for additional internal pages ---");
  const { readFile } = await import("fs/promises");
  const indexHtml = await readFile(join(OUTPUT_DIR, "index.html"), "utf-8");
  const internalLinkRegex = /href=["'](\/[a-zA-Z0-9_-]+)["']/g;
  let match;
  const discoveredPages = new Set(PAGES);
  while ((match = internalLinkRegex.exec(indexHtml)) !== null) {
    const path = match[1];
    if (!discoveredPages.has(path) && !path.startsWith("/assets")) {
      discoveredPages.add(path);
      console.log(`  Discovered additional page: ${path}`);
      await crawlPage(path);
    }
  }

  await createCNAME();
  await createNojekyll();
  await create404();

  console.log("\n=== Crawl Complete ===");
  console.log(`Pages crawled: ${PAGES.length + (discoveredPages.size - PAGES.length)}`);
  console.log(`Assets downloaded: ${downloadedUrls.size}`);
  console.log(`Failed downloads: ${failedUrls.size}`);
  if (failedUrls.size > 0) {
    console.log("Failed URLs:");
    for (const url of failedUrls) {
      console.log(`  - ${url}`);
    }
  }
  console.log(`\nOutput: ${OUTPUT_DIR}`);
  console.log("To preview: npx serve dist");
}

main().catch(console.error);
