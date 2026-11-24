import { Component } from '@theme/component';

/** Channel difference from the background colour that still counts as background (JPEG noise). */
const BACKGROUND_TOLERANCE = 18;
/** Pixels with lower alpha than this count as background. */
const ALPHA_THRESHOLD = 16;
/** How long the success / error state stays visible. */
const FEEDBACK_MS = 2000;

/**
 * Copies a product image to the clipboard as PNG with its plain (white) margin trimmed off.
 *
 * The original file is decoded at full resolution and only cropped — pixels are copied 1:1,
 * never resampled — so the result keeps every detail of the source image.
 *
 * @typedef {object} Refs
 * @property {HTMLButtonElement} button
 * @property {HTMLElement} [status]
 *
 * @extends {Component<Refs>}
 */
class CopyProductImage extends Component {
  requiredRefs = ['button'];

  /** @type {number | undefined} */
  #resetTimer;

  connectedCallback() {
    super.connectedCallback();

    // The Async Clipboard API with images needs a secure context and ClipboardItem.
    if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      this.hidden = true;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#resetTimer);
  }

  /**
   * Click handler for the copy button.
   * @param {MouseEvent} event
   */
  copy(event) {
    // Keep the click from reaching the slide, which would open the zoom dialog.
    event.stopPropagation();
    event.preventDefault();

    const src = this.dataset.src;
    if (!src || this.dataset.state === 'loading') return;

    this.#setState('loading');

    // The ClipboardItem must be created synchronously inside the click (Safari requirement),
    // so hand it a promise for the PNG instead of awaiting first.
    const item = new ClipboardItem({ 'image/png': trimmedPng(src) });

    navigator.clipboard.write([item]).then(
      () => this.#setState('success'),
      (error) => {
        console.error('Copy image failed', error);
        this.#setState('error');
      }
    );
  }

  /** @param {'loading' | 'success' | 'error'} state */
  #setState(state) {
    clearTimeout(this.#resetTimer);
    this.dataset.state = state;

    const { status, button } = this.refs;
    button.setAttribute('aria-busy', String(state === 'loading'));

    if (state === 'loading') return;

    if (status) {
      status.textContent = (state === 'success' ? this.dataset.successText : this.dataset.errorText) ?? '';
    }

    this.#resetTimer = window.setTimeout(() => {
      delete this.dataset.state;
      if (status) status.textContent = '';
    }, FEEDBACK_MS);
  }
}

/**
 * Downloads the image, finds the bounding box of everything that differs from the
 * background colour, and returns that region as a lossless PNG.
 * @param {string} src
 * @returns {Promise<Blob>}
 */
async function trimmedPng(src) {
  const url = new URL(src, window.location.href);
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`Image request failed: ${response.status}`);

  const bitmap = await createImageBitmap(await response.blob());

  try {
    const { width, height } = bitmap;
    const source = createCanvas(width, height);
    const sourceContext = source.getContext('2d', { willReadFrequently: true });
    if (!sourceContext) throw new Error('Canvas unavailable');

    sourceContext.drawImage(bitmap, 0, 0);
    const box = contentBox(sourceContext.getImageData(0, 0, width, height));

    const output = createCanvas(box.width, box.height);
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new Error('Canvas unavailable');

    // Same-size draw: a straight pixel copy of the cropped region, no scaling.
    outputContext.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);

    return await canvasToPng(output);
  } finally {
    bitmap.close();
  }
}

/**
 * @param {ImageData} imageData
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function contentBox({ data, width, height }) {
  const background = backgroundColor(data, width, height);

  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    let offset = y * width * 4;

    for (let x = 0; x < width; x++, offset += 4) {
      if (!isContent(data, offset, background)) continue;

      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }

  // Blank image: keep it whole rather than producing an empty copy.
  if (right < 0) return { x: 0, y: 0, width, height };

  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Uses the four corners to decide the background colour; falls back to white.
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {{ r: number, g: number, b: number, transparent: boolean }}
 */
function backgroundColor(data, width, height) {
  const corners = [0, width - 1, (height - 1) * width, height * width - 1].map((index) => index * 4);
  const transparent = corners.every((offset) => (data[offset + 3] ?? 255) < ALPHA_THRESHOLD);

  let r = 0;
  let g = 0;
  let b = 0;
  for (const offset of corners) {
    r += data[offset] ?? 255;
    g += data[offset + 1] ?? 255;
    b += data[offset + 2] ?? 255;
  }

  return { r: r / 4, g: g / 4, b: b / 4, transparent };
}

/**
 * @param {Uint8ClampedArray} data
 * @param {number} offset
 * @param {{ r: number, g: number, b: number, transparent: boolean }} background
 */
function isContent(data, offset, background) {
  const alpha = data[offset + 3] ?? 255;
  if (alpha < ALPHA_THRESHOLD) return false;
  if (background.transparent) return true;

  return (
    Math.abs((data[offset] ?? 0) - background.r) > BACKGROUND_TOLERANCE ||
    Math.abs((data[offset + 1] ?? 0) - background.g) > BACKGROUND_TOLERANCE ||
    Math.abs((data[offset + 2] ?? 0) - background.b) > BACKGROUND_TOLERANCE
  );
}

/**
 * OffscreenCanvas where available, a detached <canvas> otherwise (older Safari).
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvas | HTMLCanvasElement}
 */
function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * @param {OffscreenCanvas | HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
function canvasToPng(canvas) {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

if (!customElements.get('copy-product-image')) {
  customElements.define('copy-product-image', CopyProductImage);
}
