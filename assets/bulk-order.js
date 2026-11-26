import { Component } from '@theme/component';
import { CartAddEvent } from '@theme/events';
import { formatMoney } from '@theme/money-formatting';
import { fetchStorefront, findVariantBySku, searchProductDetails } from '@theme/product-lookup';
import { looksLikeCode, parsePastedText, parseText, parseWorkbook } from '@theme/bulk-sheet-parser';

// Hotel RFQ workbooks run to a few hundred lines; beyond this, ask for smaller uploads.
const MAX_ROWS = 300;
// Parallel lookups per list; more trips predictive search rate limits for one visitor.
const CONCURRENCY = 4;
// Only the first few codes found in a description are tried as SKUs.
const MAX_SKU_CANDIDATES = 3;
// Name searches fetch the most results predictive search allows, then the best few are offered.
const NAME_SEARCH_LIMIT = 10;
const CHOICES_SHOWN = 3;
// When no search finds every word, this many single words are searched and their results pooled.
const SPLIT_WORDS = 4;
// Renders search results with SKUs and stock: sections/bulk-order-results.liquid.
const RESULTS_SECTION = 'bulk-order-results';
const COPIED_MS = 2000;
// Same threshold as product-finder's bulk match: a confident name match is picked for the customer.
const AUTO_MATCH_SCORE = 72;
// Below this, a result shares too little with the line to call it more than a low match.
const MEDIUM_MATCH_SCORE = 45;
// Near-equal results are different sizes of one product, so the customer has to choose between them.
const AUTO_MATCH_LEAD = 8;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'product', 'products', 'item', 'items', 'st', 'ss',
  'เครื่อง', 'สินค้า', 'รุ่น', 'แบบ', 'พร้อม', 'จำนวน', 'ขนาด', 'ใช้กับ',
]);
// Spec values compared between the request and a product; another value of the same kind is a conflict.
const SPEC_PATTERNS = /** @type {Array<[string, RegExp]>} */ ([
  ['power', /(?<![\d.])(\d+(?:\.\d+)?)\s*(kw|kilowatts?|w|watts?)\b/g],
  ['voltage', /(?<![\d.])(\d+(?:\.\d+)?)\s*(v|volts?)\b/g],
  ['capacity', /(?<![\d.])(\d+(?:\.\d+)?)\s*(l|ltr|litres?|liters?|ml)\b/g],
  ['length', /(?<![\d.])(\d+(?:\.\d+)?)\s*(mm|cm|inch|in|")(?![a-z])/g],
  ['weight', /(?<![\d.])(\d+(?:\.\d+)?)\s*(kg|g)\b/g],
  ['fraction', /(?<![\d.])(\d+)\s*\/\s*(\d+)(?![\d.])/g],
  ['tanks', /(?<![\d.])(\d+)\s*(?:x\s*)?(tanks?)\b/g],
  ['baskets', /(?<![\d.])(\d+)\s*(?:x\s*)?(baskets?)\b/g],
]);
// Thai units and quote marks, rewritten so the patterns above read them. \b doesn't work beside Thai letters.
const SPEC_SPELLINGS = /** @type {Array<[RegExp, string]>} */ ([
  [/มล\.?/g, 'ml '],
  [/ลิตร/g, 'l '],
  [/ซม\.?/g, 'cm '],
  [/กก\.?|กิโลกรัม/g, 'kg '],
  [/ถัง/g, 'tanks '],
  [/ตะกร้า/g, 'baskets '],
  [/[”″]/g, '"'],
]);
const MATERIALS = /** @type {Array<[string, RegExp]>} */ ([
  ['stainless', /\bst\/st\b|\bs\/s\b|\bstainless\b|\bss ?(?:304|316|201|430)\b|สแตนเลส|สเตนเลส/],
  ['polycarbonate', /\bpolycarbonated?\b|โพลีคาร์บอเนต/],
  ['aluminium', /\balu(?:minium|minum)?\b|อลูมิเนียม|อะลูมิเนียม/],
]);
// Shorthand that product titles spell out, so searching for it finds nothing. Materials are still compared.
const SEARCH_NOISE = /\b(?:st\/st|s\/s)(?=\s|$)/gi;
const THAI = /[\u0E00-\u0E7F]/;
const MEASUREMENT =
  /^\d+(?:\.\d+)?(?:mm|cm|m|kg|g|mg|l|ltr|ml|oz|w|kw|v|inch|in)(?:x\d+(?:\.\d+)?(?:mm|cm|m|kg|g|mg|l|ltr|ml|oz|w|kw|v|inch|in))*$/i;

/** @typedef {import('@theme/bulk-sheet-parser').BulkItem} BulkItem */
/** @typedef {import('@theme/bulk-sheet-parser').BulkSheet} BulkSheet */
/** @typedef {'loading' | 'matched' | 'choose' | 'missing' | 'unavailable' | 'failed'} RowState */
/**
 * A product offered for a line. Products are shaped like /products/<handle>.js, plus each variant's
 * `stock` when the search section supplied it.
 * @typedef {{ product: any, score: number, conflicts: number, exact: boolean, confident?: boolean }} Candidate
 */

/**
 * @typedef {object} BulkOrderRefs
 * @property {HTMLInputElement} file - Picks or receives a dropped spreadsheet.
 * @property {HTMLTextAreaElement} text - A pasted list, one product per line.
 * @property {HTMLElement} sheetPicker - Wraps the worksheet choice for multi-sheet workbooks.
 * @property {HTMLSelectElement} sheet - Which worksheet to match.
 * @property {HTMLElement} compact - Summary shown after the customer submits a list.
 * @property {HTMLElement} sourceSummary - File or pasted-list summary in the collapsed composer.
 * @property {HTMLElement} status - Announces parsing, matching and cart results.
 * @property {HTMLElement} results - Wraps the matched list.
 * @property {HTMLOListElement} list - One row per uploaded line.
 * @property {HTMLElement[]} filters - Buttons that narrow the list to one group of rows.
 * @property {HTMLElement} summary - How many rows are ready to add.
 * @property {HTMLElement} total - The price of every ready row.
 * @property {HTMLElement} actionStatus - Announces cart and download results beside their buttons.
 * @property {HTMLButtonElement} retryAll - Searches every failed row again.
 * @property {HTMLButtonElement} addButton - Adds every ready row to the cart.
 * @property {HTMLElement} addLabel - The add button's text.
 * @property {HTMLElement} cartLink - Shown after the list is added.
 * @property {HTMLTemplateElement} rowTemplate - Markup for one row.
 * @property {HTMLTemplateElement} candidateTemplate - Markup for one suggested product.
 * @property {HTMLElement} copyStatus - Announces copied text.
 */

/**
 * Matches an uploaded spreadsheet or pasted list to store products by SKU, or by name when a line
 * has no known SKU, and adds every matched line to the cart in one request.
 * @extends {Component<BulkOrderRefs>}
 */
class BulkOrder extends Component {
  requiredRefs = ['file', 'text', 'sheetPicker', 'sheet', 'compact', 'sourceSummary', 'status', 'results', 'list', 'filters', 'summary', 'total', 'actionStatus', 'retryAll', 'addButton', 'addLabel', 'cartLink', 'rowTemplate', 'candidateTemplate', 'copyStatus'];

  /** @type {Map<HTMLElement, { product: any, variant: any } | null>} */
  #rows = new Map();

  /** @type {WeakMap<Element, BulkItem>} */
  #items = new WeakMap();

  /** @type {WeakMap<Element, Candidate[]>} - Products offered for each row, best first. */
  #candidates = new WeakMap();

  /** @type {number | undefined} */
  #copiedTimer;

  /** @type {WeakMap<Element, number>} - The latest search per row, so an older answer can't replace it. */
  #searches = new WeakMap();

  /** @type {WeakMap<Element, { id: number, quantity: number }>} - What each row already put in the cart, so adding again can't double it. */
  #added = new WeakMap();

  /** @type {Map<string, Promise<{ product: any, variant: any } | null>>} */
  #skuLookups = new Map();

  #filter = 'all';

  /** @type {AbortController | null} - Stays set after matching, because retries belong to the same list. */
  #matching = null;

  /** @type {BulkSheet[]} */
  #sheets = [];

  /** @type {AbortController | null} */
  #adding = null;

  /** @type {'file' | 'text'} */
  #sourceType = 'text';

  #sourceName = '';

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#matching?.abort();
    this.#adding?.abort();
    clearTimeout(this.#copiedTimer);
  }

  /** @param {Event} event */
  readFile = async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.#sourceType = 'file';
    this.#sourceName = file.name;

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
    this.#sourceType = 'text';
    this.#sourceName = '';
    this.#showSheets([]);
    this.#match(parsePastedText(this.refs.text.value));
  };

  editInput = () => {
    this.#setComposerCollapsed(false);
    this.refs.results.hidden = true;
    this.#setStatus('');
    (this.#sourceType === 'file' ? this.refs.file : this.refs.text).focus();
  };

  /**
   * Picks a suggested product for its row, or puts it back when it's already picked.
   * @param {Event} event
   */
  selectCandidate = (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-index]') : null;
    const row = rowOf(button);
    const candidate = row && button instanceof HTMLElement ? this.#candidates.get(row)?.[Number(button.dataset.index)] : null;
    if (!row || !candidate) return;

    // A search still running for the row must not replace the customer's choice.
    this.#startSearch(row);
    delete row.dataset.guess;
    if (this.#rows.get(row)?.product.handle === candidate.product.handle) {
      this.#unselect(row);
    } else {
      this.#showMatch(row, candidate.product, preferredVariant(candidate.product));
    }
    this.#updateSummary();
    this.#setMatchStatus();
  };

  /** @param {Event} event */
  clearSelection = (event) => {
    const row = rowOf(event.target);
    if (!row) return;

    this.#startSearch(row);
    this.#unselect(row);
    this.#updateSummary();
    this.#setMatchStatus();
    // The clear button hides, so keep focus on the suggestions.
    const pick = field(row, 'pick');
    (pick ?? field(row, 'query'))?.focus();
  };

  /** @param {Event} event */
  confirmMatch = (event) => {
    const row = rowOf(event.target);
    const match = row ? this.#rows.get(row) : null;
    if (!row || !match || !row.dataset.guess) return;

    delete row.dataset.guess;
    this.#setRowState(row, 'matched');
    this.#updateSummary();
    this.#setMatchStatus();
  };

  /** @param {Event} event */
  copy = async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
    if (!(button instanceof HTMLElement) || !button.dataset.copy) return;

    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      return;
    }
    for (const copied of this.querySelectorAll('[data-copied]')) copied.removeAttribute('data-copied');
    button.dataset.copied = 'true';
    showStatus(this.refs.copyStatus, this.dataset.labelCopied, '');
    clearTimeout(this.#copiedTimer);
    this.#copiedTimer = setTimeout(() => {
      button.removeAttribute('data-copied');
      this.refs.copyStatus.textContent = '';
    }, COPIED_MS);
  };

  /** @param {Event} event */
  chooseVariant = (event) => {
    const select = event.target;
    const row = select instanceof HTMLSelectElement ? rowOf(select) : null;
    const match = row ? this.#rows.get(row) : null;
    if (!row || !match || !(select instanceof HTMLSelectElement)) return;

    const variant = match.product.variants.find((/** @type {any} */ item) => String(item.id) === select.value);
    if (variant) this.#showMatch(row, match.product, variant);
    this.#updateSummary();
    this.#setMatchStatus();
  };

  /** @param {Event} event */
  retryRow = (event) => {
    const row = rowOf(event.target);
    if (!row) return;

    this.#retry([row]);
    // The button hides while the row searches, so keep focus in the row.
    field(row, 'remove')?.focus();
  };

  changeQuantity = () => {
    this.#updateSummary();
    this.#setMatchStatus();
  };

  /** @param {Event} event */
  filterRows = (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-filter]') : null;
    if (button instanceof HTMLElement && button.dataset.filter) this.#showGroup(button.dataset.filter);
  };

  /**
   * Finds products for one line from what the customer typed: a SKU when it looks like one, otherwise by name.
   * @param {SubmitEvent} event
   */
  searchRow = async (event) => {
    event.preventDefault();
    const row = rowOf(event.target);
    const input = row ? field(row, 'query') : null;
    const signal = this.#matching?.signal;
    if (!row || !signal || !(input instanceof HTMLInputElement)) return;

    const isLatest = this.#startSearch(row);
    const outdated = () => signal.aborted || !isLatest();
    // A search that finds nothing keeps the row's earlier suggestions and choice.
    const leaveNote = (/** @type {string | undefined} */ note) => {
      this.#setRowState(row, /** @type {RowState} */ (row.dataset.state), note);
      this.#setStatus(note);
    };

    const query = input.value.trim();
    this.#setStatus(this.dataset.messageSearching);
    try {
      const match = looksLikeCode(query) ? await this.#lookupSku(query, true, signal) : null;
      if (outdated()) return;
      if (match) {
        this.#showExact(row, match.product, match.variant);
        this.#setStatus(fill(this.dataset.messageSearchFound, { count: 1 }));
        return;
      }

      const { products, partial } = await searchByName(query, signal);
      if (outdated()) return;
      if (!products.length) {
        leaveNote(this.dataset.messageRowNotFound);
        return;
      }

      delete row.dataset.guess;
      const spec = `${query} ${this.#items.get(row)?.spec ?? ''}`;
      this.#showCandidates(row, rankProducts(storeLanguage(query), products, spec, partial), partial);
      this.#setStatus(fill(this.dataset.messageSearchFound, { count: products.length }));
      field(row, 'pick')?.focus();
    } catch {
      if (!outdated()) leaveNote(this.dataset.messageRowError);
    } finally {
      if (!outdated()) this.#updateSummary();
    }
  };

  retryFailed = () => {
    this.#retry([...this.#rows.keys()].filter((row) => row.dataset.state === 'failed'));
  };

  /** @param {Event} event */
  removeRow = (event) => {
    const row = rowOf(event.target);
    if (!row) return;

    // Keep focus in the list so keyboard users can carry on removing rows.
    const neighbour = shownSibling(row, 'nextElementSibling') ?? shownSibling(row, 'previousElementSibling');
    row.remove();
    this.#rows.delete(row);
    this.#updateSummary();
    this.#setMatchStatus();
    const next = neighbour?.querySelector('[data-field="remove"]');
    if (next instanceof HTMLElement) next.focus();
    else this.refs.text.focus();
  };

  add = async () => {
    if (this.#adding) return;

    /** @type {Map<number, number>} */
    const quantities = new Map();
    for (const [row, match] of this.#rows) {
      const quantity = this.#quantityToAdd(row);
      if (!match?.variant.available || !quantity) continue;
      quantities.set(match.variant.id, (quantities.get(match.variant.id) ?? 0) + quantity);
    }
    if (!quantities.size) return;

    const { addButton, cartLink } = this.refs;
    const controller = new AbortController();
    this.#adding = controller;
    addButton.disabled = true;
    addButton.setAttribute('aria-busy', 'true');

    try {
      const { signal } = controller;
      const before = await readCart(signal);
      const refused = await this.#addLines([...quantities], signal);
      const after = await readCart(signal);
      const added = quantities.size - refused.length;

      for (const [id] of quantities) this.#recordAdded(id, after.added(before, id));
      // A refused line can still add part of its quantity, so compare the cart, not the count of whole lines.
      if (after.itemCount !== before.itemCount) {
        // Without sections in the event, the cart re-renders itself, which covers partly added lists too.
        this.dispatchEvent(new CartAddEvent({}, 'bulk-order', { source: 'bulk-order', itemCount: after.itemCount }));
        cartLink.hidden = false;
      }

      if (refused.length) {
        const counts = { added, refused: refused.length, total: quantities.size };
        this.#setActionStatus(fill(this.dataset.messagePartlyAdded, counts), 'error');
      } else {
        this.#setActionStatus(fill(this.dataset.messageAdded, { count: quantities.size }), 'success');
      }
    } catch {
      if (!controller.signal.aborted) this.#setActionStatus(this.dataset.messageAddError, 'error');
    } finally {
      if (this.#adding === controller) this.#adding = null;
      addButton.removeAttribute('aria-busy');
      this.#updateSummary();
    }
  };

  /**
   * Adds lines in one request, and returns those the cart refused. One line short of stock fails the whole
   * request but may leave others added, so the cart is read back and only what's missing is tried again,
   * in halves until each refused line is alone. Reading it back is what stops a line being added twice.
   * @param {Array<[number, number]>} lines - Variant ids and quantities.
   * @param {AbortSignal} signal
   * @returns {Promise<Array<[number, number]>>}
   */
  async #addLines(lines, signal) {
    if (!lines.length) return [];

    const before = await readCart(signal);
    const response = await fetchStorefront(Theme.routes.cart_add_url, signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: lines.map(([id, quantity]) => ({ id, quantity })) }),
    });
    if (response.ok) return [];
    if (response.status !== 422) throw new Error(`Cart request failed with ${response.status}`);
    if (lines.length === 1) return lines;

    const after = await readCart(signal);
    /** @type {Array<[number, number]>} */
    const missing = [];
    for (const [id, quantity] of lines) {
      const left = quantity - after.added(before, id);
      if (left > 0) missing.push([id, left]);
    }
    const middle = Math.ceil(missing.length / 2);
    const first = await this.#addLines(missing.slice(0, middle), signal);
    return [...first, ...(await this.#addLines(missing.slice(middle), signal))];
  }

  /**
   * Shares what the cart took of a variant between the rows that asked for it, in list order,
   * and marks the rows it didn't cover.
   * @param {number} id
   * @param {number} count
   */
  #recordAdded(id, count) {
    let left = Math.max(count, 0);
    for (const [row, match] of this.#rows) {
      if (match?.variant.id !== id) continue;

      const taken = Math.min(left, this.#quantityToAdd(row));
      left -= taken;
      const added = this.#quantityAdded(row) + taken;
      this.#added.set(row, { id, quantity: added });

      const wanted = rowQuantity(row);
      if (added < wanted) {
        row.dataset.short = 'true';
        this.#setRowState(row, 'matched', fill(this.dataset.messageRowShort, { added, wanted }));
      } else if (row.dataset.short) {
        delete row.dataset.short;
        this.#setRowState(row, 'matched');
      }
    }
  }

  /**
   * What's left to add for a row, after anything an earlier add put in the cart.
   * @param {Element} row
   */
  #quantityToAdd(row) {
    if (row instanceof HTMLElement && row.dataset.guess) return 0;
    return Math.max(rowQuantity(row) - this.#quantityAdded(row), 0);
  }

  /**
   * How much of the row's current variant is already in the cart. Choosing another variant starts from nothing.
   * @param {Element} row
   */
  #quantityAdded(row) {
    const added = this.#added.get(row);
    const match = row instanceof HTMLElement ? this.#rows.get(row) : null;
    return added && added.id === match?.variant.id ? added.quantity : 0;
  }

  /**
   * Makes this the row's current search, so an older answer can't replace it.
   * @param {Element} row
   * @returns {() => boolean} Whether the search is still the current one.
   */
  #startSearch(row) {
    const search = (this.#searches.get(row) ?? 0) + 1;
    this.#searches.set(row, search);
    return () => row.isConnected && this.#searches.get(row) === search;
  }

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

    this.refs.sourceSummary.textContent =
      this.#sourceType === 'file'
        ? fill(this.dataset.labelFileSource, { name: this.#sourceName, count: items.length })
        : fill(this.dataset.labelPastedSource, { count: items.length });
    this.#setComposerCollapsed(true);

    this.#matching?.abort();
    const controller = new AbortController();
    this.#matching = controller;

    const { list, results, cartLink, rowTemplate } = this.refs;
    this.#rows.clear();
    this.#skuLookups.clear();
    this.#showGroup('all');
    list.replaceChildren();
    cartLink.hidden = true;
    /** @type {HTMLElement[]} */
    const work = [];
    for (const [index, item] of items.entries()) {
      const fragment = /** @type {DocumentFragment} */ (rowTemplate.content.cloneNode(true));
      const row = fragment.querySelector('li');
      if (!row) continue;
      const source = field(row, 'source');
      if (source) {
        source.textContent = item.text || item.code;
        // Stored so a line keeps its number when others are removed or filtered out.
        source.dataset.line = String(index + 1);
      }
      const detail = field(row, 'source-detail');
      if (detail) {
        detail.textContent = [item.text ? item.code : '', item.spec].filter(Boolean).join(' · ');
        detail.hidden = !detail.textContent;
      }
      const query = field(row, 'query');
      if (query instanceof HTMLInputElement) query.value = storeLanguage(item.text || item.code);
      const quantity = field(row, 'quantity');
      if (quantity instanceof HTMLInputElement) quantity.value = String(item.quantity ?? '');
      this.#rows.set(row, null);
      this.#items.set(row, item);
      list.append(row);
      work.push(row);
    }
    results.hidden = false;
    this.#setStatus(fill(this.dataset.messageMatching, { total: items.length }));
    this.#updateSummary();

    await this.#resolveRows(work, controller.signal);
  }

  /** @param {Element[]} rows */
  async #retry(rows) {
    const signal = this.#matching?.signal;
    if (!signal || signal.aborted) return;

    const retrying = rows.filter((row) => row instanceof HTMLElement);
    for (const row of retrying) this.#setRowState(row, 'loading');
    this.#updateSummary();
    this.#setStatus(fill(this.dataset.messageMatching, { total: retrying.length }));
    await this.#resolveRows(retrying, signal);
  }

  /**
   * @param {HTMLElement[]} rows
   * @param {AbortSignal} signal
   */
  async #resolveRows(rows, signal) {
    const next = rows.values();
    const worker = async () => {
      for (const row of next) {
        if (signal.aborted) return;
        await this.#resolveRow(row, signal);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (signal.aborted) return;

    this.#setMatchStatus();
  }

  /**
   * Shares lookups between rows with the same code. Failures are dropped so a retry searches again.
   * @param {string} code
   * @param {boolean} tolerant
   * @param {AbortSignal} signal
   */
  #lookupSku(code, tolerant, signal) {
    const key = `${tolerant}:${code.toUpperCase()}`;
    let lookup = this.#skuLookups.get(key);
    if (!lookup) {
      lookup = findVariantBySku(code, signal, { tolerant });
      this.#skuLookups.set(key, lookup);
      lookup.catch(() => this.#skuLookups.delete(key));
    }
    return lookup;
  }

  /** @param {HTMLElement} row */
  #clearRow(row) {
    delete row.dataset.guess;
    this.#candidates.set(row, []);
    this.#renderCandidates(row);
  }

  /**
   * @param {HTMLElement} row
   * @param {AbortSignal} signal
   */
  async #resolveRow(row, signal) {
    const item = this.#items.get(row);
    if (!item || !row.isConnected) return;

    // The customer can search the row while it's still matching; their search wins.
    const isLatest = this.#startSearch(row);
    const outdated = () => signal.aborted || !isLatest();
    this.#clearRow(row);
    try {
      for (const { code, tolerant } of skuCandidates(item)) {
        const match = await this.#lookupSku(code, tolerant, signal);
        if (outdated()) return;
        if (match) {
          this.#showExact(row, match.product, match.variant);
          return;
        }
      }

      const value = item.text || item.code;
      const { products, partial } = await searchByName(value, signal);
      if (outdated()) return;
      if (!products.length) {
        this.#setRowState(row, 'missing', this.dataset.messageRowNotFound);
        return;
      }

      const ranked = rankProducts(storeLanguage(value), products, `${value} ${item.spec}`, partial);
      this.#showCandidates(row, ranked, partial);
      const [best] = ranked;
      if (best?.confident) {
        this.#showMatch(row, best.product, preferredVariant(best.product), this.dataset.messageRowGuess);
        row.dataset.guess = 'true';
        field(row, 'confirm')?.removeAttribute('hidden');
      }
    } catch {
      if (!outdated()) this.#setRowState(row, 'failed', this.dataset.messageRowError);
    } finally {
      if (!outdated()) this.#updateSummary();
    }
  }

  /**
   * Offers the product whose SKU the line names, already picked.
   * @param {HTMLElement} row
   * @param {any} product
   * @param {any} variant
   */
  #showExact(row, product, variant) {
    delete row.dataset.guess;
    this.#candidates.set(row, [{ product, score: 100, conflicts: 0, exact: true }]);
    this.#renderCandidates(row);
    this.#showMatch(row, product, variant);
  }

  /**
   * @param {HTMLElement} row
   * @param {Candidate[]} ranked
   * @param {boolean} partial - Whether the results only share some of the line's words.
   */
  #showCandidates(row, ranked, partial) {
    this.#candidates.set(row, ranked);
    this.#rows.set(row, null);
    this.#renderCandidates(row);
    this.#setRowState(row, 'choose', partial ? this.dataset.messagePartial : '');
  }

  /** @param {HTMLElement} row */
  #renderCandidates(row) {
    const candidates = this.#candidates.get(row) ?? [];
    const shown = candidates.slice(0, CHOICES_SHOWN);
    field(row, 'candidate-list')?.replaceChildren(...shown.map((candidate, index) => this.#candidateCard(candidate, index)));

    const count = field(row, 'candidates-count');
    if (count) count.textContent = fill(this.dataset.labelSuggested, { count: candidates.length });
    const more = field(row, 'more');
    if (more) {
      more.textContent = fill(this.dataset.labelMore, { count: candidates.length - shown.length });
      more.hidden = candidates.length <= shown.length;
    }
    this.#markPicked(row);
  }

  /**
   * @param {Candidate} candidate
   * @param {number} index
   */
  #candidateCard(candidate, index) {
    const fragment = /** @type {DocumentFragment} */ (this.refs.candidateTemplate.content.cloneNode(true));
    const card = /** @type {HTMLElement} */ (fragment.firstElementChild);
    const pick = field(card, 'pick');
    if (pick) pick.dataset.index = String(index);

    const score = field(card, 'score');
    if (score) score.textContent = candidate.exact ? this.dataset.labelExact ?? '' : `${candidate.score}%`;
    // The first is only "best" when there's something to compare it with.
    field(card, 'best')?.toggleAttribute('hidden', index > 0 || candidate.exact || !candidate.score);
    field(card, 'conflict')?.toggleAttribute('hidden', !candidate.conflicts);

    this.#fillCard(card, candidate.product, preferredVariant(candidate.product));
    return card;
  }

  /**
   * Shows a variant's details on a suggestion card.
   * @param {HTMLElement} card
   * @param {any} product
   * @param {any} variant
   */
  #fillCard(card, product, variant) {
    const image = field(card, 'image');
    const src = variant?.featured_image?.src ?? product.featured_image;
    if (image instanceof HTMLImageElement) {
      if (src) {
        const imageUrl = new URL(src, location.origin);
        imageUrl.searchParams.set('width', '192');
        image.src = imageUrl.href;
      } else {
        image.removeAttribute('src');
      }
      image.hidden = !src;
    }

    const sku = variant?.sku ?? '';
    const skuText = field(card, 'sku');
    if (skuText) skuText.textContent = sku || '–';
    const copySku = field(card, 'copy-sku');
    if (copySku) {
      copySku.dataset.copy = sku;
      copySku.hidden = !sku;
      copySku.setAttribute('aria-label', fill(this.dataset.labelCopySku, { sku }));
    }

    const title = field(card, 'title');
    if (title instanceof HTMLAnchorElement) {
      title.textContent = product.title;
      const url = product.url ?? `/products/${product.handle}`;
      title.href = variant?.id ? `${url}?variant=${variant.id}` : url;
    }
    const copyTitle = field(card, 'copy-title');
    if (copyTitle) copyTitle.dataset.copy = product.title;

    const meta = field(card, 'meta');
    if (meta) {
      meta.textContent = [product.vendor, product.type].filter(Boolean).join(' · ');
      meta.hidden = !meta.textContent;
    }

    // Quotation stores keep prices at 0, so a price only shows once there is one.
    const price = variant?.price ? this.#money(variant.price) : '';
    const priceText = field(card, 'price');
    if (priceText) {
      priceText.textContent = price;
      priceText.hidden = !price;
    }
    const stock = this.#stockText(variant);
    const stockText = field(card, 'stock');
    if (stockText) {
      stockText.textContent = stock;
      stockText.dataset.soldOut = String(!variant?.available);
    }

    const copyDetails = field(card, 'copy-details');
    if (copyDetails) {
      copyDetails.dataset.copy = [product.title, sku && `SKU: ${sku}`, product.vendor, price, stock]
        .filter(Boolean)
        .join('\n');
    }
    const pick = field(card, 'pick');
    if (pick) pick.dataset.title = product.title;
  }

  /**
   * Marks the picked suggestion and labels every pick button for what it will do.
   * @param {HTMLElement} row
   */
  #markPicked(row) {
    const match = this.#rows.get(row);
    const candidates = this.#candidates.get(row) ?? [];
    for (const pick of row.querySelectorAll('[data-field="pick"]')) {
      const card = pick.closest('.bulk-order__candidate');
      const candidate = candidates[Number(pick instanceof HTMLElement ? pick.dataset.index : -1)];
      if (!(pick instanceof HTMLElement) || !(card instanceof HTMLElement) || !candidate) continue;

      const picked = match?.product.handle === candidate.product.handle;
      card.toggleAttribute('data-picked', picked);
      pick.setAttribute('aria-pressed', String(picked));
      pick.textContent = (picked ? this.dataset.labelUnselect : this.dataset.labelSelect) ?? '';
      const label = picked ? this.dataset.labelUnselectProduct : this.dataset.labelSelectProduct;
      pick.setAttribute('aria-label', fill(label, { title: candidate.product.title }));
      // A picked card shows the chosen option's SKU, price and stock.
      this.#fillCard(card, candidate.product, picked && match ? match.variant : preferredVariant(candidate.product));
    }
    field(row, 'clear')?.toggleAttribute('hidden', !match);
  }

  /** @param {any} variant */
  #stockText(variant) {
    if (!variant?.available) return this.dataset.labelSoldOut ?? '';
    if (typeof variant.stock === 'number' && variant.stock > 0) return fill(this.dataset.labelStock, { count: variant.stock });
    return this.dataset.labelInStock ?? '';
  }

  /** @param {HTMLElement} row */
  #unselect(row) {
    this.#rows.set(row, null);
    delete row.dataset.short;
    this.#markPicked(row);
    const hasCandidates = Boolean(this.#candidates.get(row)?.length);
    this.#setRowState(row, hasCandidates ? 'choose' : 'missing', hasCandidates ? '' : this.dataset.messageRowNotFound);
  }

  /**
   * @param {HTMLElement} row
   * @param {any} product
   * @param {any} variant
   * @param {string} [note] - Shown under an available match, e.g. that it was matched by name.
   */
  #showMatch(row, product, variant, note = '') {
    // A row removed while it searched must not come back into the cart list.
    if (!row.isConnected) return;

    this.#rows.set(row, { product, variant });
    delete row.dataset.guess;
    delete row.dataset.short;
    this.#markPicked(row);

    const candidate = this.#candidates.get(row)?.find((item) => item.product.handle === product.handle);
    const picked = field(row, 'picked');
    if (picked) {
      const score = candidate && !candidate.exact ? fill(this.dataset.labelScore, { score: candidate.score, level: this.#level(candidate.score) }) : '';
      picked.textContent = [product.vendor, this.#stockText(variant), candidate?.exact ? this.dataset.labelExact : score]
        .filter(Boolean)
        .join(' | ');
    }

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
   * @param {RowState} state
   * @param {string} [note]
   */
  #setRowState(row, state, note = '') {
    row.dataset.state = state;
    const resolved = state === 'matched' || state === 'unavailable';
    const candidates = field(row, 'candidates');
    if (candidates) {
      candidates.hidden = state === 'loading' || state === 'failed' || !this.#candidates.get(row)?.length;
    }
    const picked = field(row, 'picked');
    if (picked) picked.hidden = !resolved || !picked.textContent;
    const variantPicker = field(row, 'variant-choose');
    if (variantPicker && !resolved) variantPicker.hidden = true;
    const noteElement = field(row, 'note');
    if (noteElement) {
      noteElement.textContent = note;
      noteElement.hidden = !note;
    }
    const retry = field(row, 'retry');
    if (retry) retry.hidden = state !== 'failed';
    const confirm = field(row, 'confirm');
    if (confirm) confirm.hidden = !resolved || !row.dataset.guess;
    if (!resolved && row.isConnected) {
      this.#rows.set(row, null);
      this.#markPicked(row);
    }
  }

  /** @param {number} score */
  #level(score) {
    if (score >= AUTO_MATCH_SCORE) return this.dataset.labelLevelHigh ?? '';
    return (score >= MEDIUM_MATCH_SCORE ? this.dataset.labelLevelMedium : this.dataset.labelLevelLow) ?? '';
  }

  #counts() {
    let ready = 0;
    let pending = 0;
    let choose = 0;
    let missing = 0;
    let guess = 0;
    let failed = 0;
    let noQuantity = 0;
    let total = 0;
    for (const [row, match] of this.#rows) {
      const quantity = rowQuantity(row);
      if (match?.variant.available && quantity) {
        if (row.dataset.guess) {
          guess += 1;
        } else {
          ready += 1;
          if (this.#quantityToAdd(row)) pending += 1;
          total += (match.variant.price ?? 0) * quantity;
        }
      } else if (match?.variant.available) noQuantity += 1;
      else if (row.dataset.state === 'choose') choose += 1;
      else if (row.dataset.state === 'failed') failed += 1;
      else if (row.dataset.state !== 'loading') missing += 1;
    }
    return { ready, pending, choose, missing, guess, failed, noQuantity, total };
  }

  /** @param {HTMLElement} row */
  #rowGroup(row) {
    const match = this.#rows.get(row);
    if (!match?.variant.available || !rowQuantity(row)) return 'action';
    return row.dataset.guess ? 'check' : 'ready';
  }

  /**
   * Rows are only regrouped here, so a row the customer just fixed doesn't vanish from under them.
   * @param {string} filter
   */
  #showGroup(filter) {
    this.#filter = filter;
    for (const button of this.refs.filters) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    for (const row of this.#rows.keys()) row.hidden = filter !== 'all' && this.#rowGroup(row) !== filter;
  }

  /** @param {number} value - Minor units, as in the product JSON. */
  #money(value) {
    return formatMoney(value, this.dataset.moneyFormat ?? '{{amount}}', this.dataset.currency ?? '');
  }

  #updateSummary() {
    const { summary, addButton, addLabel, results, retryAll, filters, total } = this.refs;
    const { ready, pending, failed, guess, total: price } = this.#counts();
    summary.textContent = fill(this.dataset.labelSummary, { ready, total: this.#rows.size });
    addLabel.textContent = fill(this.dataset.labelAdd, { count: pending });
    addButton.disabled = pending === 0 || Boolean(this.#adding);
    total.textContent = fill(this.dataset.labelTotal, { total: this.#money(price) });
    total.hidden = !price;

    /** @type {Record<string, number>} */
    const groups = { all: this.#rows.size, action: this.#rows.size - ready - guess, check: guess, ready };
    for (const button of filters) {
      const count = groups[button.dataset.filter ?? ''] ?? 0;
      const label = button.querySelector('[data-count]');
      if (label) label.textContent = String(count);
      button.toggleAttribute('disabled', !count && button.dataset.filter !== this.#filter);
    }

    retryAll.textContent = fill(this.dataset.labelRetryAll, { count: failed });
    // Hiding the focused button would drop keyboard users back to the top of the page.
    if (!failed && document.activeElement === retryAll) (addButton.disabled ? this.refs.text : addButton).focus();
    retryAll.hidden = !failed;
    if (!this.#rows.size) results.hidden = true;
  }

  #setMatchStatus() {
    const { ready, choose, missing, guess, failed, noQuantity } = this.#counts();
    const messages = [fill(this.dataset.messageMatched, { ready, choose, missing, guess, total: this.#rows.size })];
    if (failed) messages.push(fill(this.dataset.messageFailed, { failed }));
    if (noQuantity) messages.push(fill(this.dataset.messageNoQuantity, { count: noQuantity }));
    this.#setStatus(messages.join(' '));
  }

  /**
   * @param {string | undefined} message
   * @param {'' | 'success' | 'error'} [tone] - Colors the message; screen readers hear it either way.
   */
  #setStatus(message, tone = '') {
    showStatus(this.refs.status, message, tone);
  }

  /**
   * Long lists push the main status off screen, so results of the footer's buttons appear beside them.
   * @param {string | undefined} message
   * @param {'' | 'success' | 'error'} [tone]
   */
  #setActionStatus(message, tone = '') {
    showStatus(this.refs.actionStatus, message, tone);
  }

  /** @param {boolean} collapsed */
  #setComposerCollapsed(collapsed) {
    const card = this.querySelector('.bulk-order__card');
    if (!(card instanceof HTMLElement)) return;
    card.toggleAttribute('data-collapsed', collapsed);
    this.refs.compact.hidden = !collapsed;
  }
}

/**
 * The bulk order row an element sits in. Suggestion cards are list items too, so `closest('li')` won't do.
 * @param {EventTarget | Element | null} element
 * @returns {HTMLElement | null}
 */
function rowOf(element) {
  const row = element instanceof Element ? element.closest('.bulk-order__row') : null;
  return row instanceof HTMLElement ? row : null;
}

/**
 * The variant to offer first: the first that can be bought.
 * @param {any} product
 */
function preferredVariant(product) {
  return product.variants?.find((/** @type {any} */ variant) => variant.available) ?? product.variants?.[0];
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
 * @param {HTMLElement} element
 * @param {string | undefined} message
 * @param {'' | 'success' | 'error'} tone
 */
function showStatus(element, message, tone) {
  element.textContent = message ?? '';
  if (tone) element.dataset.tone = tone;
  else delete element.dataset.tone;
}

/**
 * The row's quantity, or 0 while it's blank.
 * @param {Element} row
 */
function rowQuantity(row) {
  const input = field(row, 'quantity');
  const quantity = input instanceof HTMLInputElement ? Math.round(Number(input.value)) : 0;
  return quantity > 0 ? quantity : 0;
}

/**
 * @param {Element} row
 * @param {'nextElementSibling' | 'previousElementSibling'} direction
 */
function shownSibling(row, direction) {
  let sibling = row[direction];
  while (sibling instanceof HTMLElement && sibling.hidden) sibling = sibling[direction];
  return sibling;
}

/**
 * Reads how many of each variant the cart holds.
 * @param {AbortSignal} signal
 */
async function readCart(signal) {
  const response = await fetchStorefront(`${Theme.routes.cart_url}.js`, signal);
  if (!response.ok) throw new Error(`Cart request failed with ${response.status}`);

  const cart = await response.json();
  /** @type {Map<number, number>} */
  const quantities = new Map();
  for (const { variant_id: id, quantity } of cart.items) quantities.set(id, (quantities.get(id) ?? 0) + quantity);

  return {
    itemCount: cart.item_count,
    quantities,
    /**
     * @param {{ quantities: Map<number, number> }} earlier
     * @param {number} id
     */
    added: (earlier, id) => (quantities.get(id) ?? 0) - (earlier.quantities.get(id) ?? 0),
  };
}

/**
 * Searches by name, widening the query until something is found. Predictive search needs every word to
 * match, so when no query finds anything, each word is searched alone and the results are pooled for
 * ranking to put those sharing the most words first.
 * @param {string} value
 * @param {AbortSignal} signal
 * @returns {Promise<{ products: any[], partial: boolean }>}
 */
async function searchByName(value, signal) {
  const search = (/** @type {string} */ query) =>
    searchProductDetails(query, signal, { sectionId: RESULTS_SECTION, limit: NAME_SEARCH_LIMIT });

  const queries = nameQueries(value);
  for (const query of queries) {
    const products = await search(query);
    if (products.length || signal.aborted) return { products, partial: false };
  }

  /** @type {Map<string, any>} */
  const pooled = new Map();
  const words = nameWords(value).filter((word) => word.length > 2 && !queries.includes(word));
  for (const word of [...new Set(words)].slice(0, SPLIT_WORDS)) {
    const products = await search(word);
    if (signal.aborted) break;
    for (const product of products) if (!pooled.has(product.handle)) pooled.set(product.handle, product);
  }
  return { products: [...pooled.values()], partial: true };
}

/**
 * Replaces `[name]` tokens left by the Liquid `t` filter.
 * @param {string | undefined} template
 * @param {Record<string, number | string>} values
 */
function fill(template, values) {
  return (template ?? '').replace(/\[(\w+)\]/g, (token, name) => (name in values ? String(values[name]) : token));
}

/**
 * Lists the codes to try for a line. Only cells that are clearly a code may match a SKU loosely.
 * @param {BulkItem} item
 */
function skuCandidates(item) {
  const tokens = item.text.match(/[A-Za-z0-9]+(?:[-/.][A-Za-z0-9]+)*/g) ?? [];
  const fromText = tokens.filter(
    (token) => /[A-Za-z]/.test(token) && /\d/.test(token) && token.length >= 4 && !MEASUREMENT.test(token)
  );
  const whole = looksLikeCode(item.text) ? [item.text] : [];
  const unique = new Map();
  for (const code of [item.code, ...whole, ...fromText]) {
    if (!code || unique.has(code.toUpperCase())) continue;
    unique.set(code.toUpperCase(), { code, tolerant: code === item.code || whole.includes(code) });
  }
  return [...unique.values()].slice(0, MAX_SKU_CANDIDATES);
}

/**
 * Keeps the English part of a line like "เครื่องปั่นมือถือ — Immersion Blender", because product titles are
 * in the store's primary language. A line with no English stays whole; search can still match its Thai.
 * @param {string} value
 */
function storeLanguage(value) {
  const words = value.split(/\s+/).filter((word) => !THAI.test(word) && /[A-Za-z0-9]/.test(word));
  return words.some((word) => /[A-Za-z]{3}/.test(word)) ? words.join(' ') : value;
}

/**
 * Predictive search needs every term to match, so long descriptions are cut to their leading words,
 * then cut again when the longer query finds nothing. Fractions stay because they name the product,
 * like GN 1/1, but measurements go: titles write them differently, and ranking compares them instead.
 * @param {string} value
 */
function nameQueries(value) {
  const words = nameWords(value);
  return [...new Set([words.slice(0, 4).join(' '), words.slice(0, 2).join(' ')])].filter(Boolean);
}

/**
 * The searchable words of a line, in order.
 * @param {string} value
 */
function nameWords(value) {
  return storeLanguage(value)
    .replace(SEARCH_NOISE, ' ')
    .replace(/[()[\],;:"'®™~*”″“—–]/g, ' ')
    .split(/\s+/)
    .filter(
      (word) => /^\d+\/\d+$/.test(word) || (word.length > 1 && !/^[\d.,/-]+$/.test(word) && !MEASUREMENT.test(word))
    );
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
  let text = value.toLowerCase();
  for (const [pattern, spelling] of SPEC_SPELLINGS) text = text.replace(pattern, spelling);

  const found = new Set();
  for (const [material, pattern] of MATERIALS) {
    if (pattern.test(text)) found.add(`material:${material}`);
  }
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
      else if (unit === 'kw' || unit.startsWith('kilowatt') || unit === 'kg' || (kind === 'capacity' && unit !== 'ml')) {
        number *= 1000;
      }
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
 * @param {string} [specText] - Extra text to read specs from, which adds no required keywords.
 * @param {boolean} [partial] - Results pooled from single-word searches are only ever offered, never picked.
 * @returns {Candidate[]}
 */
function rankProducts(query, products, specText = '', partial = false) {
  const queryWords = keywords(query);
  const queryText = normalizeKeyword(query);
  const querySpecs = specs(`${query} ${specText}`);

  const ranked = products
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
      // On equal scores, fewer unrequested words is closer: "GN pan" before "Perforated GN pan".
      const extraWords = keywords(product.title).filter((word) => !queryWords.includes(word)).length;
      return { product, score, position, extraWords, conflicts: conflicts.length, exact: false, confident: false };
    })
    .sort((a, b) => b.score - a.score || a.extraWords - b.extraWords || a.position - b.position);

  const [best, next] = ranked;
  if (best) {
    best.confident =
      !partial &&
      // One word, like "Wrap" or "Tweezer", is too broad to pick for the customer however well it scores.
      queryWords.length > 1 &&
      best.score >= AUTO_MATCH_SCORE &&
      !best.conflicts &&
      (!next || best.score - next.score >= AUTO_MATCH_LEAD);
  }
  return ranked;
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
