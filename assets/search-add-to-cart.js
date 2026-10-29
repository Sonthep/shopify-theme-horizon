import { Component } from '@theme/component';
import { CartAddEvent } from '@theme/events';

// How long the button shows the added state before it can be used again.
const ADDED_STATE_MS = 2000;

/**
 * @typedef {object} SearchAddToCartRefs
 * @property {HTMLButtonElement} button - Adds one unit of the variant.
 * @property {HTMLElement} status - Announces the result.
 */

/**
 * Adds a single-variant product to the cart from a predictive search result
 * without leaving the search.
 * @extends {Component<SearchAddToCartRefs>}
 */
class SearchAddToCart extends Component {
  requiredRefs = ['button', 'status'];

  /** @type {AbortController | null} */
  #activeRequest = null;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #resetTimer;

  /** @type {string | null} */
  #label = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#activeRequest?.abort();
    this.#activeRequest = null;
    clearTimeout(this.#resetTimer);
  }

  /**
   * Stops the search form from treating Enter on this button as result navigation.
   * The framework routes a keydown only to the closest `on:keydown` owner.
   * @param {KeyboardEvent} _event
   */
  keepKeyboardFocus = (_event) => {};

  add = async () => {
    if (this.#activeRequest) return;

    const { button, status } = this.refs;
    const sections = new Set();
    for (const component of document.querySelectorAll('cart-items-component')) {
      if (component instanceof HTMLElement && component.dataset.sectionId) sections.add(component.dataset.sectionId);
    }

    const controller = new AbortController();
    this.#activeRequest = controller;
    clearTimeout(this.#resetTimer);
    this.#label ??= button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          items: [{ id: Number(this.dataset.variantId), quantity: 1 }],
          sections: [...sections].join(','),
        }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || result.status) {
        status.textContent = result.description || result.message || this.dataset.messageError || '';
        return;
      }

      const cartResponse = await fetch(`${Theme.routes.cart_url}.js`, { signal: controller.signal });
      const cart = await cartResponse.json();
      this.dispatchEvent(
        new CartAddEvent({}, `search-add-${this.dataset.productId}`, {
          source: 'search-add-to-cart',
          itemCount: cart.item_count,
          productId: this.dataset.productId,
          sections: result.sections,
        })
      );

      const added = this.dataset.messageAdded ?? '';
      status.textContent = added;
      button.textContent = added;
      this.#resetTimer = setTimeout(() => {
        button.textContent = this.#label;
        status.textContent = '';
      }, ADDED_STATE_MS);
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = this.dataset.messageError ?? '';
    } finally {
      if (this.#activeRequest === controller) this.#activeRequest = null;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };
}

if (!customElements.get('search-add-to-cart')) {
  customElements.define('search-add-to-cart', SearchAddToCart);
}
