# Whiteboard

A clean, modern whiteboard webapp — text, headings, sticky notes, images, and connected lines on an infinite canvas. Vanilla HTML + CSS + JS. No build step. Deploys to Vercel as a static site.

## Quick start

Open `index.html` in any modern browser, or run a local server:

```bash
npx serve .
```

## Deploy to Vercel

1. Push this repo to GitHub
2. Import it at [vercel.com/new](https://vercel.com/new)
3. No build settings needed — it's a static site

Or via CLI:

```bash
npm i -g vercel
vercel
```

## Features

- **Text** — body, heading, sticky note presets with full typography controls (font, size, weight, italic, underline, alignment, color, fill)
- **Images** — drag-and-drop, paste from clipboard, or click to upload
- **Lines** — `Ctrl + drag` to draw a connected line between nodes (smart edge snapping, follows nodes when they move)
- **Multi-select** — drag empty space to marquee-select, `Shift+click` to add/remove, `Ctrl+A` to select all
- **Group ops** — move, duplicate, delete, restyle the whole selection at once
- **Undo / Redo** with full history
- **Auto-save** to `localStorage`
- **PNG export** of the whole board

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Select area | Drag empty |
| Pan | Space + drag |
| Zoom | Scroll |
| Reset view | `0` |
| Edit text | Double-click |
| Draw line | Ctrl + drag |
| Multi-select | Shift + click |
| Select all | Ctrl + A |
| Duplicate | Ctrl + D |
| Copy / Paste | Ctrl + C / V |
| Undo / Redo | Ctrl + Z / Ctrl + Shift + Z |
| Bold / Italic / Underline | Ctrl + B / I / U |
| Delete | Del |
| Nudge | Arrows (Shift = 10px) |
| Shortcuts panel | `?` |

## Design system

All visual tokens live at the top of [`styles.css`](styles.css) under `:root` — colors, spacing, radii, shadows, typography. Re-skin the whole app by editing those variables.

The current theme uses the warm-paper Mercury/Ramp palette with **Geist** typography and a forest-green accent.
