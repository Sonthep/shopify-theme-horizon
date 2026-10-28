import { Component } from '@theme/component';
import { fetchConfig } from '@theme/utilities';

// The quotation API can take a while to wake up, so allow more than a normal request.
const REQUEST_TIMEOUT_MS = 90000;

/**
 * @typedef {object} CartQuoteRefs
 * @property {HTMLButtonElement} button - Starts the quotation request.
 * @property {HTMLElement} status - Live region for progress and errors.
 * @property {HTMLDialogElement} dialog - Read-only preview of the quotation.
 * @property {HTMLElement} title - Preview heading.
 * @property {HTMLIFrameElement} frame - Shows the quotation PDF.
 * @property {HTMLAnchorElement} downloadLink - Saves the quotation PDF.
 * @property {HTMLAnchorElement} openLink - Opens the PDF in a new tab for browsers that cannot embed it.
 */

/**
 * Previews a PDF quotation of the current cart from the quotation app proxy
 * before the customer downloads it.
 * The proxy identifies the signed-in customer and reads cart prices from Shopify,
 * so only the cart token and merchant-configured terms are sent.
 * @extends {Component<CartQuoteRefs>}
 */
class CartQuote extends Component {
  requiredRefs = ['button', 'status', 'dialog', 'title', 'frame', 'downloadLink', 'openLink'];

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
   * Closes the preview; the file stays available until the next request.
   */
  closePreview = () => {
    this.refs.dialog.close();
  };

  /**
   * Requests the quotation and opens its preview.
   */
  requestQuote = async () => {
    if (this.#activeRequest) return;

    const { button, status } = this.refs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    this.#activeRequest = controller;
    this.#clearResult();
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = this.dataset.messagePreparing ?? '';

    try {
      const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { signal: controller.signal });
      const { token } = await cartResponse.json();

      const response = await fetch(this.dataset.endpoint ?? '', {
        ...fetchConfig('pdf', {
          body: JSON.stringify({
            cart_token: token,
            payment_term: this.dataset.paymentTerm ?? '',
            remark: this.dataset.remark ?? '',
            validity_days: Number(this.dataset.validityDays) || 30,
          }),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.headers.get('Content-Type')?.includes('application/pdf')) {
        status.textContent = await this.#errorMessage(response);
        return;
      }

      const number = quoteNumber(response);
      this.#showResult(await response.blob(), number);
      status.textContent = (this.dataset.messageReady ?? '').replace('[number]', number);
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
   * @param {string} number
   */
  #showResult(blob, number) {
    const { dialog, title, frame, downloadLink, openLink } = this.refs;
    this.#resultUrl = URL.createObjectURL(blob);
    title.textContent = number;
    frame.src = this.#resultUrl;
    downloadLink.href = this.#resultUrl;
    downloadLink.download = `${number}.pdf`;
    openLink.href = this.#resultUrl;
    dialog.showModal();
  }

  #clearResult() {
    if (!this.#resultUrl) return;
    const { dialog, frame, downloadLink, openLink } = this.refs;
    if (dialog.open) dialog.close();
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
      case 'cart_unavailable':
        return this.dataset.messageErrorCart ?? '';
      default:
        return this.dataset.messageError ?? '';
    }
  }
}

/**
 * @param {Response} response
 * @returns {string}
 */
function quoteNumber(response) {
  const header = response.headers.get('X-Quote-Number');
  if (header) return header;
  const match = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)\.pdf/);
  return match?.[1] ?? 'quotation';
}

if (!customElements.get('cart-quote')) {
  customElements.define('cart-quote', CartQuote);
}
