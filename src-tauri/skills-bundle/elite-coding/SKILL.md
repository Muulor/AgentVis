---
name: elite-coding
description: Use this skill for coding tasks in AgentVis, especially when a sub-agent is assigned feature implementation, bug investigation, refactoring, testing, or architecture work. The skill provides a risk-scaled workflow: default to minimal, integrated code changes; load TDD, systematic debugging, or architecture references only when the task type requires them; always maintain a concise handoff after each stage.
---

# Elite-Coding skill for AgentVis

Follow this guide for coding tasks in the AgentVis master brain/sub-agent serial loop. The goal is not to perform every ceremony for every change; the goal is to preserve engineering quality, minimize regression risk, and leave durable context for the next sub-agent.

> [!IMPORTANT]
> 1. **VCS safety first**: inspect the repository state before editing. For a brand-new project, initialize Git and create a baseline commit only when the workspace is clearly new or the master brain/user has asked for it. Before major feature work, bug fixes, or refactoring, establish a rollback checkpoint by recording current status/diff or by committing only when explicitly approved. Never include unrelated user changes in a checkpoint.
> 2. **Use the right workflow for the task**: read `references/test-driven-development.md` for behavior-bearing core logic, bug fixes with a reproducible behavior, public contract changes, and refactoring. Read `references/systematic debugging.md` before fixing bugs, test failures, build failures, or unexpected behavior. Read `references/architect_guidelines.md` for large, ambiguous, or architecture-shaping work.
> 3. **Handoff is mandatory in AgentVis**: every sub-agent must update a handoff file before completion or interruption. The handoff is the durable context bridge for the next sub-agent after this sub-agent's context is cleared.
> 4. **Verify narrowly**: run the smallest meaningful checks that cover the changed behavior. If verification is impossible, record why and what remains risky in the handoff.
---

# Workflow Routing

Use the lightest workflow that protects the task:

| Task type | Required workflow |
| --- | --- |
| Small local implementation | Read nearby code, follow existing patterns, make minimal changes, run targeted checks, update handoff |
| Bug, test failure, build failure, unexpected behavior | Follow `references/systematic debugging.md`; capture root cause and verification in handoff |
| Behavior-bearing logic, public API/contract changes, refactoring | Follow `references/test-driven-development.md` when a reasonable automated test seam exists |
| Visual/UI-only or configuration changes | Use targeted validation, such as the desktop-control or agent-browser skills, to test and verify interactive features, run builds/typechecks, or follow manual reproduction notes. |
| Large feature, unclear decomposition, cross-layer design | Produce or update architecture notes using `references/architect_guidelines.md` |

# Part I: Universal Principles

## 1. Code Quality & DRY
1. **NO PSEUDO-CODE**: All generated code must be production-ready. No `// rest of implementation...`.
2. **Abstraction over duplication**: If repeated logic appears in multiple places, consider extracting a reusable function/module. Avoid premature abstractions for one-off, simple code.
3. **Check before writing**: Verify if similar functionality already exists in the codebase.
### Practice Guide
```
❌ Wrong: Copy a user input processing block to 5 different places
✅ Right: Create a validateUserInput() utility function, call it where needed
```

## 2. Single Responsibility (SRP)
1. **One function, one job**: If you need "and" to describe it, split it.
2. **File size (soft limits)**:
   - Function >50 lines → review for split opportunities (data pipelines & large match/switch may be exempt)
   - File >500 lines → strongly consider splitting (Rust: 400-500 lines, due to verbose patterns)
   - Class >10 methods → review responsibilities
3. **Orchestration pattern**: Complex workflows should be a thin orchestrator calling focused sub-functions.
### Practice Guide
```
❌ Wrong: processUserData() handles validation, transformation, storage, and notifications
✅ Right:
   - validateUserData()  → Validation
   - transformUserData() → Transformation
   - saveUserData()      → Storage
   - notifyUser()        → Notification
   - processUserData() as orchestration layer calling the above functions
```

## 3. Separation of Concerns
1. **Layered architecture**: UI / business logic / data access must be clearly separated.
2. **No cross-layer coupling**: UI doesn't touch DB; data layer has no business rules.
3. **Config extraction**: No hard-coded configuration values in logic.
### Recommended Project Structure
```
src/
├── components/     # UI components (presentational)
├── containers/     # Container components (state connection)
├── services/       # Business logic
├── repositories/   # Data access
├── utils/          # Utility functions
├── types/          # Type definitions
├── constants/      # Constants and configuration
└── hooks/          # Custom Hooks (for React)
```

## 4. Design for Extensibility
1. **Program to interfaces**: Define contracts via interfaces/abstract types, not concrete implementations.
2. **Open-Closed**: Extend via new code, not modifying existing code.
3. **Dependency Injection**: Components receive dependencies, not create them internally.
4. **Strategy over conditionals**: >3 branches of if-else/switch → consider strategy/map pattern.
### Practice Guide
```
❌ Wrong:
if (paymentType === 'credit') { ... }
else if (paymentType === 'debit') { ... }
else if (paymentType === 'crypto') { ... }
✅ Right:
const paymentStrategies = {
  credit: new CreditPaymentStrategy(),
  debit: new DebitPaymentStrategy(),
  crypto: new CryptoPaymentStrategy(),
};
paymentStrategies[paymentType].process(payment);
```

## 5. Naming & Self-Documenting Code
1. **Meaningful names**: ✗ `d`, `temp`, `data` → ✓ `daysSinceLastLogin`, `userProfile`.
2. **Verb-first functions**: `calculate`, `validate`, `fetch`, `transform`.
3. **Boolean prefix**: `is/has/should` — e.g., `isActive`, `hasPermission`.
4. **No magic numbers**: Extract to named constants.
5. **No abbreviations**: Unless industry-standard (URL, API, ID).
### Magic Numbers
```
❌ Wrong: if (retryCount > 3) { ... }
✅ Right:
const MAX_RETRY_ATTEMPTS = 3;
if (retryCount > MAX_RETRY_ATTEMPTS) { ... }
```

## 6. Robust Error Handling
1. **Handle errors at the right boundary**: Key business flows must have an explicit error strategy, but do not wrap code in try-catch when an existing framework, caller, or typed result boundary already handles it clearly.
2. **Never swallow exceptions**: Catch blocks must log or re-throw.
3. **Specific error types**: Use custom error classes with context (operation, parameters, cause).
4. **Recoverable vs fatal**: Retry/degrade for the former; fail fast for the latter.
### Practice Guide
```
❌ Wrong:
try { ... } catch (e) { console.log(e); }
✅ Right:
try {
  await fetchUserProfile(userId);
} catch (error) {
  logger.error('Failed to fetch user profile', {
    userId,
    errorCode: error.code,
    errorMessage: error.message,
  });
  throw new UserProfileFetchError(userId, error);
}
```

## 7. Testability
1. **Pure functions first**: Same input → same output, no side effects.
2. **Dependencies as parameters**: External deps (API, DB, time) must be injectable/mockable.
3. **Avoid global state**: Global state is the enemy of testing.
### Testable Code Structure
```
// ✅ Testable: Dependencies passed as parameters
function calculateDiscount(price, discountRules, currentDate = new Date()) {
  // ...
}
// ❌ Hard to test: Internal dependencies hardcoded
function calculateDiscount(price) {
  const rules = GlobalConfig.discountRules;  // Global dependency
  const now = new Date();                     // Time dependency
  // ...
}
```

## 8. Documentation & Comments
1. **Respect project language boundaries**: Source-code comments follow the existing file/module language. Do not switch comment language merely because the current user speaks another language.
2. **User-facing documents follow the requester**: Handoff, progress notes, architecture notes, and explanations should use the master brain/user's requested language. If unspecified, follow the surrounding project documentation language.
3. **API docs (JSDoc/TSDoc/Rustdoc)**: Follow the project's public API documentation language; English is acceptable when there is no established convention.
4. **Explain WHY, not WHAT**: Comments justify decisions, not restate code.
5. **Keep docs current**: Update documentation when modifying related code.
### Comment Quality
```
❌ Useless comment:
// Increment counter
counter++;

✅ Valuable comment:
// Using incremental counter instead of UUID because we need to guarantee message ordering,
// and clock skew in distributed environments makes UUID sorting unreliable
counter++;
```

## 9. Dependency & File Management
1. **New dependency flow**:
   - Check if an existing dependency covers the need
   - If implementable in <50 lines → self-implement
   - Otherwise → propose to the master brain/user with rationale (name, purpose, size, maintenance status)
   - Introduce new runtime dependencies only after explicit approval
2. **File consistency**: Respect existing file structure. Don't create files arbitrarily.
3. **Context awareness**: Consider how changes affect the broader architecture.

## 10. Performance Awareness
1. **No N+1 queries**: No DB/API calls inside loops; use batch operations.
2. **Cache expensive computations**: But plan for cache invalidation.
3. **Async for I/O**: Never block on I/O in async contexts.
4. **Lazy loading**: Defer non-critical resources.

## 11. Logging & Observability
1. **Log levels**: `error` (needs attention) / `warn` (recoverable) / `info` (key milestones) / `debug` (dev only).
2. **Structured logging**: Use objects, not string concatenation.
3. **No sensitive data in logs**: Never log API keys, tokens, or passwords.

---

# Part II: AI Collaboration Rules

## 12. AgentVis Handoff Protocol
1. **Location**: Maintain one handoff file in the workdir root, named `xxx-hand-off.md` according to the current project/task naming convention. Create it if absent.
2. **Allowed section prefixes only**: `Development-Progress`, `Fix-History`, `Refactoring-History`.
3. **State over diary**: Write the current actionable state, not a long thought transcript.
4. **Required content when relevant**:
   - Stage objective and completion status
   - Files changed and why
   - Current behavior after the change
   - Tests/checks run and results
   - Open risks, assumptions, blockers, and suggested next action
5. **Consolidate aggressively**: Append for new facts, but compress stale or duplicate history so the next sub-agent can scan quickly.
6. **Failure/interruption rule**: If the stage is incomplete, record the last known good state, failed attempts, evidence gathered, and the safest next step.

## 13. Minimal Change Strategy
1. **Change only what's needed**: Don't "fix" or refactor unrelated code during feature work.
2. **Ask before refactoring**: If you spot improvement opportunities, mention them but don't act unless asked.
3. **Preserve function signatures**: Don't change params/return types unless the task requires it.
4. **Prefer addition over modification**: When possible, add new functions/files rather than rewriting existing ones.
5. **Report impact scope**: When changes span multiple files, state the full change chain upfront.

## 14. Regression Protection
1. **Trace the call chain**: Before modifying a function, check all its callers.
2. **Types as safety net**: Let the compiler catch regressions via the type system.
3. **Boundary awareness**: Pay special attention to null/undefined, empty arrays, empty strings, and zero values.
4. **Don't silently change behavior**: If a fix alters observable behavior, explicitly state it.

## 15. AI Anti-Patterns
### Patterns to Avoid
1. **Don't implement blindly**: Understand requirements → design → code.
2. **Don't just look at the current file**: Understand the code's role in the full project.
3. **Don't create OfflineIsolated code**: New code must integrate into existing architecture.
4. **Don't ignore existing patterns**: Follow established conventions and styles.
5. **Don't over-engineer**: Simple problems → simple solutions.
6. **Don't mix refactoring with features**: These are separate tasks.
7. **Don't assume the user wants optimization**: Report issues, but wait for instructions.
8. **Don't forget the happy path**: Normal flow first, then error handling.

### Context Management
1. **State your assumptions**: Before design decisions, declare what you're assuming.
2. **Ask when uncertain**: One clear question is better than a wrong guess.
3. **Report cascading changes**: Change in A requires B, C, D → report upfront.
4. **Respect naming conventions**: Match the casing, prefix, and suffix patterns in the project.

---

# Part III: Language-Specific Safety

## TypeScript / JavaScript
1. **Avoid unbounded `any`**: Use `unknown` + type guards or runtime validation (e.g., Zod) instead. If interacting with third-party untyped APIs, contain the `any` at the boundary and immediately narrow it.
2. **Contain 3rd-party `any`**: Narrow types immediately at the call site; don't let `any` spread.
3. **Strict interfaces**: Define explicit contracts for all data structures and API responses.
4. **Generics**: Use generics for type-safe reusable patterns.

## Rust
1. **Avoid `.unwrap()` in production paths**: Use `?` operator or explicit `match`. Tests and impossible invariant checks may use `.expect()` with a clear message.
2. **`Result<T, E>` over panic**: Functions return Result, not panic.
3. **Custom errors**: Use `thiserror` for domain-specific error types with context.
4. **Minimize `.clone()`**: Prefer references and borrowing.
5. **Pre-allocate**: Use `Vec::with_capacity()` when size is known.

## Python
1. **Mandatory type hints**: All function signatures must have complete type annotations.
2. **No bare `except`**: Catch specific exception types only.
3. **Pydantic for models**: Use `BaseModel` for data validation and serialization.
4. **Async for I/O**: Use `async/await` for file, network, and IPC operations.

## Go
1. **Handle every error**: No `_` for error returns unless explicitly justified.
2. **Return early**: Use guard clauses; avoid deep nesting.
3. **Interfaces for decoupling**: Accept interfaces, return structs.
4. **Context propagation**: Pass `context.Context` through call chains for cancellation and timeouts.

---

# Pre-Commit Checklist
### Functionality
- [ ] All required functionality implemented (no pseudo-code / TODOs)
- [ ] Edge cases handled (null, limits, invalid input)
- [ ] Error handling is explicit at the right boundary

### Code Quality
- [ ] No duplicate code
- [ ] Functions have single responsibility
- [ ] Names are clear and meaningful
- [ ] No magic numbers / hardcoded values
- [ ] Comments explain "why" and match project language conventions
- [ ] Language-specific safety rules followed (no `any` / no `.unwrap()` / type hints)

### Architecture
- [ ] Follows existing patterns
- [ ] No unapproved new dependencies
- [ ] New code in correct directory/module
- [ ] No circular dependencies
- [ ] Tauri types match between TS and Rust (if applicable)

### AI Change Safety
- [ ] Change scope minimized — no "drive-by refactoring"
- [ ] All callers of modified functions verified
- [ ] No behavioral changes without explicit statement
- [ ] No sensitive info in logs
- [ ] Handoff updated with current state, verification, and next-step context

---

# When to Refactor
### Trigger Signals
1. Adding features requires changes in many unrelated places
2. Code takes too long to understand
3. Same bugs keep appearing in multiple places
4. Code smells: overly long functions, deep nesting, too many parameters

### Refactoring Rules
1. **Small steps**: One change at a time, stay runnable after each
2. **Test first**: Ensure tests exist before refactoring
3. **Separate from features**: Refactoring is its own task, not a side-effect of feature work

---

Remember: Whether you're adding new features, fixing bugs, or refactoring code, always consider edge cases and regression risks. Every line of code you write may be read dozens of times and modified several times.
Making code clear, modular, and maintainable is always worth the extra effort.
