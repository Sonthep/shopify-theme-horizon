import { Component } from '@theme/component';

// Large quotations and a sleeping quotation API both need more than a normal request.
const REQUEST_TIMEOUT_MS = 120000;

/**
 * @typedef {object} QuoteImageUploadRefs
 * @property {HTMLInputElement} file - The customer's quotation PDF.
 * @property {HTMLElement} dropzone - Accepts a dropped PDF and shows the busy state; hidden while a result is shown.
 * @property {HTMLElement} status - Live region for progress and errors.
 * @property {HTMLElement} preview - Read-only preview of the result with download actions.
 * @property {HTMLIFrameElement} frame - Shows the resulting PDF.
 * @property {HTMLAnchorElement} downloadLink - Saves the resulting PDF.
 * @property {HTMLAnchorElement} openLink - Opens the PDF in a new tab for browsers that cannot embed it.
 */

/**
 * Sends a quotation PDF to the quotation app proxy as soon as it is chosen or
 * dropped, then previews the copy with product images before the customer
 * downloads it. The proxy identifies the signed-in customer; the preview is read-only.
 * @extends {Component<QuoteImageUploadRefs>}
 */
class QuoteImageUpload extends Component {
  requiredRefs = ['file', 'dropzone', 'status', 'preview', 'frame', 'downloadLink', 'openLink'];

  /** @type {AbortController | null} */
  #activeRequest = null;

  /** @type {AbortController | null} */
  #dropEvents = null;

  /** @type {string | null} */
  #resultUrl = null;

  connectedCallback() {
    super.connectedCallback();
    this.#dropEvents?.abort();
    this.#dropEvents = new AbortController();
    const { signal } = this.#dropEvents;
    const { dropzone } = this.refs;

    dropzone.addEventListener('dragover', this.#handleDragOver, { signal });
    dropzone.addEventListener('dragleave', this.#handleDragLeave, { signal });
    dropzone.addEventListener('drop', this.#handleDrop, { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#dropEvents?.abort();
    this.#dropEvents = null;
    this.#activeRequest?.abort();
    this.#activeRequest = null;
    this.#clearResult();
  }

  /**
   * Uploads the PDF chosen with the file picker.
   */
  upload = () => {
    const { file: input } = this.refs;
    const file = input.files?.[0];
    // Clearing the input lets the customer pick the same file again.
    input.value = '';
    if (file) this.#upload(file);
  };

  /**
   * Discards the result and shows the upload area again.
   */
  reset = () => {
    this.refs.status.textContent = '';
    this.#clearResult();
    this.refs.file.focus();
  };

  /** @param {DragEvent} event */
  #handleDragOver = (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.#activeRequest ? 'none' : 'copy';
    this.refs.dropzone.dataset.dragging = 'true';
  };

  /** @param {DragEvent} event */
  #handleDragLeave = (event) => {
    const { dropzone } = this.refs;
    if (event.relatedTarget instanceof Node && dropzone.contains(event.relatedTarget)) return;
    delete dropzone.dataset.dragging;
  };

  /** @param {DragEvent} event */
  #handleDrop = (event) => {
    event.preventDefault();
    delete this.refs.dropzone.dataset.dragging;
    const file = event.dataTransfer?.files[0];
    if (file) this.#upload(file);
  };

  /**
   * @param {File} file
   */
  async #upload(file) {
    if (this.#activeRequest) return;

    const { file: input, dropzone, status } = this.refs;
    this.#clearResult();
    if (!isPdf(file)) {
      status.textContent = this.dataset.messageErrorFile ?? '';
      return;
    }
    if (file.size > Number(this.dataset.maxBytes)) {
      status.textContent = this.dataset.messageErrorSize ?? '';
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.#activeRequest = controller;
    input.disabled = true;
    dropzone.setAttribute('aria-busy', 'true');
    status.textContent = this.dataset.messagePreparing ?? '';

    try {
      const response = await fetch(this.dataset.endpoint ?? '', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf', Accept: 'application/pdf' },
        body: file,
        signal: controller.signal,
      });

      if (!response.ok || !response.headers.get('Content-Type')?.includes('application/pdf')) {
        status.textContent = await this.#errorMessage(response);
        return;
      }

      const inserted = Number(response.headers.get('X-Images-Inserted') ?? '');
      this.#showResult(await response.blob(), `${file.name.replace(/\.pdf$/i, '')}-images.pdf`);
      status.textContent =
        inserted === 0
          ? this.dataset.messageReadyNone ?? ''
          : (this.dataset.messageReady ?? '').replace('[count]', String(inserted || ''));
    } catch (error) {
      if (this.isConnected) status.textContent = this.dataset.messageError ?? '';
    } finally {
      clearTimeout(timeout);
      if (this.#activeRequest === controller) this.#activeRequest = null;
      input.disabled = false;
      dropzone.removeAttribute('aria-busy');
    }
  }

  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  #showResult(blob, filename) {
    const { dropzone, preview, frame, downloadLink, openLink } = this.refs;
    this.#resultUrl = URL.createObjectURL(blob);
    frame.src = this.#resultUrl;
    downloadLink.href = this.#resultUrl;
    downloadLink.download = filename;
    openLink.href = this.#resultUrl;
    dropzone.hidden = true;
    preview.hidden = false;
    // The file picker that had focus is now hidden.
    downloadLink.focus();
  }

  #clearResult() {
    if (!this.#resultUrl) return;
    const { dropzone, preview, frame, downloadLink, openLink } = this.refs;
    preview.hidden = true;
    dropzone.hidden = false;
    frame.removeAttribute('src');
    downloadLink.href = '#';
    openLink.href = '#';
    URL.revokeObjectURL(this.#resultUrl);
    this.#resultUrl = null;
  }

  /**
   * @param {Response} response
   * @returns {Promise<string>}
   */
  async #errorMessage(response) {
    /** @type {{ code?: string }} */
    let body = {};
    try {
      body = await response.json();
    } catch (error) {
      // The proxy returns HTML when the app is unavailable.
    }

    switch (body.code) {
      case 'login_required':
        return this.dataset.messageErrorLogin ?? '';
      case 'rate_limited':
        return this.dataset.messageErrorRate ?? '';
      case 'too_large':
        return this.dataset.messageErrorSize ?? '';
      case 'unsupported_pdf':
        return this.dataset.messageErrorFile ?? '';
      default:
        return this.dataset.messageError ?? '';
    }
  }
}

/**
 * @param {File} file
 * @returns {boolean}
 */
function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

if (!customElements.get('quote-image-upload')) {
  customElements.define('quote-image-upload', QuoteImageUpload);
}
