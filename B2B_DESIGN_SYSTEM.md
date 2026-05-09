# B2B Premium Ecommerce Design System

This theme direction is designed for a large industrial catalog with 50,000+ SKUs.
It combines the scanning efficiency of WebstaurantStore, the calm premium spacing of Crate & Barrel,
the consistency of IKEA layout systems, and Apple-like restraint in spacing and hierarchy.

## Principles

- Clean modern industrial aesthetic
- Premium, but never decorative or luxury-coded
- White-space driven layouts with strong alignment
- Fast catalog scanning and comparison
- Mobile-first with desktop density scaling up cleanly
- Green and white as the core palette, supported by neutral surfaces and borders

## Color System

- Primary green: `#1F6B4D`
- Hover green: `#17553D`
- Deep green: `#123B2B`
- Surface: `#FFFFFF`
- Soft surface: `#F3F8F5`
- Border: `#D9E3DD`
- Text: `#1C1F1D`
- Muted text: `#5E6A63`

## Typography Scale

- Display: `56/64`, weight `600`, for rare brand-led moments
- H1: `40/48`, weight `600`, for page and collection titles
- H2: `32/40`, weight `600`, for major section titles
- H3: `24/32`, weight `600`, for category blocks and feature panels
- H4: `20/28`, weight `600`, for card titles and sidebar headings
- Body: `16/24`, weight `400-500`, for standard product and editorial copy
- Body small: `14/20`, weight `400`, for specs, labels, and supporting metadata
- Meta: `12/16`, weight `500`, for SKU, pack size, lead time, and inventory state

Rules:

- Use weight and size for hierarchy instead of decorative styling.
- Keep letter spacing neutral.
- Favor short line lengths in editorial modules and dense scan-friendly rows in catalog modules.

## Spacing System

Base unit: `8px`

- 4px: micro gaps, icon offsets, tight chips
- 8px: compact internal spacing
- 16px: default card padding and small component gaps
- 24px: standard component spacing
- 32px: section sub-groups and content separation
- 40px: desktop section padding minimum
- 48px: standard section rhythm
- 64px: major section spacing
- 80px: hero or campaign spacing
- 96px: premium landing page breathing room

Rules:

- Keep all spacing on the 8px rhythm.
- Use 40px minimum vertical spacing between standard sections on desktop.
- Use tighter but still structured spacing on mobile to preserve catalog density.

## Card System

- Radius: `12px`
- Border: `1px solid` neutral border color
- Shadow: subtle only, mainly on hover or elevated overlays
- Surface: white by default, soft green-tinted surface for supporting modules

Product card structure:

- Image
- Title
- Key spec line
- Price or quote prompt
- Availability or lead time
- Bulk or quick-order actions

Rules:

- Keep card content aligned across rows for easy comparison.
- Preserve space for SKU, pack size, and unit pricing.
- Use subtle hover lift and shadow, never dramatic zoom.

## Button System

- Primary: filled green, white text, `44px` minimum height
- Secondary: white background, green border, green text
- Tertiary: ghost or text button for secondary actions
- Utility: compact icon button for filters, compare, wishlist, and saved lists

Rules:

- Keep radius consistent with the card system.
- Use clear state differences for hover, focus, disabled, and selected.
- Prioritize reorder, quote, and add-to-cart actions in catalog contexts.

## Responsive Rules

- Mobile-first foundation from `320px`
- Breakpoints: `480`, `768`, `1024`, `1280`, `1440`
- Desktop container max width: `1440px`
- Gutters: `16px` mobile, `24px` tablet, `40px` desktop, `48px` wide layouts

Rules:

- Catalog grids should scale from 2 columns on mobile to 4 or 5 on desktop.
- Filters should become a drawer on mobile and a persistent column on desktop.
- Product metadata should remain visible without forcing excessive vertical stacking.

## Section Spacing Rules

- Dense commerce sections: `48-64px`
- Standard marketing sections: `64-80px`
- Hero sections: `96px+`
- Minimal utility sections: `32-40px`

Rules:

- Separate sections with space first, not heavy dividers.
- Keep section spacing consistent across page templates.
- Let content density vary, but not the rhythm around it.

## Grid Rules

- Desktop grid: 12 columns
- Tablet grid: 8 columns
- Mobile grid: 4 columns
- Product listing pages: fixed rhythm first, fluid columns second
- Editorial layouts: can be asymmetric, but outer gutters stay consistent

Rules:

- Maintain shared left alignment across modules for fast visual scanning.
- Keep title and metadata baselines aligned in product cards.
- Use wide grids for category navigation and dense grids for SKU discovery.

## Header Behavior

- Sticky header by default
- Compact on scroll
- Search remains prominent and easy to access
- Account, saved lists, orders, and cart should remain first-class actions
- Transparent header should be limited to brand-led landing pages

Rules:

- Keep the header utilitarian and lightweight.
- Avoid oversized navigation chrome on catalog pages.
- Preserve fast access to search and account actions.

## Mega Menu Behavior

- Open on hover and focus with a short delay
- Close on pointer leave and Escape
- Use a wide aligned panel with clear column structure
- Support category hierarchy, featured brands, and quick commerce actions
- Collapse overflow into a secondary menu or drawer when content exceeds available width

Rules:

- Keep mega menus keyboard accessible.
- Use internal scrolling for long category trees.
- Optimize for navigation speed, not animation complexity.
