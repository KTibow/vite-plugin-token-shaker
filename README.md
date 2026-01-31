# vite-plugin-token-shaker

CSS variables can't be easily tree shaken by default, even when they represent things like tokens. This plugin makes it so if you declare them in a `tokens` layer:
```css
@layer tokens {
  :root {
    --color-primary: #ff0000;
    --spacing-small: 8px;
  }
}
```
each goes one of four routes:

## 1. Deletion
If `var(--spacing-small)` never shows up anywhere, we can safely remove `--spacing-small`.

## 2. Nothing
If `--spacing-small` is redefined somewhere, we keep it verbatim for safety.

## 3/4. Mangling/Inlining
At this point, these variables have become just fancy constants. We group them by value, and either inline them (if it would use less space) or keep them in mangled form (like `--_0:#f00`).

## Why this syntax?
It doesn't assume this plugin is active, doesn't break when other plugins are active, and works with all types of content (eg `@property` doesn't work with `rem`). It was the best choice for M3 Svelte.
