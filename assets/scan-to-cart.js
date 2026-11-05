import { Component } from '@theme/component';
import { CartAddEvent } from '@theme/events';
import { findVariantBySku, findVariantByUrl, parseScannedCode } from '@theme/product-lookup';

// A code is ignored until it has been out of view this long, so a label held still is looked up once.
const REPEAT_SCAN_MS = 3000;
// Decoding every frame drains phone batteries; a few reads per second feel instant.
const SCAN_INTERVAL_MS = 200;
// Labels carry the SKU, or a link holding it, as a QR code or a linear barcode.
const DETECTOR_FORMATS = ['qr_code', 'code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'];
const ZXING_FORMATS = ['QR_CODE', 'CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF'];
// Width of the guide area handed to the decoder; wide enough for thin bars, small enough to stay fast.
const DECODE_WIDTH = 1280;
// Photos are read once, so they can keep more detail; a label's code may fill little of the shot.
const PHOTO_DECODE_WIDTH = 2400;
// Zooming in lets the phone stay far enough from a small label for its lens to focus.
const PREFERRED_ZOOM = 2;
// Remembers a short link while the browser opens it, so the camera can resume on the way back.
const SHORT_LINK_KEY = 'scan-to-cart:short-link';

/**
 * @typedef {object} ScanToCartRefs
 * @property {HTMLButtonElement} cameraButton - Starts or stops the camera.
 * @property {HTMLElement} cameraLabel - The camera button's text, beside its icon.
 * @property {HTMLElement} viewfinder - Wraps the video while the camera runs.
 * @property {HTMLVideoElement} video - Shows the camera stream.
 * @property {HTMLElement} frame - The on-screen guide; only codes inside it are read.
 * @property {HTMLButtonElement} torchButton - Turns the camera light on or off, where supported.
 * @property {HTMLInputElement} photo - Picks a photo of a label to read.
 * @property {HTMLFormElement} form - Looks up a typed product code.
 * @property {HTMLInputElement} sku - The typed or scanned product code.
 * @property {HTMLElement} status - Announces lookup and cart results.
 * @property {HTMLElement} result - The matched product card.
 * @property {HTMLImageElement} image - The matched product image.
 * @property {HTMLElement} title - The matched product title.
 * @property {HTMLElement} code - The matched product SKU.
 * @property {HTMLInputElement} quantity - How many units to add.
 * @property {HTMLButtonElement} addButton - Adds the matched variant to the cart.
 * @property {HTMLButtonElement} nextButton - Dismisses a match and resumes scanning.
 */

/**
 * Finds a product from its QR code or barcode, a photo of one, or a typed SKU, and adds it to the cart.
 * Uses the browser's BarcodeDetector when it reads both, otherwise loads ZXing.
 * @extends {Component<ScanToCartRefs>}
 */
class ScanToCart extends Component {
  requiredRefs = ['cameraButton', 'cameraLabel', 'viewfinder', 'video', 'frame', 'torchButton', 'photo', 'form', 'sku', 'status', 'result', 'image', 'title', 'code', 'quantity', 'addButton', 'nextButton'];

  /** @type {MediaStream | null} */
  #stream = null;

  /** @type {((source: HTMLCanvasElement) => Promise<string>) | null} */
  #decode = null;

  /** @type {HTMLCanvasElement | null} */
  #canvas = null;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #scanTimer;

  // The last read, which must repeat before it counts; a single read may be a misread.
  #candidate = '';
  #lastCode = '';
  #lastCodeAt = 0;
  // Holds a match on screen, so a neighbouring label cannot replace it while the customer sets a quantity.
  #paused = false;

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
    this.#openLinkedSku();
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

    const { cameraButton, cameraLabel, video, viewfinder } = this.refs;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.#setStatus(this.dataset.messageCameraUnavailable, 'error');
      return;
    }

    cameraButton.disabled = true;
    try {
      this.#decode ??= await this.#createDecoder();
      this.#stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      video.srcObject = this.#stream;
      await video.play();
      await this.#tuneCamera();
      viewfinder.hidden = false;
      cameraButton.setAttribute('aria-pressed', 'true');
      cameraLabel.textContent = this.dataset.labelStop ?? '';
      this.#setPaused(false);
      this.#setStatus(this.dataset.messageHint);
      this.#scheduleScan();
    } catch (error) {
      this.#stopCamera();
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      this.#setStatus(denied ? this.dataset.messageCameraDenied : this.dataset.messageCameraUnavailable, 'error');
    } finally {
      cameraButton.disabled = false;
    }
  };

  toggleTorch = async () => {
    const { torchButton } = this.refs;
    const track = this.#stream?.getTracks()[0];
    if (!track) return;

    const on = torchButton.getAttribute('aria-pressed') !== 'true';
    try {
      // @ts-ignore torch is not in every TypeScript DOM library yet.
      await track.applyConstraints({ advanced: [{ torch: on }] });
      torchButton.setAttribute('aria-pressed', String(on));
    } catch {
      // The light is a convenience; the button keeps showing its real state.
    }
  };

  choosePhoto = () => this.refs.photo.click();

  readPhoto = async () => {
    const { photo, sku } = this.refs;
    const file = photo.files?.[0];
    if (!file) return;

    this.#setStatus(this.dataset.messageSearching);
    try {
      this.#decode ??= await this.#createDecoder();
      const bitmap = await createImageBitmap(file);
      const canvas = this.#copyToCanvas(bitmap, 0, 0, bitmap.width, bitmap.height, PHOTO_DECODE_WIDTH);
      bitmap.close();
      const code = canvas ? (await this.#decode(canvas)).trim() : '';
      if (code) {
        sku.value = code;
        this.#findProduct(code);
      } else {
        this.#setStatus(this.dataset.messagePhotoFailed, 'error');
      }
    } catch {
      this.#setStatus(this.dataset.messagePhotoFailed, 'error');
    } finally {
      // Lets the same file be picked again.
      photo.value = '';
    }
  };

  decrease = () => this.#stepQuantity(-1);

  increase = () => this.#stepQuantity(1);

  /** Asks for the zoom and focus a small label needs, and offers the light; each is optional hardware. */
  async #tuneCamera() {
    const { torchButton } = this.refs;
    const track = this.#stream?.getTracks()[0];
    /** @type {any} */
    const capabilities = track?.getCapabilities?.() ?? {};
    /** @type {any} */
    const wanted = {};
    if (capabilities.focusMode?.includes('continuous')) wanted.focusMode = 'continuous';
    if (capabilities.zoom) {
      wanted.zoom = Math.min(capabilities.zoom.max, Math.max(capabilities.zoom.min, PREFERRED_ZOOM));
    }
    torchButton.hidden = !capabilities.torch;
    if (!track || !Object.keys(wanted).length) return;

    try {
      await track.applyConstraints({ advanced: [wanted] });
    } catch {
      // Scanning still works at the camera's defaults.
    }
  }

  /**
   * Opens the product a link sent here with `?sku=`: the 404 page does this for old label links.
   */
  async #openLinkedSku() {
    const url = new URL(location.href);
    const code = url.searchParams.get('sku');
    if (!code) return;

    url.searchParams.delete('sku');
    history.replaceState(history.state, '', url);
    this.refs.sku.value = code;

    let shortLink = null;
    try {
      shortLink = sessionStorage.getItem(SHORT_LINK_KEY);
      sessionStorage.removeItem(SHORT_LINK_KEY);
    } catch {
      // Without storage the customer restarts the camera themselves.
    }
    if (shortLink) {
      await this.toggleCamera();
      // The label is probably still in view, and must not send the browser round again.
      this.#lastCode = shortLink;
      this.#lastCodeAt = Date.now();
    }
    this.#findProduct(code);
  }

  /** @param {string} url */
  #openShortLink(url) {
    try {
      if (this.#stream) sessionStorage.setItem(SHORT_LINK_KEY, this.refs.sku.value);
    } catch {
      // Without storage the customer restarts the camera themselves.
    }
    this.#setStatus(this.dataset.messageSearching);
    this.#stopCamera();
    location.assign(url);
  }

  /** @param {number} step */
  #stepQuantity(step) {
    const { quantity } = this.refs;
    quantity.value = String(Math.max(1, (Number(quantity.value) || 1) + step));
  }

  /** @param {SubmitEvent} event */
  find = (event) => {
    event.preventDefault();
    const code = this.refs.sku.value.trim();
    if (code) this.#findProduct(code);
  };

  scanNext = () => {
    this.#showResult(null);
    this.#lastCodeAt = Date.now();
    this.#setStatus(this.dataset.messageHint);
    // The button that held focus has just been hidden.
    this.refs.cameraButton.focus();
  };

  add = async () => {
    if (this.#adding || this.#variantId === null) return;

    const { addButton, quantity } = this.refs;
    // A new match can replace these while the request runs.
    const variantId = this.#variantId;
    const { productId } = this.dataset;
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
          items: [{ id: variantId, quantity: Math.max(1, Number(quantity.value) || 1) }],
          sections: [...sections].join(','),
        }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.status) {
        this.#setStatus(result.description || result.message || this.dataset.messageError, 'error');
        return;
      }

      const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { signal: controller.signal });
      const cart = await cartResponse.json();
      this.dispatchEvent(
        new CartAddEvent({}, `scan-to-cart-${variantId}`, {
          source: 'scan-to-cart',
          itemCount: cart.item_count,
          productId,
          sections: result.sections,
        })
      );
      this.#setStatus(this.dataset.messageAdded, 'success');
      // Ready for the next label, keeping the card; the label still in view is not looked up again.
      this.#lastCodeAt = Date.now();
      this.#setPaused(false);
      quantity.value = '1';
    } catch (error) {
      if (!controller.signal.aborted) this.#setStatus(this.dataset.messageError, 'error');
    } finally {
      if (this.#adding === controller) this.#adding = null;
      addButton.disabled = this.#variantId === null;
      addButton.removeAttribute('aria-busy');
    }
  };

  /** @returns {Promise<(source: HTMLCanvasElement) => Promise<string>>} */
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

    return async (source) => {
      try {
        const luminance = new ZXing.HTMLCanvasElementLuminanceSource(source);
        return reader.decodeWithState(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance))).getText();
      } catch {
        // ZXing throws when a frame has no readable code.
        return '';
      } finally {
        reader.reset();
      }
    };
  }

  /**
   * Copies the part of the video inside the on-screen guide, so codes the customer is not aiming at,
   * including those the viewfinder crops off screen, are never read.
   * @returns {HTMLCanvasElement | null}
   */
  #captureGuide() {
    const { frame, video } = this.refs;
    const { videoWidth, videoHeight } = video;
    const box = video.getBoundingClientRect();
    const guide = frame.getBoundingClientRect();
    if (!videoWidth || !videoHeight || !box.width || !box.height) return null;

    // CSS pixels per video pixel under object-fit: cover, which centres the video.
    const coverScale = Math.max(box.width / videoWidth, box.height / videoHeight);
    const sourceWidth = guide.width / coverScale;
    const sourceHeight = guide.height / coverScale;
    const sourceX = videoWidth / 2 + (guide.left - box.left - box.width / 2) / coverScale;
    const sourceY = videoHeight / 2 + (guide.top - box.top - box.height / 2) / coverScale;
    return this.#copyToCanvas(video, sourceX, sourceY, sourceWidth, sourceHeight, DECODE_WIDTH);
  }

  /**
   * Copies part of an image to the decoder's canvas; smaller images decode faster on phones.
   * @param {CanvasImageSource} source
   * @param {number} x
   * @param {number} y
   * @param {number} sourceWidth
   * @param {number} sourceHeight
   * @param {number} maxWidth
   * @returns {HTMLCanvasElement | null}
   */
  #copyToCanvas(source, x, y, sourceWidth, sourceHeight, maxWidth) {
    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    this.#canvas ??= document.createElement('canvas');
    const context = this.#canvas.getContext('2d', { willReadFrequently: true });
    if (!context || !width || !height) return null;

    this.#canvas.width = width;
    this.#canvas.height = height;
    context.drawImage(source, x, y, sourceWidth, sourceHeight, 0, 0, width, height);
    return this.#canvas;
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
    if (!this.#paused && !this.#lookup) {
      try {
        const source = this.#captureGuide();
        const code = source ? (await this.#decode(source)).trim() : '';
        if (code) this.#handleRead(code);
      } catch {
        // A frame that cannot be decoded is normal while the camera moves.
      }
    }
    if (this.#stream) this.#scheduleScan();
  }

  /** @param {string} code */
  #handleRead(code) {
    // The customer may have stopped the camera or typed a code while this frame decoded.
    if (!this.#stream || this.#paused || this.#lookup) return;

    const now = Date.now();
    if (code === this.#lastCode) {
      if (now - this.#lastCodeAt < REPEAT_SCAN_MS) {
        this.#lastCodeAt = now;
        return;
      }
      // Back after leaving the view, so it counts as a new read and must confirm like one.
      this.#lastCode = '';
    }

    if (code !== this.#candidate) {
      this.#candidate = code;
      return;
    }

    this.#candidate = '';
    this.#lastCode = code;
    this.#lastCodeAt = now;
    this.refs.sku.value = code;
    this.#findProduct(code);
  }

  #stopCamera() {
    clearTimeout(this.#scanTimer);
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    this.#candidate = '';
    this.#lastCode = '';
    if (!this.refs?.video) return;
    const { cameraButton, cameraLabel, torchButton, video, viewfinder } = this.refs;
    video.srcObject = null;
    viewfinder.hidden = true;
    torchButton.hidden = true;
    torchButton.setAttribute('aria-pressed', 'false');
    cameraButton.setAttribute('aria-pressed', 'false');
    cameraLabel.textContent = this.dataset.labelStart ?? '';
    this.#setPaused(false);
  }

  /** @param {boolean} paused */
  #setPaused(paused) {
    const { nextButton, viewfinder } = this.refs;
    this.#paused = paused;
    viewfinder.toggleAttribute('data-paused', paused);
    nextButton.hidden = !paused || !this.#stream;
  }

  /** @param {string} code */
  async #findProduct(code) {
    const target = parseScannedCode(code, this.#storeHosts);
    if (target.type === 'short-link') {
      this.#openShortLink(target.value);
      return;
    }

    this.#lookup?.abort();
    const controller = new AbortController();
    this.#lookup = controller;
    this.#setStatus(this.dataset.messageSearching);

    try {
      let match = null;
      if (target.type === 'sku') match = await findVariantBySku(target.value, controller.signal, { tolerant: true });
      if (target.type === 'product') match = await findVariantByUrl(target.value, controller.signal);
      if (controller.signal.aborted) return;
      // The previous card stays up during the lookup, so it only changes once there is an answer.
      this.#showResult(match);
      if (!match) {
        this.#setStatus(this.dataset.messageNotFound, 'error');
        return;
      }
      this.#setStatus(match.variant.available ? match.product.title : this.dataset.messageUnavailable, match.variant.available ? '' : 'error');
    } catch (error) {
      if (!controller.signal.aborted) this.#setStatus(this.dataset.messageLookupFailed, 'error');
    } finally {
      if (this.#lookup === controller) this.#lookup = null;
    }
  }

  /** This store's domains without `www.`, to tell its own links from others. */
  get #storeHosts() {
    return (this.dataset.storeHosts ?? '').split(',').map((host) => host.replace(/^www\./i, '').toLowerCase());
  }

  /** @param {{product: any, variant: any} | null} match */
  #showResult(match) {
    const { result, image, title, code, addButton, quantity } = this.refs;
    this.#setPaused(Boolean(match));
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
    // A link may have been scanned; show the code it led to.
    this.refs.sku.value = variant.sku ?? this.refs.sku.value;
    quantity.value = '1';
    addButton.disabled = !variant.available;
    this.#variantId = variant.available ? variant.id : null;
    this.dataset.productId = String(product.id);
    result.hidden = false;
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

if (!customElements.get('scan-to-cart')) {
  customElements.define('scan-to-cart', ScanToCart);
}
