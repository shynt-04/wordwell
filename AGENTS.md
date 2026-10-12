# Repository Guidelines

## Project Structure & Module Organization

The website's server and AI modules live in `vocab-app/`; `vocab-app/dist/` contains editable frontend source, not generated output. Website tests live in `vocab-app/tests/`. The standalone Windows wrapper lives in `portable-app/src/`, with packaging scripts and tests in sibling directories. Reuse the website source rather than copying it into the wrapper. Never commit `portable-app/release/`, `portable-app/build/`, dependency caches, or personal `data/` folders.

## Build, Test, and Development Commands

Use Node.js 24+. From the root: `npm start` runs the website, `npm run dev` watches its server, and `npm test` runs website and desktop unit tests. Install desktop dependencies with `npm --prefix portable-app ci`; `npm run app:dev` opens the desktop app, `npm run app:build` builds Windows x64 portable output, and `npm run app:test` tests the unpacked build with isolated temporary data. No root dependency installation is required for website tests.

## Coding Style & Naming Conventions

No language-specific style or formatter is established yet. Follow the conventions of the selected language and add formatter or linter configuration with the initial code. Use descriptive, consistent names; keep filenames aligned with their main module or feature, and avoid unexplained abbreviations.

## Testing Guidelines

Tests use Node's built-in test runner. Add tests with new behavior and bug fixes, use names that describe the behavior under test, and document the command contributors should run. Keep tests deterministic, use isolated databases/settings, and never send paid AI requests in automated checks. Verify the packaged desktop runtime as well as unit tests when changing packaging or startup behavior.

## Commit & Pull Request Guidelines

No Git history is available to establish a commit message convention. Use short, imperative commit subjects (for example, `Add note editor`) until the team establishes a standard. Pull requests should explain the change and its motivation, list relevant checks, link related issues when available, and include screenshots for user-visible interface changes.

## Configuration & Secrets

Do not commit credentials, tokens, or machine-specific settings. Provide safe examples in an environment template when configuration is introduced, and document required local setup without exposing secret values.
