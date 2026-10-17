<!-- Adapted from the original open-source skill for an agent that only reads and edits project files: the parts that need a browser session or another framework were removed; the rest is unchanged. License: see LICENSE.txt in this folder. -->

# LCP optimization reference

## What is LCP?

Largest Contentful Paint (LCP) measures when the largest content element in the viewport becomes visible. This is typically:

- An `<img>` element
- An `<image>` element inside `<svg>`
- A `<video>` element with poster image
- An element with a background image via `url()`
- A block-level element containing text nodes

## LCP timeline

```
[  Server Response  ][  Resource Load  ][  Render  ]
       TTFB              Download         Paint
       └─────────────────────────────────────┘
                         LCP Time
```

## Detailed optimizations

### 1. Server response time (TTFB)

Target: < 800ms

**Causes:**
- Slow server/database queries
- No CDN/edge caching
- Inefficient backend code
- Cold starts (serverless)

**Solutions:**
```javascript
// Use edge functions for dynamic content
// Vercel example
export const config = { runtime: 'edge' };

// Use stale-while-revalidate caching
// Cache-Control header
res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
```

### 2. Resource load time

**For images:**
```html
<!-- Preload only when a trace shows the LCP image is discovered late -->
<link rel="preload" as="image" href="/hero.webp" 
      imagesrcset="/hero-400.webp 400w, /hero-800.webp 800w"
      imagesizes="100vw"
      fetchpriority="high">

<!-- Modern format with fallback -->
<picture>
  <source srcset="/hero.avif" type="image/avif">
  <source srcset="/hero.webp" type="image/webp">
  <img src="/hero.jpg" width="1200" height="600" 
       fetchpriority="high" alt="Hero">
</picture>
```

**For text (web fonts):**
```css
@font-face {
  font-family: 'Heading';
  src: url('/fonts/heading.woff2') format('woff2');
  font-display: swap; /* Show fallback immediately */
}
```

### 3. Render blocking resources

**Critical CSS pattern:**
```html
<head>
  <!-- Inline critical CSS -->
  <style>
    /* Only above-fold styles, < 14KB */
    .hero { /* ... */ }
    .nav { /* ... */ }
  </style>
  
  <!-- Defer non-critical CSS -->
  <link rel="preload" href="/styles.css" as="style" 
        onload="this.onload=null;this.rel='stylesheet'">
</head>
```

**Defer JavaScript:**
```html
<!-- ❌ Blocks parsing -->
<script src="/app.js"></script>

<!-- ✅ Deferred (runs after HTML parsed) -->
<script defer src="/app.js"></script>

<!-- ✅ Module (deferred by default) -->
<script type="module" src="/app.mjs"></script>
```

## Common issues

| Issue | Evidence to confirm | Typical fix |
|-------|---------------------|-------------|
| LCP resource discovered late | Large resource load delay in `LCPBreakdown` or `LCPDiscovery` | Put it in initial HTML, add priority, and preload only when still necessary |
| Large image transfer | Resource load duration and response bytes dominate | Resize/compress and choose an appropriate format |
| Render-blocking CSS | `RenderBlocking` insight and long render delay | Remove unused rules, split non-critical CSS, or inline only proven critical CSS |
| Slow TTFB | `DocumentLatency` insight or LCP TTFB subpart dominates | Cache, reduce redirects, or optimize server work |
| Client-rendered LCP | LCP element absent from initial HTML and render delay dominates | SSR, static rendering, or earlier rendering |

Do not attach generic millisecond savings to these fixes. Measure the relevant LCP subpart before and after under equivalent conditions.
