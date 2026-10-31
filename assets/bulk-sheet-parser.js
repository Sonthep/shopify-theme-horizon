// Ported from product-finder's src/lib/bulk-sheet-parser.ts, which is tuned to customer RFQ
// workbooks (hotel OSE lists, two-row headers, supplier quotation templates). Keep them in step.

/** @typedef {string | number | boolean | Date | null | undefined} CellValue */
/** @typedef {{ code: string, text: string, quantity: number }} BulkItem */
/** @typedef {{ name: string, items: BulkItem[] }} BulkSheet */

// Header rows are looked for this far down; RFQs often open with a title and customer block.
const HEADER_SCAN_ROWS = 30;

const NAME_HEADERS = new Set([
  'product', 'productname', 'oseitem', 'oseitemname', 'name', 'item', 'itemname', 'description',
  'รายการ', 'สินค้า', 'ชื่อสินค้า',
]);
const QUANTITY_HEADERS = new Set(['qty', 'quantity', 'amount', 'total', 'จำนวน']);
const SPEC_HEADERS = new Set([
  'spec', 'skuspecification', 'skuspec', 'specification', 'description', 'attribute', 'details', 'detail',
  'รายละเอียด', 'สเปก', 'descriptionspecification',
]);
const BILLNAME_HEADERS = new Set(['billname', 'billingname', 'billto', 'suppliername']);
const SKU_HEADERS = new Set([
  'sku', 'productsku', 'itemsku', 'productcode', 'itemcode', 'goodcode', 'ic', 'code', 'partno', 'partnumber',
  'รหัส', 'รหัสสินค้า',
]);
const BILLNAME_SKU_HEADERS = new Set(['billnamesku']);

const CODE_LIKE = /^[A-Za-z0-9][A-Za-z0-9\-/.]*$/;

/** @param {CellValue} value */
function cleanCell(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** @param {CellValue} value */
function normalizeHeader(value) {
  return cleanCell(value)
    .toLowerCase()
    .replace(/[\s_.\-/]+/g, '')
    .replace(/[^a-z0-9฀-๿]/g, '');
}

/**
 * @param {CellValue[]} row
 * @param {Set<string>} headers
 * @param {number} [excludedIndex]
 */
function findColumn(row, headers, excludedIndex = -1) {
  return row.findIndex((cell, index) => index !== excludedIndex && headers.has(normalizeHeader(cell)));
}

/** @param {CellValue[][]} rows */
function findHeader(rows) {
  /** @type {{ index: number, name: number, billName: number, sku: number, quantity: number, spec: number, score: number } | null} */
  let best = null;

  const candidateRows = rows.slice(0, HEADER_SCAN_ROWS);
  for (let index = 0; index < candidateRows.length; index += 1) {
    const row = candidateRows[index];
    const nextRow = candidateRows[index + 1] || [];
    const hasDetailedQuantity = findColumn(nextRow, QUANTITY_HEADERS) >= 0;
    const hasDirectQuantity = findColumn(row, QUANTITY_HEADERS) >= 0;
    const name = findColumn(row, NAME_HEADERS);
    const billName = findColumn(row, BILLNAME_HEADERS);
    const combinedBillNameSku = findColumn(row, BILLNAME_SKU_HEADERS);
    const skuColumn = findColumn(row, SKU_HEADERS, billName);
    const sku = skuColumn >= 0 ? skuColumn : combinedBillNameSku;
    if (name < 0 && billName < 0 && sku < 0) continue;
    const quantity = hasDirectQuantity ? findColumn(row, QUANTITY_HEADERS) : findColumn(nextRow, QUANTITY_HEADERS);
    if (quantity < 0) continue;
    const spec = row.findIndex((cell) => SPEC_HEADERS.has(normalizeHeader(cell)));
    // A header may use "Description" for both the customer item and its specification.
    // In that case, use the second occurrence as specification.
    const resolvedSpec =
      spec === name ? row.findIndex((cell, column) => column > name && SPEC_HEADERS.has(normalizeHeader(cell))) : spec;
    const score =
      Number(name >= 0) * 3 +
      Number(billName >= 0 || combinedBillNameSku >= 0) * 3 +
      Number(sku >= 0) * 3 +
      Number(quantity >= 0) * 2 +
      Number(resolvedSpec >= 0) +
      Number(hasDetailedQuantity) * 4;
    // Prefer the most complete header when workbooks repeat labels across merged header rows.
    // In tie cases, the lower row usually contains the actual column labels (for example QTY).
    if (!best || score >= best.score) {
      best = {
        index: hasDetailedQuantity && !hasDirectQuantity ? index + 1 : index,
        name,
        billName: billName >= 0 ? billName : combinedBillNameSku,
        sku,
        quantity,
        spec: resolvedSpec,
        score,
      };
    }
  }

  return best;
}

/**
 * The supplier quotation template has customer columns on rows 1-2, then supplier item columns
 * (MODEL holds our SKU) on row 3. Detect it by the paired MODEL/DESCRIPTION headers.
 * @param {CellValue[][]} rows
 */
function findSupplierQuotationHeader(rows) {
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    const row = rows[index];
    const model = row.findIndex((cell) => normalizeHeader(cell) === 'model');
    const supplierDescription = row.findIndex(
      (cell, column) => column > model && normalizeHeader(cell) === 'description'
    );
    if (model < 0 || supplierDescription < 0) continue;

    const customerHeader = rows
      .slice(0, index)
      .findIndex((candidate) => candidate.some((cell) => normalizeHeader(cell) === 'oseitem'));
    if (customerHeader < 0) continue;

    // OSE ITEM is a section label in this template; DESCRIPTION is the customer's item name.
    const name = rows[customerHeader].findIndex((cell) => normalizeHeader(cell) === 'description');
    const qty = rows.slice(0, index).findIndex((candidate) => candidate.some((cell) => normalizeHeader(cell) === 'qty'));
    const quantity = findColumn(qty >= 0 ? rows[qty] : [], QUANTITY_HEADERS);
    if (name < 0 || quantity < 0) continue;

    return { index: customerHeader, name, billName: -1, sku: model, quantity, spec: name, supplierRow: index };
  }
  return null;
}

/**
 * @param {CellValue[]} row
 * @param {{ name: number, billName: number, sku: number, quantity: number, spec: number }} header
 */
function isSectionRow(row, header) {
  const value = (/** @type {number} */ column) => (column >= 0 ? cleanCell(row[column]) : '');
  const populated = row.filter((cell) => cleanCell(cell)).length;
  return (
    (!value(header.name) && !value(header.billName) && !value(header.sku) && !value(header.spec)) ||
    (!value(header.quantity) && populated === 1)
  );
}

/**
 * Reads the item lines of one worksheet, or returns null when it has no recognisable header.
 * @param {CellValue[][]} rows
 * @returns {BulkItem[] | null}
 */
export function parseSheetRows(rows) {
  const supplierHeader = findSupplierQuotationHeader(rows);
  const header = supplierHeader || findHeader(rows);
  if (!header) return null;

  /** @type {BulkItem[]} */
  const items = [];
  rows.slice(header.index + 1).forEach((row, offset) => {
    const rowIndex = header.index + 1 + offset;
    if (supplierHeader) {
      if (rowIndex <= supplierHeader.supplierRow || !cleanCell(row[header.name])) return;
    } else if (isSectionRow(row, header)) return;

    const name = header.name >= 0 ? cleanCell(row[header.name]) : '';
    const billName = header.billName >= 0 ? cleanCell(row[header.billName]) : '';
    const rawSku = header.sku >= 0 ? cleanCell(row[header.sku]) : '';
    const sku = rawSku === '-' || rawSku === '#N/A' ? '' : rawSku;
    const spec = header.spec >= 0 ? cleanCell(row[header.spec]) : '';
    const sourceName = name || billName || sku || spec;
    if (!sourceName || /^\d+(?:\.\d+)?$/.test(sourceName)) return;

    const rawQuantity = header.quantity >= 0 ? Number(String(row[header.quantity] ?? '').replace(/,/g, '')) : 1;
    items.push({
      code: sku,
      text: [billName, sourceName === sku ? '' : sourceName].filter(Boolean).join(' '),
      quantity: Number.isFinite(rawQuantity) && rawQuantity > 0 ? Math.max(1, Math.round(rawQuantity)) : 1,
    });
  });
  return items;
}

/**
 * Parses each worksheet and keeps those with item lines. A sheet without a header row falls back
 * to the plain list rules used for pasted text.
 * @param {Array<{ name: string, rows: CellValue[][] }>} sheets
 * @returns {BulkSheet[]}
 */
export function parseWorkbook(sheets) {
  return sheets
    .map(({ name, rows }) => ({ name: name.trim() || 'Sheet', items: parseSheetRows(rows) ?? parseList(rows) }))
    .filter((sheet) => sheet.items.length);
}

/** @param {string} value */
function isQuantity(value) {
  return /^\d+(?:[.,]\d+)?$/.test(value.trim());
}

/** @param {string} value */
export function looksLikeCode(value) {
  return CODE_LIKE.test(value) && /\d/.test(value);
}

/**
 * Reads a list without headers: a trailing number is the quantity and a leading code-like cell is the SKU.
 * @param {CellValue[][]} rows
 * @returns {BulkItem[]}
 */
export function parseList(rows) {
  /** @type {BulkItem[]} */
  const items = [];
  for (const row of rows) {
    const cells = row.map(cleanCell).filter(Boolean);
    if (!cells.length) continue;
    let quantity = 1;
    if (cells.length > 1 && isQuantity(cells[cells.length - 1])) {
      quantity = Math.max(1, Math.round(Number((cells.pop() ?? '').replace(/,/g, ''))) || 1);
    }
    const code = cells.length > 1 && looksLikeCode(cells[0]) ? cells.shift() ?? '' : '';
    items.push({ code, text: cells.join(' '), quantity });
  }
  return items;
}

/**
 * Splits pasted text into rows. Tabs come from copying Excel cells; commas or semicolons from CSV.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseText(text) {
  const clean = text.replace(/^﻿/, '');
  const delimiter = clean.includes('\t')
    ? '\t'
    : /[,;]/.test(clean)
      ? count(clean, ',') >= count(clean, ';')
        ? ','
        : ';'
      : '';
  if (!delimiter) {
    // "CODE 5" per line: a trailing number after a code is the quantity.
    return clean.split(/\r?\n/).map((line) => {
      const match = line.trim().match(/^(\S+)\s+(\d+(?:[.,]\d+)?)$/);
      return match && looksLikeCode(match[1]) ? [match[1], match[2]] : [line];
    });
  }

  /** @type {string[][]} */
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (clean[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && clean[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/**
 * Items from pasted text: header rules when the text has a header row, plain list rules otherwise.
 * @param {string} text
 */
export function parsePastedText(text) {
  const rows = parseText(text);
  return parseSheetRows(rows) ?? parseList(rows);
}

/**
 * @param {string} text
 * @param {string} char
 */
function count(text, char) {
  return text.split(char).length - 1;
}
