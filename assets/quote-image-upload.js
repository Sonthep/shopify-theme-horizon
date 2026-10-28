import { Component } from '@theme/component';

// Large quotations and a sleeping quotation API both need more than a normal request.
const REQUEST_TIMEOUT_MS = 120000;

/**
 * @typedef {object} QuoteImageUploadRefs
 * @property {HTMLInputElement} file - The customer's quotation PDF.
 * @property {HTMLButtonElement} button - Starts the upload.
 * @property {HTMLElement} status - Live region for progress and errors.
 */

/**
 * Sends a quotation PDF to the quotation app proxy and downloads the copy with
 * product images. The proxy identifies the signed-in customer; there is no review step.
 * @extends {Component<QuoteImageUploadRefs>}
 */
class QuoteImageUpload extends Component {
  requiredRefs = ['file', 'button', 'status'];

  /** @type {AbortController | null} */
  #activeRequest = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#activeRequest?.abort();
    this.#activeRequest = null;
  }

  /**
   * Clears the previous result when another file is chosen.
   */
  clearStatus = () => {
    if (!this.#activeRequest) this.refs.status.textContent = '';
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
      download(await response.blob(), `${file.name.replace(/\.pdf$/i, '')}-images.pdf`);
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

/**
 * @param {Blob} blob
 * @param {string} filename
 */
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (!customElements.get('quote-image-upload')) {
  customElements.define('quote-image-upload', QuoteImageUpload);
}
