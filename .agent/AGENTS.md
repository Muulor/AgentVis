## Working agreements

- The project uses ESLint, Husky, lint-staged, and i18n.
- New feature components must include a header comment. Any newly added component files must be updated in PROJECT_STRUCTURE.md.
- When adding or modifying user-visible copy, Toasts, error messages, chat bubble content, tool observations, or system/tool response messages that affect agent decision-making, prioritize using the existing i18n setup to avoid hardcoding Chinese or English. Internal logs and pure debug information do not strictly require i18n.
- During normal feature work, format only the files changed by the task. Run the global formatter only for an explicit formatting migration on a clean, dedicated `style/` or `chore/` branch, and keep that commit free of business changes.
- After modifying TS/TSX files, run `eslint --fix --quiet` and Prettier on the changed files, then run `tsc --noEmit`. Run affected tests for behavioral changes.
- After modifying JS/MJS/CSS files, run Prettier on the changed files and verify affected scripts or UI behavior.
- After modifying Rust files, run `cargo check`; run affected Rust tests for behavioral changes.
- Before merging, run `npm run quality`. Before releases or broad refactors, run `npm run quality:full`.
- Treat `.gitattributes` as the source of truth for line endings and `.editorconfig` as the editor baseline. Do not include unrelated line-ending-only changes.
- Change Prettier versions or formatting rules only in dedicated `style/` or `chore/` commits.
