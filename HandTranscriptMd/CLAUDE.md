# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HandTranscriptMd is an Obsidian plugin that embeds a stylus/mouse handwriting canvas inside `.md` files and converts the handwriting to structured Markdown via a self-hosted **Turnstone** OCR server. Works on desktop (Windows) and mobile (Android with stylus).

The `README.md` in this same directory is the primary reference — it contains a full architecture walkthrough, a "what file to open for a given task" table, two data-flow diagrams (draw→save, draw→OCR→Markdown), and a maintainability cheat sheet for common changes (add toolbar button, add setting, add OCR keyword, add language, add embed format). Read it before making non-trivial changes; this file only summarizes what's needed to get productive fast plus repo-specific commands.

## Commands

All commands run from this directory (`HandTranscriptMd/`), not the repo root.

- `npm run dev` — esbuild in watch mode, inline sourcemap, unminified (`src/main.ts` → `main.js`)
- `npm run build` — type-checks (`tsc -noEmit -skipLibCheck`) then produces a minified production `main.js` with no sourcemap
- `npm run lint` — `eslint src/`
- `npx tsc --noEmit` — type-check only, no build (esbuild does **not** type-check, so run this to catch type errors)
- `npx tsx src/parser.test.ts` — run the markdown-parser unit tests (`src/parser.test.ts`). There is no test runner framework; it's a standalone script with an inline `expect().toBe()`/`toContain()` helper. There is no `npm test` script — invoke `tsx` directly.
- `npm run version` — bumps `manifest.json`/`versions.json` from `package.json`'s version (via `version-bump.mjs`) and stages both files

CI (`.github/workflows/lint.yml`) runs on every push/PR against Node 20.x and 22.x: `npm ci`, `npm run build --if-present`, `npm run lint`.

## Repo layout note

The git repository root is the parent directory (`custom-handscriptedmd/`), but the actual npm package / plugin source lives one level down in `custom-handscriptedmd/HandTranscriptMd/`. Always run npm/tsc/eslint commands from `HandTranscriptMd/`.

## Architecture essentials

- **Build**: esbuild bundles everything starting from `src/main.ts` into a single `main.js`. The `obsidian` package (plus Electron/CodeMirror/@lezer packages and Node builtins) is marked `external` in `esbuild.config.mjs` — never let it get bundled. `main.js` is generated and gitignored; don't hand-edit it.
- **Three files Obsidian actually loads**: `main.js`, `manifest.json`, `styles.css`. Everything under `src/` compiles down to `main.js`.
- **Two embed formats** coexist and must both be kept working when touching embed/save/convert/delete logic:
  - Wiki (current default): `![[_handwriting/hw_xxx.svg]]`, detected via a `MutationObserver` in `embed.ts` (Obsidian renders this itself; there's no processor hook for it).
  - Legacy code block: `` ```handwriting ``` ``, handled via `registerMarkdownCodeBlockProcessor`.
  - `editor-view.ts` has module-level helpers (`wikiEmbedRegex()`, `codeBlockRegex()`, `replaceInMdFile()`) that try wiki format first, then fall back to legacy — follow this fallback pattern when adding a third format.
- **Two Obsidian UI shells share one editor**: `DrawingModal` (desktop, fullscreen overlay) and `DrawingEditorView extends ItemView` (Android, new tab) are different Obsidian base classes, but both call the shared `buildEditorUI()` in `editor-view.ts` — add toolbar buttons there once, not in both classes.
- **Plugin-level shared state** (on the main plugin class in `main.ts`) coordinates preview (`embed.ts`) and editor (`editor-view.ts`): `previewCallbacks`, `embedPaths`, `bgModeListeners`, `embedActions`.
- **OCR pipeline**: SVG → PNG (`svgToBase64Png()` in `svg-utils.ts`, drawn onto a temp `<canvas>`) → `TurnstoneRecognizer.recognize()` in `recognizer.ts` (POSTs a temporary Turnstone workstream with the image, polls for the assistant response, deletes the workstream) → `parseHandwritingToMarkdown()` in `md-parser.ts` (keyword expansion) → written back into the `.md` file → original SVG archived to `_handwriting/_converted/`.

## Conventions that must stay in sync across files

- **OCR keywords** (`//H1`, `//LIST`, etc.): adding one requires a change in *both* `src/md-parser.ts` (`expandKeywords()` — actual parsing) *and* `src/settings.ts` (`KEYWORDS` constant — the settings-page reference table). They will silently drift out of sync otherwise.
- **i18n**: every UI string key must be added to `src/locales/en.json` (the fallback/reference locale) *and* all other locale files (`it`, `de`, `fr`, `es`, `ru`, `ja`, `zh-cn`, `pt-br`, `pl`). `t()` in `i18n.ts` falls back to English for missing keys, so a partial rollout won't crash, but keep locales complete.
- **Version**: `package.json` and `manifest.json` both carry a `version` field and must match; use `npm run version` rather than editing them by hand.
- **CSS**: all classes use the `hwm_` prefix (e.g. `hwm_portal-panel`, `hwm_toolbar`) to avoid collisions with Obsidian/other plugins. Everything lives in the single root `styles.css` — no CSS-in-JS.

## Gitignored, locally-kept files

`deploy.sh` / `cloudDeploy.sh` (copy build output to a local/Google Drive vault for testing) and `NOTES.md` (dev session log) are excluded from the repo per `.gitignore` — they may or may not exist locally depending on the machine. Don't assume their presence, and don't commit them if created.
