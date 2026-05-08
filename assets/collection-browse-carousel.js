/**
 * Custom dots + autoplay for Shop by Category (2-row grid carousel)
 * The built-in slideshow JS hides controls when scrollWidth <= offsetWidth,
 * which happens with CSS Grid. This script creates standalone dots + autoplay.
 */
(function () {
  function initCollectionBrowseCarousel() {
    const section = document.querySelector('[id$="_collections_browse"]');
    if (!section) return;

    const scroller = section.querySelector('slideshow-slides');
    if (!scroller) return;

    // Calculate how many "pages" we have (columns per page = 4)
    const COLS_PER_PAGE = 4;
    const ROWS = 2;
    const ITEMS_PER_PAGE = COLS_PER_PAGE * ROWS;
    const slides = scroller.querySelectorAll('.resource-list__slide');
    const totalItems = slides.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);

    if (totalPages <= 1) return;

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
      dot.addEventListener('click', () => goToPage(i));
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

    function getPageScrollLeft(page) {
      const slideEl = slides[page * ITEMS_PER_PAGE];
      if (!slideEl) return 0;
      // offsetLeft relative to scroller
      return slideEl.offsetLeft - (scroller.offsetLeft || 0);
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

    // Sync dots on manual scroll
    let scrollTimer;
    scroller.addEventListener('scroll', () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        // Find which page is most visible
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

    // --- Autoplay ---
    function startAutoplay() {
      stopAutoplay();
      autoplayTimer = setInterval(() => {
        goToPage((currentPage + 1) % totalPages);
      }, AUTOPLAY_SPEED);
    }

    function stopAutoplay() {
      if (autoplayTimer) { clearInterval(autoplayTimer); autoplayTimer = null; }
    }

    // Pause on hover
    section.addEventListener('mouseenter', stopAutoplay);
    section.addEventListener('mouseleave', startAutoplay);

    updateDots(0);
    startAutoplay();
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
