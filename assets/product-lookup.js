// Predictive search can rank other products above an exact SKU, so check several.
const SEARCH_LIMIT = 5;
// Each spelling costs a search, and they only run when the printed code found nothing.
const MAX_SKU_RESPELLINGS = 3;
// Storefront rate limits clear within seconds, so requests wait them out before reporting a failure.
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_WAIT_MS = 2000;
const MAX_RATE_LIMIT_WAIT_MS = 15000;
// QR short links hide their target from scripts, so the browser has to open them.
const SHORT_LINK_HOSTS = ['me-qr.com'];
// The previous website's product URLs end in the SKU: /en/product/<slug>/<sku>. Also read in main-404.liquid.
const LEGACY_PRODUCT_PATH = /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/product\/[^/]+\/([^/]+)\/?$/i;

// Shared so parallel lookups all pause together instead of each extending the limit.
let rateLimitedUntil = 0;

/**
 * Works out what a scanned or typed code refers to.
 * @param {string} text
 * @param {string[]} storeHosts - This store's domains, without `www.`.
 * @returns {{ type: 'sku' | 'product' | 'short-link', value: string } | { type: 'unknown' }}
 */
export function parseScannedCode(text, storeHosts) {
  const value = text.trim();
  if (!/^https?:\/\//i.test(value)) return { type: 'sku', value };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { type: 'unknown' };
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (SHORT_LINK_HOSTS.includes(host)) return { type: 'short-link', value: url.href };
  if (!storeHosts.includes(host)) return { type: 'unknown' };

  const legacy = url.pathname.match(LEGACY_PRODUCT_PATH);
  if (legacy?.[1]) return { type: 'sku', value: decodeURIComponent(legacy[1]) };
  if (/\/products\/[^/]+/.test(url.pathname)) return { type: 'product', value: url.href };
  return { type: 'unknown' };
}

/**
 * @param {number} milliseconds
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/**
 * Fetches a storefront URL, waiting out rate limits. The last 429 is returned for the caller to handle.
 * @param {string | URL} url
 * @param {AbortSignal} signal
 * @returns {Promise<Response>}
 */
async function fetchStorefront(url, signal) {
  for (let attempt = 0; ; attempt += 1) {
    const remaining = rateLimitedUntil - Date.now();
    if (remaining > 0) await wait(remaining, signal);

    const response = await fetch(url, { signal });
    if (response.status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) return response;

    const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
    const delay = Math.min(retryAfter || RATE_LIMIT_WAIT_MS * 2 ** attempt, MAX_RATE_LIMIT_WAIT_MS);
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
  }
}

/**
 * Searches products with predictive search.
 * @param {string} query
 * @param {AbortSignal} signal
 * @param {{ skuOnly?: boolean, limit?: number }} [options] - `skuOnly` matches variant SKUs instead of titles.
 * @returns {Promise<Array<{ title: string, url: string, handle?: string }>>}
 */
export async function searchProducts(query, signal, { skuOnly = false, limit = SEARCH_LIMIT } = {}) {
  const url = new URL(`${Theme.routes.predictive_search_url}.json`, location.origin);
  url.searchParams.set('q', query);
  url.searchParams.set('resources[type]', 'product');
  url.searchParams.set('resources[limit]', String(limit));
  if (skuOnly) url.searchParams.set('resources[options][fields]', 'variants.sku');
  let response = await fetchStorefront(url, signal);
  // Predictive search rejects some languages, Thai included, with 417; the primary locale still answers.
  if (response.status === 417 && url.pathname !== '/search/suggest.json') {
    url.pathname = '/search/suggest.json';
    response = await fetchStorefront(url, signal);
  }
  if (!response.ok) throw new Error(`Predictive search failed with ${response.status}`);
  const data = await response.json();
  return data.resources?.results?.products ?? [];
}

/**
 * Loads a product's storefront JSON from its URL.
 * @param {string} productUrl
 * @param {AbortSignal} signal
 * @param {{ strict?: boolean }} [options] - `strict` throws on failures such as rate limits, so only a 404 reads as missing.
 */
export async function fetchProduct(productUrl, signal, { strict = false } = {}) {
  const { pathname } = new URL(productUrl, location.origin);
  const response = await fetchStorefront(`${pathname}.js`, signal);
  if (strict && !response.ok && response.status !== 404) {
    throw new Error(`Product request failed with ${response.status}`);
  }
  return response.ok ? response.json() : null;
}

/**
 * Reduces a SKU to what survives printing: labels can double a hyphen or show O for 0.
 * @param {string} sku
 */
function looseSku(sku) {
  return sku
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0');
}

/**
 * Lists spellings with one 0 and O swapped, because search needs the characters the SKU really has.
 * Digit-only codes are barcodes, not printed SKUs.
 * @param {string} code
 * @returns {string[]}
 */
function respellSku(code) {
  if (!/[A-Z]/i.test(code)) return [];

  const spellings = [];
  for (const { 0: character, index } of code.matchAll(/[0O]/gi)) {
    spellings.push(`${code.slice(0, index)}${character === '0' ? 'O' : '0'}${code.slice(index + 1)}`);
  }
  return spellings.slice(0, MAX_SKU_RESPELLINGS);
}

/**
 * @param {string} query
 * @param {AbortSignal} signal
 * @param {boolean} tolerant
 * @returns {Promise<{ product: any, variant: any } | null>}
 */
async function matchSku(query, signal, tolerant) {
  const loose = looseSku(query);
  let similar = null;

  for (const candidate of await searchProducts(query, signal, { skuOnly: true })) {
    const product = await fetchProduct(candidate.url, signal, { strict: true });
    /** @type {Array<{sku?: string}>} */
    const variants = product?.variants ?? [];
    const variant = variants.find((item) => item.sku?.toUpperCase() === query);
    if (variant) return { product, variant };

    const close = tolerant ? variants.find((item) => item.sku && looseSku(item.sku) === loose) : null;
    if (close) similar ??= { product, variant: close };
  }
  return similar;
}

/**
 * Finds the variant whose SKU is exactly `code`, ignoring case.
 * Predictive search matches variant SKUs, then each candidate's product JSON confirms the exact SKU.
 * Failed requests throw, so a rate limit is never mistaken for a code that doesn't exist.
 * @param {string} code
 * @param {AbortSignal} signal
 * @param {{ tolerant?: boolean }} [options] - `tolerant` accepts codes that differ from the SKU by separators or
 *   0 and O. Use it for text known to be a code, because a loose match in free text can pick the wrong product.
 * @returns {Promise<{ product: any, variant: any } | null>}
 */
export async function findVariantBySku(code, signal, { tolerant = false } = {}) {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;

  for (const spelling of tolerant ? [wanted, ...respellSku(wanted)] : [wanted]) {
    const match = await matchSku(spelling, signal, tolerant);
    if (match) return match;
  }
  return null;
}

/**
 * Finds the variant a product URL points at, or the first one that can be bought.
 * @param {string} productUrl
 * @param {AbortSignal} signal
 * @returns {Promise<{ product: any, variant: any } | null>}
 */
export async function findVariantByUrl(productUrl, signal) {
  const product = await fetchProduct(productUrl, signal, { strict: true });
  if (!product) return null;

  const wanted = new URL(productUrl, location.origin).searchParams.get('variant');
  const variants = product.variants;
  const variant =
    variants.find((/** @type {{id: number}} */ item) => String(item.id) === wanted) ??
    variants.find((/** @type {{available: boolean}} */ item) => item.available) ??
    variants[0];
  return variant ? { product, variant } : null;
}
