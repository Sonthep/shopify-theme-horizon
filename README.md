# Shopify Horizon — Storefront Customization

A Shopify theme repository with a custom A–Z brand directory for the Sevenfive storefront.

**Focus:** Shopify · Liquid · Responsive storefront UI  
**ภาษาไทย:** งานปรับแต่งธีม Shopify Horizon พร้อมหน้ารวมแบรนด์ที่จัดกลุ่มตามตัวอักษรและเชื่อมไปยัง Collection

## Project scope

This repository contains a Horizon-based Shopify theme. The feature highlighted here is [sections/brand-directory.liquid](sections/brand-directory.liquid). Standard theme sections and infrastructure belong to the underlying theme; they are not presented as original custom features.

## Custom feature: Brand directory

The current implementation:

1. Reads an explicit `vendor_handles` list in the Liquid section.
2. Resolves matching Shopify collections and sorts their titles.
3. Groups the entries by first letter, with a `#` group for other characters.
4. Renders collection images, or the collection title when an image is absent.
5. Filters groups through A–Z, `#`, and All Brand buttons.
6. Links each brand card to its collection.

The grid changes from five columns to three and then two at the defined screen-width breakpoints.

**Data maintenance:** This version uses a curated handle list. Adding a new product vendor alone does not automatically add it to the directory.

## Managing brand entries

- Create or update the brand collection in Shopify Admin.
- Add its handle to `vendor_handles` in the section.
- Set the collection title and image.
- Preview the alphabetical group, card link, and image fallback.

The page template configuration is in [templates/page.json](templates/page.json). Check its assignments before changing a shared page template.

## Source guide

| Location | Responsibility |
| --- | --- |
| [sections/](sections/) | Theme sections, including the custom directory |
| [blocks/](blocks/) | Theme blocks |
| [snippets/](snippets/) | Reusable Liquid fragments |
| [templates/](templates/) | Page templates |
| [layout/](layout/) | Main theme layouts |
| [assets/](assets/) | Styles, scripts, and media |
| [config/](config/) | Theme schema and saved settings |
| [locales/](locales/) | Theme translations |

## Development workflow

Use Shopify CLI with access to your own development store. Clone this repository, enter its directory, and preview against that store:

```bash
git clone https://github.com/Sonthep/shopify-theme-horizon.git
cd shopify-theme-horizon
shopify theme dev --store your-development-store.myshopify.com
```

The store domain is a placeholder to replace with your development store. Use the installed CLI's help for authentication and environment requirements.

Run `shopify theme check` and review the directory in the development preview. Existing base-theme findings should be distinguished from changes introduced by a contribution.

For manual review, check All Brand, an individual letter, the `#` group, narrow screens, missing images, and collection links. These are review steps, not recorded test results.

## Implementation boundaries

- The brand list is maintained in code.
- Filter labels in this custom section are hardcoded.
- Filtering runs in browser JavaScript.
- The section uses document-wide selectors, so multiple instances need additional scoping.
- The current custom section does not contain a schema block for configurable Theme Editor settings.

## Credits and rights

Based on Shopify Horizon. Customization is presented separately from the base theme. Shopify and company brand assets remain subject to their respective rights.

[Sonthep on GitHub](https://github.com/Sonthep)
