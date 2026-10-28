import { Component } from '@theme/component';

// Large quotations and a sleeping quotation API both need more than a normal request.
const REQUEST_TIMEOUT_MS = 120000;

/**
 * @typedef {object} QuoteImageUploadRefs
 * @property {HTMLInputElement} file - The customer's quotation PDF.
 * @property {HTMLButtonElement} button - Starts the upload.
 * @property {HTMLElement} status - Live region for progress and errors.
 * @property {HTMLElement} preview - Read-only preview of the result with download actions.
 * @property {HTMLIFrameElement} frame - Shows the resulting PDF.
 * @property {HTMLAnchorElement} downloadLink - Saves the resulting PDF.
 * @property {HTMLAnchorElement} openLink - Opens the PDF in a new tab for browsers that cannot embed it.
 */

/**
 * Sends a quotation PDF to the quotation app proxy and previews the copy with
 * product images before the customer downloads it. The proxy identifies the
 * signed-in customer; the preview is read-only.
 * @extends {Component<QuoteImageUploadRefs>}
 */
class QuoteImageUpload extends Component {
  requiredRefs = ['file', 'button', 'status', 'preview', 'frame', 'downloadLink', 'openLink'];

  /** @type {AbortController | null} */
  #activeRequest = null;

  /** @type {string | null} */
  #resultUrl = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#activeRequest?.abort();
    this.#activeRequest = null;
    this.#clearResult();
  }

  /**
   * Clears the previous result when another file is chosen.
   */
  clearStatus = () => {
    if (this.#activeRequest) return;
    this.refs.status.textContent = '';
    this.#clearResult();
  };

  /**
   * Uploads the chosen PDF and starts the download of the result.
   */
  upload = async () => {
    if (this.#activeRequest) return;

    const { file: input, button, status } = this.refs;
    const file = input.files?.[0];
    if (!file || !isPdf(file)) {
      status.textContent = this.dataset.messageErrorFile ?? '';
      input.focus();
      return;
    }
    if (file.size > Number(this.dataset.maxBytes)) {
      status.textContent = this.dataset.messageErrorSize ?? '';
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.#activeRequest = controller;
    this.#clearResult();
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
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
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };

  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  #showResult(blob, filename) {
    const { preview, frame, downloadLink, openLink } = this.refs;
    this.#resultUrl = URL.createObjectURL(blob);
    frame.src = this.#resultUrl;
    downloadLink.href = this.#resultUrl;
    downloadLink.download = filename;
    openLink.href = this.#resultUrl;
    preview.hidden = false;
  }

  #clearResult() {
    if (!this.#resultUrl) return;
    const { preview, frame, downloadLink, openLink } = this.refs;
    preview.hidden = true;
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
