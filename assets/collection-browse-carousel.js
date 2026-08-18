/**
 * Custom dots + autoplay for Shop by Category (2-row grid carousel)
 *
 * Key design decisions:
 * - Shopify's `infinite: true` autoplay scrolls to the NEXT SINGLE SLIDE every
 *   3 seconds. In our CSS Grid layout, "next slide" is the 2nd item in column 1
 *   (offsetLeft = 0), so it resets scroll to 0. Fix: remove infinite + autoplay
 *   attributes from slideshow-component so Shopify never touches scroll position.
 * - Shopify's arrows fire a SlideshowSelectEvent that triggers DOM reordering for
 *   infinite mode. We intercept arrow *click* at capture phase on the section,
 *   before the event reaches the button, so Shopify's handler never runs.
 * - Column width is set in JS as exact pixels (scroller.clientWidth / 4) rather
 *   than calc(100% / 4) to avoid any sub-pixel rounding that causes a peek.
 */
(function () {
  function initCollectionBrowseCarousel() {
    const section = document.querySelector('[id$="_collections_browse"]');
    if (!section) return;

    const scroller = section.querySelector('slideshow-slides');
    if (!scroller) return;

    // Read this before any of the writes below (attribute removal, style.display,
    // img.sizes) touch the DOM — reading clientWidth after those writes forces a
    // synchronous layout recalculation instead of using the browser's already-cached
    // measurement from the last render.
    const initialScrollerWidth = scroller.clientWidth;

    // --- Neutralise Shopify's own slideshow for this section ---
    //
    // Shopify's autoplay fires this.next() every N ms, which calls
    // select(slideIndex). In our CSS Grid, slide[1] is column-1 row-2
    // (offsetLeft = 0), so autoplay keeps resetting scrollLeft to 0.
    //
    // The slideshow component reads these attributes dynamically (getter),
    // so removing them prevents future resume() calls from restarting.
    // We ALSO call suspend() to clear any interval already running, and
    // setAttribute('paused') so resume() short-circuits even if called.
    const slideshowEl = section.querySelector('slideshow-component');
    if (slideshowEl) {
      slideshowEl.removeAttribute('autoplay');
      slideshowEl.setAttribute('paused', '');
      slideshowEl.removeAttribute('infinite');
      if (typeof slideshowEl.suspend === 'function') slideshowEl.suspend();
    }

    // Hide Shopify's built-in navigation dots (we render our own)
    const builtInControls = section.querySelector('slideshow-controls');
    if (builtInControls) builtInControls.style.display = 'none';

    // Card images use a fixed pixel height (merchant setting), so a narrower column
    // width without a matching column-count drop makes them look stretched/tall.
    // 2 columns on mobile, 3 in the 750-1199px "in-between" zone, 4 on wide desktop.
    let COLS_PER_PAGE = 4;
    if (window.innerWidth <= 749) {
      COLS_PER_PAGE = 2;
    } else if (window.innerWidth <= 1199) {
      COLS_PER_PAGE = 3;
    }

    // The `sizes` attribute rendered server-side assumes the merchant's configured
    // desktop column count (e.g. "25vw"), but COLS_PER_PAGE above hard-overrides the
    // actual column count at each breakpoint. Left uncorrected, browsers pick a
    // srcset candidate sized for the wrong (larger) slot — on a 2-column mobile page
    // that's roughly 4x more image data than the card actually needs. Sync `sizes` to
    // the real per-breakpoint column width so responsive image selection is accurate.
    // Only touch images that haven't finished loading yet — mutating `sizes` on an
    // already-loaded <img> can make the browser refetch at the newly computed size.
    const correctSizes = Math.round(100 / COLS_PER_PAGE) + 'vw';
    scroller.querySelectorAll('.resource-list__slide img[srcset]').forEach((img) => {
      if (!img.complete) img.sizes = correctSizes;
    });

    const ROWS = 2;
    const ITEMS_PER_PAGE = COLS_PER_PAGE * ROWS;
    const allSlides = scroller.querySelectorAll('.resource-list__slide');
    const totalItems = allSlides.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);

    if (totalPages <= 1) return;

    /**
     * Set grid-auto-columns to exact pixels so COLS_PER_PAGE columns fill the
     * viewport precisely — no sub-pixel gap that would cause a peeking column.
     * @param {number} [width] - Pre-read width to use instead of measuring now.
     */
    function updateColumnSize(width) {
      const w = width ?? scroller.clientWidth;
      if (w > 0) scroller.style.gridAutoColumns = (w / COLS_PER_PAGE) + 'px';
    }
    updateColumnSize(initialScrollerWidth);
    const ro = new ResizeObserver(() => updateColumnSize());
    ro.observe(scroller);

    // --- Build dots container ---
    const existingDots = section.querySelector('.cb-custom-dots');
    if (existingDots) existingDots.remove();

    const dotsWrapper = document.createElement('div');
    dotsWrapper.className = 'cb-custom-dots';
    dotsWrapper.style.cssText =
      'display:flex;justify-content:center;gap:8px;padding:16px 0 8px;';

    const dotEls = [];
    for (let i = 0; i < totalPages; i++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('aria-label', 'Page ' + (i + 1));
      dot.style.cssText =
        'width:8px;height:8px;border-radius:50%;border:none;cursor:pointer;padding:0;' +
        'background:var(--color-border,#ccc);transition:background 0.3s,transform 0.3s;';
      dot.addEventListener('click', () => { stopAutoplay(); goToPage(i); });
      dotsWrapper.appendChild(dot);
      dotEls.push(dot);
    }

    // Insert dots after the carousel container
    const carousel = section.querySelector('.resource-list__carousel');
    if (carousel && carousel.parentNode) {
      carousel.parentNode.insertBefore(dotsWrapper, carousel.nextSibling);
    }

    // --- Page navigation ---
    let currentPage = 0;
    let autoplayTimer = null;
    const AUTOPLAY_SPEED = 3000;

    /**
     * Scroll target = page * scroller.clientWidth (exact, since columns are that wide).
     * Clamp to maxScroll for last page so partial pages never appear left-aligned.
     */
    function getPageScrollLeft(page) {
      const target = page * scroller.clientWidth;
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      return Math.min(target, Math.max(0, maxScroll));
    }

    function updateDots(page) {
      dotEls.forEach((d, i) => {
        const active = i === page;
        d.style.background = active
          ? 'var(--color-foreground,#333)'
          : 'var(--color-border,#ccc)';
        d.style.transform = active ? 'scale(1.3)' : 'scale(1)';
        d.setAttribute('aria-selected', String(active));
      });
    }

    function goToPage(page, smooth = true) {
      currentPage = Math.max(0, Math.min(page, totalPages - 1));
      scroller.scrollTo({
        left: getPageScrollLeft(currentPage),
        behavior: smooth ? 'smooth' : 'instant',
      });
      updateDots(currentPage);
    }

    /**
     * Intercept Shopify arrow clicks at capture phase (fires BEFORE the event
     * reaches the button, so Shopify's SlideshowSelectEvent is never dispatched).
     */
    section.addEventListener(
      'click',
      (e) => {
        const btn = e.target.closest(
          '.slideshow-control--previous, .slideshow-control--next'
        );
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();
        stopAutoplay();
        if (btn.classList.contains('slideshow-control--previous')) {
          goToPage(currentPage - 1 < 0 ? totalPages - 1 : currentPage - 1);
        } else {
          goToPage((currentPage + 1) % totalPages);
        }
      },
      true // capture phase
    );

    // Sync dots on touch/drag scroll
    let scrollTimer;
    scroller.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        let closest = 0;
        let minDiff = Infinity;
        for (let p = 0; p < totalPages; p++) {
          const diff = Math.abs(scroller.scrollLeft - getPageScrollLeft(p));
          if (diff < minDiff) { minDiff = diff; closest = p; }
        }
        if (closest !== currentPage) {
          currentPage = closest;
          updateDots(currentPage);
        }
      }, 80);
    });

    // --- Autoplay (our own) ---
    // Auto-rotating on mobile burns battery for a UX shoppers scroll past anyway, so skip
    // starting it below the mobile breakpoint. Reacts to the viewport crossing that
    // breakpoint (rotation, foldables, resizing a desktop window) via matchMedia.
    const mobileQuery = window.matchMedia('(max-width: 749px)');

    function startAutoplay() {
      stopAutoplay();
      if (mobileQuery.matches) return;
      autoplayTimer = setInterval(() => {
        goToPage((currentPage + 1) % totalPages);
      }, AUTOPLAY_SPEED);
    }

    function stopAutoplay() {
      if (autoplayTimer) { clearInterval(autoplayTimer); autoplayTimer = null; }
    }

    mobileQuery.addEventListener('change', () => {
      if (mobileQuery.matches) {
        stopAutoplay();
      } else {
        startAutoplay();
      }
    });

    section.addEventListener('mouseenter', stopAutoplay);
    section.addEventListener('mouseleave', startAutoplay);

    updateDots(0);
    startAutoplay();

    // Failsafe: re-kill Shopify's interval after its async connectedCallback finishes.
    // connectedCallback is async so the setInterval may start a few ms after our init.
    setTimeout(() => {
      const sw = section.querySelector('slideshow-component');
      if (!sw) return;
      sw.removeAttribute('autoplay');
      sw.setAttribute('paused', '');
      if (typeof sw.suspend === 'function') sw.suspend();
    }, 500);
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCollectionBrowseCarousel);
  } else {
    initCollectionBrowseCarousel();
  }

  // Re-run on Shopify section re-render (theme editor)
  document.addEventListener('shopify:section:load', (e) => {
    if (e.detail?.sectionId?.includes('collections_browse')) {
      setTimeout(initCollectionBrowseCarousel, 100);
    }
  });
})();
