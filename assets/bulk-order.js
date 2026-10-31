import { Component } from '@theme/component';
import { CartAddEvent } from '@theme/events';
import { fetchProduct, findVariantBySku, searchProducts } from '@theme/product-lookup';
import { looksLikeCode, parsePastedText, parseText, parseWorkbook } from '@theme/bulk-sheet-parser';

// Hotel RFQ workbooks run to a few hundred lines; beyond this, ask for smaller uploads.
const MAX_ROWS = 300;
// Parallel lookups per list; more trips predictive search rate limits for one visitor.
const CONCURRENCY = 4;
// Only the first few codes found in a description are tried as SKUs.
const MAX_SKU_CANDIDATES = 3;
// Name searches fetch the most results predictive search allows, then the best few are offered.
const NAME_SEARCH_LIMIT = 10;
const CHOICES_SHOWN = 5;
// Same threshold as product-finder's bulk match: a confident name match is picked for the customer.
const AUTO_MATCH_SCORE = 72;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'product', 'products', 'item', 'items', 'st', 'ss',
  'เครื่อง', 'สินค้า', 'รุ่น', 'แบบ', 'พร้อม', 'จำนวน', 'ขนาด', 'ใช้กับ',
]);
// Spec values compared between the request and a product; another value of the same kind is a conflict.
const SPEC_PATTERNS = /** @type {Array<[string, RegExp]>} */ ([
  ['power', /(?<![\d.])(\d+(?:\.\d+)?)\s*(kw|w)\b/g],
  ['voltage', /(?<![\d.])(\d+(?:\.\d+)?)\s*(v)\b/g],
  ['capacity', /(?<![\d.])(\d+(?:\.\d+)?)\s*(l|ltr|litres?|liters?|ml)\b/g],
  ['length', /(?<![\d.])(\d+(?:\.\d+)?)\s*(mm|cm|inch|in|")(?![a-z])/g],
  ['weight', /(?<![\d.])(\d+(?:\.\d+)?)\s*(kg|g)\b/g],
  ['fraction', /(?<![\d.])(\d+)\s*\/\s*(\d+)(?![\d.])/g],
]);
const MEASUREMENT =
  /^\d+(?:\.\d+)?(?:mm|cm|m|kg|g|mg|l|ltr|ml|oz|w|kw|v|inch|in)(?:x\d+(?:\.\d+)?(?:mm|cm|m|kg|g|mg|l|ltr|ml|oz|w|kw|v|inch|in))*$/i;

/** @typedef {import('@theme/bulk-sheet-parser').BulkItem} BulkItem */
/** @typedef {import('@theme/bulk-sheet-parser').BulkSheet} BulkSheet */

/**
 * @typedef {object} BulkOrderRefs
 * @property {HTMLInputElement} file - Picks or receives a dropped spreadsheet.
 * @property {HTMLTextAreaElement} text - A pasted list, one product per line.
 * @property {HTMLElement} sheetPicker - Wraps the worksheet choice for multi-sheet workbooks.
 * @property {HTMLSelectElement} sheet - Which worksheet to match.
 * @property {HTMLElement} status - Announces parsing, matching and cart results.
 * @property {HTMLElement} results - Wraps the matched list.
 * @property {HTMLOListElement} list - One row per uploaded line.
 * @property {HTMLElement} summary - How many rows are ready to add.
 * @property {HTMLButtonElement} addButton - Adds every ready row to the cart.
 * @property {HTMLElement} addLabel - The add button's text.
 * @property {HTMLElement} cartLink - Shown after the list is added.
 * @property {HTMLTemplateElement} rowTemplate - Markup for one row.
 */

/**
 * Matches an uploaded spreadsheet or pasted list to store products by SKU, or by name when a line
 * has no known SKU, and adds every matched line to the cart in one request.
 * @extends {Component<BulkOrderRefs>}
 */
class BulkOrder extends Component {
  requiredRefs = ['file', 'text', 'sheetPicker', 'sheet', 'status', 'results', 'list', 'summary', 'addButton', 'addLabel', 'cartLink', 'rowTemplate'];

  /** @type {Map<HTMLElement, { product: any, variant: any } | null>} */
  #rows = new Map();

  /** @type {AbortController | null} */
  #matching = null;

  /** @type {BulkSheet[]} */
  #sheets = [];

  /** @type {AbortController | null} */
  #adding = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#matching?.abort();
    this.#adding?.abort();
  }

  /** @param {Event} event */
  readFile = async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.#setStatus(this.dataset.messageReading);
    try {
      let sheets;
      if (/\.(csv|txt)$/i.test(file.name)) {
        sheets = parseWorkbook([{ name: file.name, rows: parseText(decodeText(await file.arrayBuffer())) }]);
      } else {
        const XLSX = await loadSheetReader(this.dataset.readerUrl ?? '');
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        sheets = parseWorkbook(
          workbook.SheetNames.map((/** @type {string} */ name) => ({
            name,
            rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '' }),
          }))
        );
      }
      this.#showSheets(sheets);
      if (!sheets.length) this.#setStatus(this.dataset.messageEmpty, 'error');
    } catch {
      this.#showSheets([]);
      this.#setStatus(this.dataset.messageUnreadable, 'error');
    }
  };

  chooseSheet = () => {
    const sheet = this.#sheets[Number(this.refs.sheet.value)];
    if (sheet) this.#match(sheet.items);
  };

  /** @param {SubmitEvent} event */
  matchText = (event) => {
    event.preventDefault();
    this.#showSheets([]);
    this.#match(parsePastedText(this.refs.text.value));
  };

  /** @param {Event} event */
  chooseProduct = async (event) => {
    const select = event.target;
    const row = select instanceof HTMLSelectElement ? select.closest('li') : null;
    if (!(select instanceof HTMLSelectElement) || !row) return;

    if (!select.value) {
      this.#rows.set(row, null);
      this.#setRowState(row, 'choose');
      this.#updateSummary();
      return;
    }

    this.#setRowState(row, 'loading');
    try {
      const product = await fetchProduct(select.value, this.#matching?.signal ?? new AbortController().signal);
      if (!row.isConnected) return;
      if (!product) throw new Error('Product not found');
      const variant = product.variants.find((/** @type {any} */ item) => item.available) ?? product.variants[0];
      this.#showMatch(row, product, variant);
    } catch {
      if (row.isConnected) this.#setRowState(row, 'choose', this.dataset.messageRowError);
    }
    this.#updateSummary();
  };

  /** @param {Event} event */
  chooseVariant = (event) => {
    const select = event.target;
    const row = select instanceof HTMLSelectElement ? select.closest('li') : null;
    const match = row ? this.#rows.get(row) : null;
    if (!row || !match || !(select instanceof HTMLSelectElement)) return;

    const variant = match.product.variants.find((/** @type {any} */ item) => String(item.id) === select.value);
    if (variant) this.#showMatch(row, match.product, variant);
    this.#updateSummary();
  };

  /** @param {Event} event */
  removeRow = (event) => {
    const button = event.target;
    const row = button instanceof Element ? button.closest('li') : null;
    if (!row) return;

    // Keep focus in the list so keyboard users can carry on removing rows.
    const neighbour = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    this.#rows.delete(row);
    this.#updateSummary();
    const next = neighbour?.querySelector('[data-field="remove"]');
    if (next instanceof HTMLElement) next.focus();
    else this.refs.text.focus();
  };

  add = async () => {
    if (this.#adding) return;

    /** @type {Map<number, number>} */
    const quantities = new Map();
    for (const [row, match] of this.#rows) {
      if (!match?.variant.available) continue;
      const input = row.querySelector('[data-field="quantity"]');
      const quantity = Math.max(1, Math.round(Number(input instanceof HTMLInputElement ? input.value : 1) || 1));
      quantities.set(match.variant.id, (quantities.get(match.variant.id) ?? 0) + quantity);
    }
    if (!quantities.size) return;

    const sections = new Set();
    for (const component of document.querySelectorAll('cart-items-component')) {
      if (component instanceof HTMLElement && component.dataset.sectionId) sections.add(component.dataset.sectionId);
    }

    const { addButton, cartLink } = this.refs;
    const controller = new AbortController();
    this.#adding = controller;
    addButton.disabled = true;
    addButton.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          items: [...quantities].map(([id, quantity]) => ({ id, quantity })),
          sections: [...sections].join(','),
        }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.status) {
        this.#setStatus(result.description || result.message || this.dataset.messageAddError, 'error');
        return;
      }

      const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { signal: controller.signal });
      const cart = await cartResponse.json();
      this.dispatchEvent(
        new CartAddEvent({}, 'bulk-order', {
          source: 'bulk-order',
          itemCount: cart.item_count,
          sections: result.sections,
        })
      );
      this.#setStatus(fill(this.dataset.messageAdded, { count: quantities.size }), 'success');
      cartLink.hidden = false;
    } catch {
      if (!controller.signal.aborted) this.#setStatus(this.dataset.messageAddError, 'error');
    } finally {
      if (this.#adding === controller) this.#adding = null;
      addButton.removeAttribute('aria-busy');
      this.#updateSummary();
    }
  };

  /**
   * Lists the workbook's sheets when there are several, then matches the first.
   * @param {BulkSheet[]} sheets
   */
  #showSheets(sheets) {
    const { sheet, sheetPicker } = this.refs;
    this.#sheets = sheets;
    sheet.replaceChildren(
      ...sheets.map((item, index) => new Option(`${item.name} (${item.items.length})`, String(index)))
    );
    sheetPicker.hidden = sheets.length < 2;
    if (sheets.length) this.#match(sheets[0].items);
  }

  /** @param {BulkItem[]} items */
  async #match(items) {
    if (!items.length) {
      this.#setStatus(this.dataset.messageEmpty, 'error');
      return;
    }
    if (items.length > MAX_ROWS) {
      this.#setStatus(fill(this.dataset.messageTooMany, { max: MAX_ROWS }), 'error');
      return;
    }

    this.#matching?.abort();
    const controller = new AbortController();
    this.#matching = controller;

    const { list, results, cartLink, rowTemplate } = this.refs;
    this.#rows.clear();
    list.replaceChildren();
    cartLink.hidden = true;
    /** @type {Array<[HTMLElement, BulkItem]>} */
    const work = [];
    for (const item of items) {
      const fragment = /** @type {DocumentFragment} */ (rowTemplate.content.cloneNode(true));
      const row = fragment.querySelector('li');
      if (!row) continue;
      const source = row.querySelector('[data-field="source"]');
      if (source) source.textContent = [item.code, item.text].filter(Boolean).join(' · ');
      const quantity = row.querySelector('[data-field="quantity"]');
      if (quantity instanceof HTMLInputElement) quantity.value = String(item.quantity);
      this.#rows.set(row, null);
      list.append(row);
      work.push([row, item]);
    }
    results.hidden = false;
    this.#setStatus(fill(this.dataset.messageMatching, { total: items.length }));
    this.#updateSummary();

    /** @type {Map<string, Promise<{ product: any, variant: any } | null>>} */
    const skuLookups = new Map();
    const lookupSku = (/** @type {string} */ code) => {
      const key = code.toUpperCase();
      let lookup = skuLookups.get(key);
      if (!lookup) {
        lookup = findVariantBySku(code, controller.signal);
        skuLookups.set(key, lookup);
      }
      return lookup;
    };

    const next = work.values();
    const worker = async () => {
      for (const [row, item] of next) {
        if (controller.signal.aborted) return;
        await this.#resolveRow(row, item, lookupSku, controller.signal);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (controller.signal.aborted) return;

    this.#matching = null;
    const { ready, choose, missing, guess } = this.#counts();
    this.#setStatus(fill(this.dataset.messageMatched, { ready, choose, missing, guess, total: this.#rows.size }));
  }

  /**
   * @param {HTMLElement} row
   * @param {BulkItem} item
   * @param {(code: string) => Promise<{ product: any, variant: any } | null>} lookupSku
   * @param {AbortSignal} signal
   */
  async #resolveRow(row, item, lookupSku, signal) {
    try {
      for (const code of skuCandidates(item)) {
        const match = await lookupSku(code);
        if (signal.aborted) return;
        if (match) {
          this.#showMatch(row, match.product, match.variant);
          return;
        }
      }

      let products = [];
      for (const query of nameQueries(item.text || item.code)) {
        products = await searchProducts(query, signal, { limit: NAME_SEARCH_LIMIT });
        if (signal.aborted) return;
        if (products.length) break;
      }
      if (!products.length) {
        this.#setRowState(row, 'missing', this.dataset.messageRowNotFound);
        return;
      }

      const ranked = rankProducts(item.text || item.code, products);
      this.#showChoices(row, ranked.slice(0, CHOICES_SHOWN).map(({ product }) => product));
      const [best] = ranked;
      if (best?.confident) {
        const product = await fetchProduct(best.product.url, signal);
        if (signal.aborted || !product) return;
        const variant = product.variants.find((/** @type {any} */ option) => option.available) ?? product.variants[0];
        const select = field(row, 'options');
        if (select instanceof HTMLSelectElement) select.value = best.product.url;
        this.#showMatch(row, product, variant, this.dataset.messageRowGuess);
        row.dataset.guess = 'true';
      }
    } catch {
      if (!signal.aborted) this.#setRowState(row, 'missing', this.dataset.messageRowError);
    } finally {
      if (!signal.aborted) this.#updateSummary();
    }
  }

  /**
   * @param {HTMLElement} row
   * @param {Array<{ title: string, url: string }>} products
   */
  #showChoices(row, products) {
    const select = field(row, 'options');
    if (!(select instanceof HTMLSelectElement)) return;
    for (const product of products) select.add(new Option(product.title, product.url));
    field(row, 'choose')?.removeAttribute('hidden');
    this.#setRowState(row, 'choose');
  }

  /**
   * @param {HTMLElement} row
   * @param {any} product
   * @param {any} variant
   * @param {string} [note] - Shown under an available match, e.g. that it was matched by name.
   */
  #showMatch(row, product, variant, note = '') {
    this.#rows.set(row, { product, variant });
    delete row.dataset.guess;

    const image = field(row, 'image');
    const src = variant.featured_image?.src ?? product.featured_image;
    if (image instanceof HTMLImageElement) {
      if (src) {
        const imageUrl = new URL(src, location.origin);
        imageUrl.searchParams.set('width', '128');
        image.src = imageUrl.href;
        image.hidden = false;
      } else {
        image.removeAttribute('src');
        image.hidden = true;
      }
    }

    const title = field(row, 'title');
    if (title instanceof HTMLAnchorElement) {
      title.textContent = product.title;
      title.href = variant.id ? `${product.url ?? `/products/${product.handle}`}?variant=${variant.id}` : product.url;
    }
    const sku = field(row, 'sku');
    if (sku) sku.textContent = variant.sku || '–';

    const variants = field(row, 'variants');
    const variantPicker = field(row, 'variant-choose');
    if (variants instanceof HTMLSelectElement && variantPicker) {
      variants.replaceChildren();
      if (product.variants.length > 1) {
        for (const option of product.variants) {
          const element = new Option(option.title, String(option.id), false, option.id === variant.id);
          element.disabled = !option.available;
          variants.add(element);
        }
      }
      variantPicker.hidden = product.variants.length < 2;
    }

    this.#setRowState(row, variant.available ? 'matched' : 'unavailable', variant.available ? note : this.dataset.messageRowUnavailable);
  }

  /**
   * @param {HTMLElement} row
   * @param {'loading' | 'matched' | 'choose' | 'missing' | 'unavailable'} state
   * @param {string} [note]
   */
  #setRowState(row, state, note = '') {
    row.dataset.state = state;
    const resolved = state === 'matched' || state === 'unavailable';
    const product = field(row, 'product');
    if (product) product.hidden = !resolved;
    const variantPicker = field(row, 'variant-choose');
    if (variantPicker && !resolved) variantPicker.hidden = true;
    const noteElement = field(row, 'note');
    if (noteElement) {
      noteElement.textContent = note;
      noteElement.hidden = !note;
    }
    if (state === 'choose' || state === 'missing') this.#rows.set(row, null);
  }

  #counts() {
    let ready = 0;
    let choose = 0;
    let missing = 0;
    let guess = 0;
    for (const [row, match] of this.#rows) {
      if (match?.variant.available && row.dataset.guess) guess += 1;
      if (match?.variant.available) ready += 1;
      else if (row.dataset.state === 'choose') choose += 1;
      else if (row.dataset.state !== 'loading') missing += 1;
    }
    return { ready, choose, missing, guess };
  }

  #updateSummary() {
    const { summary, addButton, addLabel, results } = this.refs;
    const { ready } = this.#counts();
    summary.textContent = fill(this.dataset.labelSummary, { ready, total: this.#rows.size });
    addLabel.textContent = fill(this.dataset.labelAdd, { count: ready });
    addButton.disabled = ready === 0 || Boolean(this.#adding);
    if (!this.#rows.size) results.hidden = true;
  }

  /**
   * @param {string | undefined} message
   * @param {'' | 'success' | 'error'} [tone] - Colors the message; screen readers hear it either way.
   */
  #setStatus(message, tone = '') {
    const { status } = this.refs;
    status.textContent = message ?? '';
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }
}

/**
 * @param {Element} row
 * @param {string} name
 */
function field(row, name) {
  const element = row.querySelector(`[data-field="${name}"]`);
  return element instanceof HTMLElement ? element : null;
}

/**
 * Replaces `[name]` tokens left by the Liquid `t` filter.
 * @param {string | undefined} template
 * @param {Record<string, number | string>} values
 */
function fill(template, values) {
  return (template ?? '').replace(/\[(\w+)\]/g, (token, name) => (name in values ? String(values[name]) : token));
}

/** @param {BulkItem} item */
function skuCandidates(item) {
  const tokens = item.text.match(/[A-Za-z0-9]+(?:[-/.][A-Za-z0-9]+)*/g) ?? [];
  const fromText = tokens.filter(
    (token) => /[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 4 && !MEASUREMENT.test(token)
  );
  const whole = looksLikeCode(item.text) ? [item.text] : [];
  const unique = new Map();
  for (const code of [item.code, ...whole, ...fromText]) {
    if (code && !unique.has(code.toUpperCase())) unique.set(code.toUpperCase(), code);
  }
  return [...unique.values()].slice(0, MAX_SKU_CANDIDATES);
}

/**
 * Predictive search needs every term to match, so long descriptions are cut to their leading words,
 * then cut again when the longer query finds nothing.
 * @param {string} value
 */
function nameQueries(value) {
  const words = value
    .replace(/[()[\],;:"'®™~*]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !/^[\d.,/-]+$/.test(word) && !MEASUREMENT.test(word));
  return [...new Set([words.slice(0, 4).join(' '), words.slice(0, 2).join(' ')])].filter(Boolean);
}

/** @param {string} value */
function normalizeKeyword(value) {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** @param {string} value */
function keywords(value) {
  return [
    ...new Set(
      normalizeKeyword(value)
        .split(/\s+/)
        .filter((word) => word.length > 1 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
    ),
  ];
}

/** @param {string} value */
function specs(value) {
  const text = value.toLowerCase();
  const found = new Set();
  for (const [kind, pattern] of SPEC_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (kind === 'fraction') {
        found.add(`fraction:${match[1]}/${match[2]}`);
        continue;
      }
      let number = Number(match[1]);
      const unit = match[2];
      // Compare lengths in mm, capacity in ml, power in W and weight in g.
      if (unit === 'cm') number *= 10;
      else if (unit === 'inch' || unit === 'in' || unit === '"') number *= 25.4;
      else if (unit === 'kw' || unit === 'kg' || (kind === 'capacity' && unit !== 'ml')) number *= 1000;
      found.add(`${kind}:${Math.round(number)}`);
    }
  }
  return [...found];
}

/**
 * Scores name-search results against the customer's description, following product-finder's
 * bulk match: keyword coverage in the title and text, plus agreeing or conflicting specs.
 * @param {string} query
 * @param {Array<{ title: string, url: string, vendor?: string, type?: string, tags?: string[], body?: string }>} products
 */
function rankProducts(query, products) {
  const queryWords = keywords(query);
  const queryText = normalizeKeyword(query);
  const querySpecs = specs(query);

  return products
    .map((product, position) => {
      const name = normalizeKeyword(`${product.title} ${product.vendor ?? ''} ${product.type ?? ''}`);
      const body = (product.body ?? '').replace(/<[^>]*>/g, ' ');
      const fullText = normalizeKeyword(`${name} ${(product.tags ?? []).join(' ')} ${body}`);
      const share = (/** @type {string} */ text) =>
        queryWords.length ? queryWords.filter((word) => text.includes(word)).length / queryWords.length : 0;
      const productSpecs = specs(`${product.title} ${body}`);
      const matchedSpecs = querySpecs.filter((value) => productSpecs.includes(value));
      const conflicts = querySpecs.filter((value) => {
        const kind = value.split(':')[0];
        return productSpecs.some((candidate) => candidate.startsWith(`${kind}:`)) && !productSpecs.includes(value);
      });

      let score = share(fullText) * 50 + share(name) * 30;
      if (queryText && name.includes(queryText)) score += 15;
      if (querySpecs.length) score += (matchedSpecs.length / querySpecs.length) * 24;
      score -= conflicts.length * 18;
      score = Math.max(0, Math.min(100, Math.round(score)));
      return { product, score, position, confident: score >= AUTO_MATCH_SCORE && conflicts.length === 0 };
    })
    .sort((a, b) => b.score - a.score || a.position - b.position);
}

/**
 * Loads SheetJS on first upload; most visitors never need it.
 * @param {string} src
 * @returns {Promise<any>}
 */
function loadSheetReader(src) {
  // @ts-ignore SheetJS is a global from the reader script.
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    // @ts-ignore
    script.onload = () => resolve(window.XLSX);
    script.onerror = reject;
    document.head.append(script);
  });
}

/**
 * Decodes a CSV or text file. Thai Excel saves CSV as Windows-874 unless UTF-8 is chosen.
 * @param {ArrayBuffer} buffer
 */
function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-874').decode(buffer);
  }
}

if (!customElements.get('bulk-order')) {
  customElements.define('bulk-order', BulkOrder);
}
