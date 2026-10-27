<div align="center">

# 🛍️ Shopify Theme — Horizon

### sevenfive-4062 Store

[![Shopify](https://img.shields.io/badge/Shopify-96BF48?style=for-the-badge&logo=shopify&logoColor=white)](https://sevenfive-4062.myshopify.com)
[![Theme](https://img.shields.io/badge/Theme-Horizon-blue?style=for-the-badge)](https://admin.shopify.com/store/sevenfive-4062/themes/154216825031)
[![GitHub](https://img.shields.io/badge/GitHub-shopify--theme--horizon-181717?style=for-the-badge&logo=github)](https://github.com/Sonthep/shopify-theme-horizon)

</div>

---

## 📋 Project Info

| Key | Value |
|-----|-------|
| **Store** | sevenfive-4062.myshopify.com |
| **Theme** | Horizon |
| **Theme ID** | `154216825031` |
| **Repository** | https://github.com/Sonthep/shopify-theme-horizon |

---

## 🗂️ Project Structure

```
sevenfive-theme-154216825031/
│
├── 📁 assets/          → CSS, JS, และรูปภาพ
├── 📁 blocks/          → Block snippets (logo, text, menu ฯลฯ)
├── 📁 config/
│   ├── settings_data.json    → ค่า settings ที่ใช้งานอยู่
│   └── settings_schema.json  → Schema definition ของ settings
├── 📁 layout/
│   ├── theme.liquid          → Main layout template
│   └── password.liquid       → Password page layout
├── 📁 locales/         → ไฟล์แปลภาษา (en, th, ja, de, fr ฯลฯ)
├── 📁 sections/        → Section files
├── 📁 snippets/        → Reusable Liquid snippets
└── 📁 templates/       → Page template JSON files
```

---

## 📄 Templates

| ไฟล์ | หน้า |
|------|------|
| `index.json` | 🏠 Home page |
| `product.json` | 🛒 Product detail |
| `collection.json` | 📦 Collection listing |
| `list-collections.json` | 📋 All collections |
| `cart.json` | 🛍️ Shopping cart |
| `blog.json` | 📝 Blog listing |
| `article.json` | 📰 Blog post |
| `search.json` | 🔍 Search results |
| `page.json` | 📌 Generic page (**Brand Directory**) |
| `page.contact.json` | 📞 Contact page |
| `404.json` | ❌ 404 error |
| `password.json` | 🔒 Store password |
| `gift_card.liquid` | 🎁 Gift card |

---

## 🧩 Sections

### ✨ Custom Sections

| ไฟล์ | คำอธิบาย |
|------|----------|
| `brand-directory.liquid` | **Brand Directory** — แสดงแบรนด์ทั้งหมดจัดกลุ่ม A–Z พร้อม filter ปุ่มตัวอักษร |

### 🏗️ Base Theme Sections

<details>
<summary>ดูทั้งหมด (คลิกเพื่อขยาย)</summary>

| ไฟล์ | คำอธิบาย |
|------|----------|
| `hero.liquid` | Hero banner (image/video) |
| `slideshow.liquid` | Full slideshow |
| `layered-slideshow.liquid` | Parallax layered slideshow |
| `carousel.liquid` | Product/content carousel |
| `featured-product.liquid` | Single featured product |
| `featured-product-information.liquid` | Product info block |
| `product-list.liquid` | Product grid |
| `product-hotspots.liquid` | Shoppable image with hotspots |
| `collection-list.liquid` | Collection grid |
| `collection-links.liquid` | Collection link cards |
| `media-with-content.liquid` | Split media + content |
| `logo.liquid` | Logo/brand list |
| `marquee.liquid` | Scrolling marquee text |
| `featured-blog-posts.liquid` | Blog post cards |
| `divider.liquid` | Horizontal divider |
| `custom-liquid.liquid` | Custom Liquid/HTML |
| `header.liquid` | Site header + navigation |
| `header-announcements.liquid` | Announcement bar |
| `footer.liquid` | Site footer |
| `footer-utilities.liquid` | Footer utility links |
| `main-page.liquid` | Default page renderer |
| `main-collection.liquid` | Collection page |
| `main-blog.liquid` | Blog listing |
| `main-blog-post.liquid` | Blog post |
| `main-cart.liquid` | Cart page |
| `main-collection-list.liquid` | All collections |
| `main-404.liquid` | 404 page |
| `predictive-search.liquid` | Live search |
| `search-header.liquid` | Search page header |
| `search-results.liquid` | Search results |
| `product-information.liquid` | Product info (PDP) |
| `product-recommendations.liquid` | Related products |
| `quick-order-list.liquid` | Quick order form |
| `password.liquid` | Password page |

</details>

---

## ⭐ Custom Feature: Brand Directory

> **Section:** `sections/brand-directory.liquid`  
> **Template:** `templates/page.json`

### วิธีทำงาน

```
collections.all.products
    ↓  map: 'vendor' | uniq | sort
รายชื่อแบรนด์ทั้งหมด
    ↓  จัดกลุ่มตามตัวอักษรแรก
Brand Group A, B, C ...
    ↓  JavaScript filter
แสดงเฉพาะกลุ่มที่เลือก
```

1. **ดึงข้อมูล** — vendor จากสินค้าทุกชิ้นใน store
2. **Filter Bar** — ปุ่ม A–Z + "All Brand" บน toolbar
3. **จัดกลุ่ม** — แต่ละกลุ่มมี label ตัวอักษรกำกับ
4. **โลโก้** — ถ้า collection handle ตรงกับ vendor → แสดงรูป
5. **Fallback** — ถ้าไม่มีโลโก้ → แสดงชื่อแบรนด์เป็น text

### เพิ่มโลโก้แบรนด์

```
Shopify Admin → Collections → Create collection
  Name    = "Absolute"       ← ตรงกับ vendor name
  Handle  = "absolute"       ← lowercase, no spaces
  Image   = brand-logo.png   ← จะแสดงอัตโนมัติในหน้า Brand Directory
```

---

## 💻 Local Development

### Prerequisites

```bash
# ติดตั้ง Shopify CLI
npm install -g @shopify/cli @shopify/theme
```

| Tool | Version |
|------|---------|
| Node.js | 18+ |
| Shopify CLI | 3.x |

### Commands

```bash
# ดึง theme ล่าสุดจาก Shopify
shopify theme pull --theme=154216825031

# Preview แบบ live reload
shopify theme dev --theme=154216825031

# Push ขึ้น Shopify
shopify theme push --theme=154216825031
```

---

## 🔄 Git Workflow

```bash
# 1. แก้ไขไฟล์ตามต้องการ

# 2. Commit & Push ขึ้น GitHub
git add -A
git commit -m "feat: describe your changes"
git push

# 3. Push ขึ้น Shopify
shopify theme push --theme=154216825031
```

---

## 🌐 Localization

รองรับ **30+ ภาษา** — ไฟล์อยู่ใน `locales/`

| Pattern | ใช้สำหรับ |
|---------|----------|
| `{lang}.json` | Storefront text translations |
| `{lang}.schema.json` | Theme editor label translations |
| `en.default.json` | ภาษาค่าเริ่มต้น (English) |

---

## 📌 Notes

> ⚠️ **อย่าแก้ไข** `config/settings_data.json` โดยตรง — ใช้ **Theme Editor** ใน Shopify Admin แทน

- Theme ใช้ **Shopify Online Store 2.0** (`content_for 'blocks'` pattern)
- Section settings ใช้ translation keys `t:settings.xxx` จาก `locales/en.default.schema.json`
- ทุก section ต้องมี `{% schema %}` block พร้อม `"name"` และ `"presets"`

---

<div align="center">
  <sub>Built with ❤️ for sevenfive-4062 · Powered by Shopify Horizon Theme</sub>
</div>
