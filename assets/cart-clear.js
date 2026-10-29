import { Component } from '@theme/component';
import { CartUpdateEvent } from '@theme/events';
import { fetchConfig } from '@theme/utilities';

/**
 * @typedef {object} CartClearRefs
 * @property {HTMLButtonElement} button - Submits the clear request.
 */

/**
 * Empties the cart after the customer confirms. The wrapped form posts to
 * /cart/clear when JavaScript is unavailable; with JavaScript, the cart sections
 * re-render in place through a bubbling cart update event.
 * @extends {Component<CartClearRefs>}
 */
class CartClear extends Component {
  requiredRefs = ['button'];

  /** @type {AbortController | null} */
  #activeRequest = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#activeRequest?.abort();
    this.#activeRequest = null;
  }

  /**
   * @param {SubmitEvent} event
   */
  clear = async (event) => {
    event.preventDefault();
    if (this.#activeRequest) return;
    if (!window.confirm(this.dataset.confirm ?? '')) return;

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;

    const sections = new Set();
    for (const component of document.querySelectorAll('cart-items-component')) {
      if (component instanceof HTMLElement && component.dataset.sectionId) sections.add(component.dataset.sectionId);
    }

    const controller = new AbortController();
    this.#activeRequest = controller;
    this.refs.button.disabled = true;

    try {
      const response = await fetch(`${form.action}.js`, {
        ...fetchConfig('json', {
          body: JSON.stringify({ sections: [...sections].join(','), sections_url: window.location.pathname }),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Cart clear failed with ${response.status}`);

      const cart = await response.json();
      this.dispatchEvent(
        new CartUpdateEvent(cart, 'cart-clear', {
          itemCount: 0,
          source: 'cart-clear',
          sections: cart.sections,
        })
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      // Fall back to the native form so the cart still empties.
      form.submit();
    } finally {
      if (this.#activeRequest === controller) this.#activeRequest = null;
      if (this.isConnected) this.refs.button.disabled = false;
    }
  };
}

if (!customElements.get('cart-clear')) {
  customElements.define('cart-clear', CartClear);
}
