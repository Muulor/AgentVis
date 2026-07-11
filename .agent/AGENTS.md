## Working agreements

- The project uses ESLint, Husky, lint-staged, and i18n.
- New feature components must include a header comment. Any newly added component files must be updated in PROJECT_STRUCTURE.md.
- When adding or modifying user-visible copy, Toasts, error messages, chat bubble content, tool observations, or system/tool response messages that affect agent decision-making, prioritize using the existing i18n setup to avoid hardcoding Chinese or English. Internal logs and pure debug information do not strictly require i18n.
- After modifying TS/TSX files, please run `eslint --fix --quiet` on the changed files, and run `tsc --noEmit`.
- After modifying Rust files, run `cargo check`.