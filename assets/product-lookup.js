// Predictive search can rank other products above an exact SKU, so check several.
const SEARCH_LIMIT = 5;

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
  let response = await fetch(url, { signal });
  // Predictive search rejects some languages, Thai included, with 417; the primary locale still answers.
  if (response.status === 417 && url.pathname !== '/search/suggest.json') {
    url.pathname = '/search/suggest.json';
    response = await fetch(url, { signal });
  }
  if (!response.ok) throw new Error(`Predictive search failed with ${response.status}`);
  const data = await response.json();
  return data.resources?.results?.products ?? [];
}

/**
 * Loads a product's storefront JSON from its URL.
 * @param {string} productUrl
 * @param {AbortSignal} signal
 */
export async function fetchProduct(productUrl, signal) {
  const { pathname } = new URL(productUrl, location.origin);
  const response = await fetch(`${pathname}.js`, { signal });
  return response.ok ? response.json() : null;
}

/**
 * Finds the variant whose SKU is exactly `code`, ignoring case.
 * Predictive search matches variant SKUs, then each candidate's product JSON confirms the exact SKU.
 * @param {string} code
 * @param {AbortSignal} signal
 * @returns {Promise<{ product: any, variant: any } | null>}
 */
export async function findVariantBySku(code, signal) {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;

  for (const candidate of await searchProducts(wanted, signal, { skuOnly: true })) {
    const product = await fetchProduct(candidate.url, signal);
    const variant = product?.variants.find((/** @type {{sku?: string}} */ item) => item.sku?.toUpperCase() === wanted);
    if (variant) return { product, variant };
  }
  return null;
}
