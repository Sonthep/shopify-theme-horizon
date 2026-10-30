import { Component } from '@theme/component';
import { CartAddEvent } from '@theme/events';

// The same code is ignored for this long so a label held in view is not looked up again.
const REPEAT_SCAN_MS = 3000;
// Decoding every frame drains phone batteries; a few reads per second feel instant.
const SCAN_INTERVAL_MS = 200;
// Predictive search can rank other products above an exact SKU, so check several.
const SEARCH_LIMIT = 5;
// Labels carry the SKU as a QR code or a linear barcode, usually Code 128.
const DETECTOR_FORMATS = ['qr_code', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'];
const ZXING_FORMATS = ['QR_CODE', 'CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF'];
// Frame width handed to ZXing; wide enough for thin bars, small enough to stay fast.
const DECODE_WIDTH = 960;

/**
 * @typedef {object} ScanToCartRefs
 * @property {HTMLButtonElement} cameraButton - Starts or stops the camera.
 * @property {HTMLElement} viewfinder - Wraps the video while the camera runs.
 * @property {HTMLVideoElement} video - Shows the camera stream.
 * @property {HTMLFormElement} form - Looks up a typed product code.
 * @property {HTMLInputElement} sku - The typed or scanned product code.
 * @property {HTMLElement} status - Announces lookup and cart results.
 * @property {HTMLElement} result - The matched product card.
 * @property {HTMLImageElement} image - The matched product image.
 * @property {HTMLElement} title - The matched product title.
 * @property {HTMLElement} code - The matched product SKU.
 * @property {HTMLInputElement} quantity - How many units to add.
 * @property {HTMLButtonElement} addButton - Adds the matched variant to the cart.
 */

/**
 * Finds a product by the SKU in its QR code or barcode, or a typed SKU, and adds it to the cart.
 * Uses the browser's BarcodeDetector when it reads both, otherwise loads ZXing.
 * @extends {Component<ScanToCartRefs>}
 */
class ScanToCart extends Component {
  requiredRefs = ['cameraButton', 'viewfinder', 'video', 'form', 'sku', 'status', 'result', 'image', 'title', 'code', 'quantity', 'addButton'];

  /** @type {MediaStream | null} */
  #stream = null;

  /** @type {((source: HTMLVideoElement) => Promise<string>) | null} */
  #decode = null;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #scanTimer;

  #lastCode = '';
  #lastCodeAt = 0;

  /** @type {AbortController | null} */
  #lookup = null;

  /** @type {AbortController | null} */
  #adding = null;

  /** @type {number | null} */
  #variantId = null;

  /** @type {AbortController | null} */
  #pageEvents = null;

  connectedCallback() {
    super.connectedCallback();
    this.#pageEvents?.abort();
    this.#pageEvents = new AbortController();
    // Release the camera when the tab is hidden; a running camera keeps the phone's indicator on.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) this.#stopCamera();
      },
      { signal: this.#pageEvents.signal }
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#pageEvents?.abort();
    this.#pageEvents = null;
    this.#stopCamera();
    this.#lookup?.abort();
    this.#adding?.abort();
  }

  toggleCamera = async () => {
    if (this.#stream) {
      this.#stopCamera();
      return;
    }

    const { cameraButton, video, viewfinder } = this.refs;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.#setStatus(this.dataset.messageCameraUnavailable);
      return;
    }

    cameraButton.disabled = true;
    try {
      this.#decode ??= await this.#createDecoder();
      this.#stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = this.#stream;
      await video.play();
      viewfinder.hidden = false;
      cameraButton.setAttribute('aria-pressed', 'true');
      cameraButton.textContent = this.dataset.labelStop ?? '';
      this.#setStatus(this.dataset.messageHint);
      this.#scheduleScan();
    } catch (error) {
      this.#stopCamera();
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.#setStatus(denied ? this.dataset.messageCameraDenied : this.dataset.messageCameraUnavailable);
    } finally {
      cameraButton.disabled = false;
    }
  };

  /** @param {SubmitEvent} event */
  find = (event) => {
    event.preventDefault();
    const code = this.refs.sku.value.trim();
    if (code) this.#findProduct(code);
  };

  add = async () => {
    if (this.#adding || this.#variantId === null) return;

    const { addButton, quantity } = this.refs;
    const sections = new Set();
    for (const component of document.querySelectorAll('cart-items-component')) {
      if (component instanceof HTMLElement && component.dataset.sectionId) sections.add(component.dataset.sectionId);
    }

    const controller = new AbortController();
    this.#adding = controller;
    addButton.disabled = true;
    addButton.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          items: [{ id: this.#variantId, quantity: Math.max(1, Number(quantity.value) || 1) }],
          sections: [...sections].join(','),
        }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.status) {
        this.#setStatus(result.description || result.message || this.dataset.messageError);
        return;
      }

      const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { signal: controller.signal });
      const cart = await cartResponse.json();
      this.dispatchEvent(
        new CartAddEvent({}, `scan-to-cart-${this.#variantId}`, {
          source: 'scan-to-cart',
          itemCount: cart.item_count,
          productId: this.dataset.productId,
          sections: result.sections,
        })
      );
      this.#setStatus(this.dataset.messageAdded);
      // Ready for the next label without clearing the card the customer just added.
      this.#lastCode = '';
      quantity.value = '1';
    } catch (error) {
      if (!controller.signal.aborted) this.#setStatus(this.dataset.messageError);
    } finally {
      if (this.#adding === controller) this.#adding = null;
      addButton.disabled = false;
      addButton.removeAttribute('aria-busy');
    }
  };

  /** @returns {Promise<(source: HTMLVideoElement) => Promise<string>>} */
  async #createDecoder() {
    if ('BarcodeDetector' in window) {
      // @ts-ignore BarcodeDetector is not in every TypeScript DOM library yet.
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = DETECTOR_FORMATS.filter((format) => supported.includes(format));
      if (formats.includes('qr_code') && formats.includes('code_128')) {
        // @ts-ignore
        const detector = new window.BarcodeDetector({ formats });
        return async (source) => (await detector.detect(source))[0]?.rawValue ?? '';
      }
    }

    // Safari has no BarcodeDetector, so ZXing reads QR codes and barcodes there.
    await this.#loadScript(this.dataset.decoderUrl ?? '');
    // @ts-ignore ZXing is a global from the decoder script.
    const { ZXing } = window;
    const reader = new ZXing.MultiFormatReader();
    const hints = new Map();
    hints.set(
      ZXing.DecodeHintType.POSSIBLE_FORMATS,
      ZXING_FORMATS.map((format) => ZXing.BarcodeFormat[format])
    );
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return async (source) => {
      // Downscaled frames decode faster on phones and still resolve printed labels.
      const scale = Math.min(1, DECODE_WIDTH / (source.videoWidth || DECODE_WIDTH));
      const width = Math.round(source.videoWidth * scale);
      const height = Math.round(source.videoHeight * scale);
      if (!context || !width || !height) return '';
      canvas.width = width;
      canvas.height = height;
      context.drawImage(source, 0, 0, width, height);
      try {
        const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
        return reader.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance))).getText();
      } catch {
        // ZXing throws when a frame has no readable code.
        return '';
      } finally {
        reader.reset();
      }
    };
  }

  /** @param {string} src */
  #loadScript(src) {
    // @ts-ignore
    if (window.ZXing) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }

  #scheduleScan() {
    clearTimeout(this.#scanTimer);
    this.#scanTimer = setTimeout(() => this.#scanFrame(), SCAN_INTERVAL_MS);
  }

  async #scanFrame() {
    if (!this.#stream || !this.#decode) return;
    try {
      const code = (await this.#decode(this.refs.video)).trim();
      const now = Date.now();
      if (code && !(code === this.#lastCode && now - this.#lastCodeAt < REPEAT_SCAN_MS)) {
        this.#lastCode = code;
        this.#lastCodeAt = now;
        this.refs.sku.value = code;
        this.#findProduct(code);
      }
    } catch {
      // A frame that cannot be decoded is normal while the camera moves.
    }
    if (this.#stream) this.#scheduleScan();
  }

  #stopCamera() {
    clearTimeout(this.#scanTimer);
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    if (!this.refs?.video) return;
    const { cameraButton, video, viewfinder } = this.refs;
    video.srcObject = null;
    viewfinder.hidden = true;
    cameraButton.setAttribute('aria-pressed', 'false');
    cameraButton.textContent = this.dataset.labelStart ?? '';
  }

  /** @param {string} code */
  async #findProduct(code) {
    this.#lookup?.abort();
    const controller = new AbortController();
    this.#lookup = controller;
    this.#showResult(null);
    this.#setStatus(this.dataset.messageSearching);

    try {
      const match = await this.#matchSku(code, controller.signal);
      if (controller.signal.aborted) return;
      if (!match) {
        this.#setStatus(this.dataset.messageNotFound);
        return;
      }
      this.#showResult(match);
      this.#setStatus(match.variant.available ? match.product.title : this.dataset.messageUnavailable);
    } catch (error) {
      if (!controller.signal.aborted) this.#setStatus(this.dataset.messageError);
    } finally {
      if (this.#lookup === controller) this.#lookup = null;
    }
  }

  /**
   * Predictive search matches variant SKUs, then each candidate's product JSON confirms the exact SKU.
   * @param {string} code
   * @param {AbortSignal} signal
   */
  async #matchSku(code, signal) {
    const url = new URL(`${Theme.routes.predictive_search_url}.json`, location.origin);
    url.searchParams.set('q', code);
    url.searchParams.set('resources[type]', 'product');
    url.searchParams.set('resources[limit]', String(SEARCH_LIMIT));
    url.searchParams.set('resources[options][fields]', 'variants.sku');
    const response = await fetch(url, { signal });
    const data = await response.json();
    const wanted = code.toUpperCase();

    for (const candidate of data.resources?.results?.products ?? []) {
      const productUrl = new URL(candidate.url, location.origin);
      const productResponse = await fetch(`${productUrl.pathname}.js`, { signal });
      if (!productResponse.ok) continue;
      const product = await productResponse.json();
      const variant = product.variants.find((/** @type {{sku?: string}} */ item) => item.sku?.toUpperCase() === wanted);
      if (variant) return { product, variant };
    }
    return null;
  }

  /** @param {{product: any, variant: any} | null} match */
  #showResult(match) {
    const { result, image, title, code, addButton, quantity } = this.refs;
    if (!match) {
      result.hidden = true;
      this.#variantId = null;
      return;
    }

    const { product, variant } = match;
    const src = variant.featured_image?.src ?? product.featured_image;
    if (src) {
      const imageUrl = new URL(src, location.origin);
      imageUrl.searchParams.set('width', '320');
      image.src = imageUrl.href;
      image.alt = product.title;
      image.hidden = false;
    } else {
      image.removeAttribute('src');
      image.hidden = true;
    }
    const variantTitle = product.variants.length > 1 ? ` – ${variant.title}` : '';
    title.textContent = `${product.title}${variantTitle}`;
    code.textContent = variant.sku;
    quantity.value = '1';
    addButton.disabled = !variant.available;
    this.#variantId = variant.available ? variant.id : null;
    this.dataset.productId = String(product.id);
    result.hidden = false;
  }

  /** @param {string | undefined} message */
  #setStatus(message) {
    this.refs.status.textContent = message ?? '';
  }
}

if (!customElements.get('scan-to-cart')) {
  customElements.define('scan-to-cart', ScanToCart);
}
