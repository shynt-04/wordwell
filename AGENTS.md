# Repository Guidelines

## Project Structure & Module Organization

This directory currently contains no application source, tests, assets, or build configuration. As the project takes shape, keep production code in a clearly named source directory (for example, `src/`), tests in `tests/` or alongside the modules they cover, and static resources in `assets/`. Keep related functionality together and avoid committing generated output or dependency caches.

## Build, Test, and Development Commands

No build, test, or run commands are configured yet. When adding a toolchain, document its setup and standard commands here and in the project README. Prefer commands that work from the repository root, such as `npm test` or `python -m pytest`, once the corresponding configuration exists.

## Coding Style & Naming Conventions

No language-specific style or formatter is established yet. Follow the conventions of the selected language and add formatter or linter configuration with the initial code. Use descriptive, consistent names; keep filenames aligned with their main module or feature, and avoid unexplained abbreviations.

## Testing Guidelines

There is no test framework or coverage target configured. Add tests with new behavior and bug fixes, use names that describe the behavior under test, and document the command contributors should run. Keep tests deterministic and independent of local machine state.

## Commit & Pull Request Guidelines

No Git history is available to establish a commit message convention. Use short, imperative commit subjects (for example, `Add note editor`) until the team establishes a standard. Pull requests should explain the change and its motivation, list relevant checks, link related issues when available, and include screenshots for user-visible interface changes.

## Configuration & Secrets

Do not commit credentials, tokens, or machine-specific settings. Provide safe examples in an environment template when configuration is introduced, and document required local setup without exposing secret values.
