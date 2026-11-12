---
id: export
title: Export designs to code and files
risk: high
paths:
  - packages/server/src/mcp.ts
  - packages/engine/src/render.ts
  - packages/engine/src/tokens.ts
  - packages/engine/src/motion.ts
  - packages/engine/src/prototype.ts
  - packages/engine/src/icons.ts
  - packages/engine/src/capabilities.ts
  - packages/editor/src/Run.tsx
docs:
  - docs/SPEC.md
acceptance:
  - id: AC-1
    text: HTML export is a standalone page with tokens, dark mode, reduced motion and component states
  - id: AC-2
    text: Layer JavaScript is included in exports and left out of previews
  - id: AC-3
    text: Stored document content can never inject markup into exported output
  - id: AC-4
    text: Token export produces CSS variables for light and dark, and JSON
  - id: AC-5
    text: Motion export produces transitions, keyframes and reduced-motion variants
  - id: AC-6
    text: Prototype export is a standalone HTML file
  - id: AC-7
    text: Icon sets export as SVG files, React components or a sprite
  - id: AC-8
    text: Frames export as PNG, WebP or JPEG at 1x to 3x
  - id: AC-9
    text: Only permitted roles can run an export
  - id: AC-10
    text: Export failures give a readable error and the downloaded file gets a usable name
---

# Export

Covers the `export`, `prototype_export`, `icon_export` and `image_export` MCP tools and the editor's HTML download.
