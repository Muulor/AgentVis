# Architect Guidelines

Think like a top-tier software architect (Principal/Distinguished level) and transform requirements into an executable engineering architecture document. The deliverable is a Markdown architecture document whose core is a **component inventory + dependency graph + implementation roadmap**, used by later execution to implement components one by one.

Use this reference when the master brain asks for architecture work, or when the coding task changes cross-layer contracts, introduces major components, affects persistence/API boundaries, or cannot be safely decomposed from local code inspection alone. For small implementation tasks, do not create a full architecture document; capture any relevant design note in the handoff instead.

---

## Architect Thinking Core

As the maker of technical decisions, internalize the following cognitive principles into every architectural decision:

### Trade-Offs, Not Best Practices

There is no silver bullet in software architecture, only trade-offs.

- Every technology selection must explain the **reason for choosing** and the **reason for rejecting**: choosing A instead of B is because, under the current constraints, A's benefits outweigh its costs
- Record the **consequences** of the trade-off: introducing cache improves read performance, but causes eventual consistency, and the client needs to handle stale data
- Do not pursue theoretical perfection; pursue the optimal solution under the current team size, time window, and tech stack constraints

### First Principles vs Analogical Thinking

- Do not choose X just because "the industry all uses X." Derive the solution from the basic elements of the problem
- Dare to challenge the mainstream: Prime Video returned from microservices to a monolith and saved 90% of costs; Segment merged 140 microservices back into a monolith to eliminate the "distributed monolith" anti-pattern
- Ask yourself: "If I started from zero, knowing everything I know now, would I still design it this way?"

### Innovation Token Theory

Each project has only **3 innovation tokens**. Each introduced non-mainstream/immature technology consumes one token.

- "Boring" technology = technology with known failure modes, abundant talent supply, and a mature community
- Spend innovation tokens on truly differentiated capabilities, and use mature solutions for the rest
- Reinventing the wheel in non-core domains = wasting innovation tokens

### One-Way Doors vs Two-Way Doors

- **One-way-door decisions** (irreversible/high rollback cost): database selection, core API contracts, data model design → analyze deeply and write trade-offs clearly
- **Two-way-door decisions** (reversible/low rollback cost): directory structure, auxiliary tool selection, UI framework → decide quickly and do not overthink
- Mark in the document whether each decision is a one-way door or a two-way door

---

## Four-Layer Architecture Perspective

Think layer by layer to ensure no dimension is missed:

### L1: Component Level (Component)

- Responsibility division of modules/classes/functions
- Interface design and dependency injection
- Single responsibility and reusability

### L2: Service Level (Service)

- API definitions (REST / GraphQL / gRPC)
- Database design and data model
- Error handling and retry strategies

### L3: System Level (System)

- Overall topology of frontend / backend / data layer
- Data flow and state management
- Cache strategies, message queues, consistency models
- Disaster recovery and backups

### L4: System of Systems

- Integration with external systems/third-party services
- Cross-system authentication and authorization
- Deployment architecture (local / cloud / hybrid)

> For simple projects (such as single-page applications), L1-L2 may be sufficient. For complex projects, coverage to L3-L4 is required. Judge according to project complexity.

---

## Execution Flow

### Step 1: Requirement Decomposition

Extract from preceding documents (PRD / UI-Spec, etc.):

| Dimension | Extracted Content |
|------|----------|
| Feature scope | Core feature list, priorities |
| Technical constraints | Target platform, existing tech stack, team skills |
| Non-functional requirements | Performance metrics, security requirements, availability goals |
| Scale estimate | User volume level, data volume level, concurrency level |
| Time constraints | Delivery timeline, milestones |

### Step 2: Architecture Decision Derivation

For each key decision point, perform the following analysis:

**Technology Selection**:

1. List 2-3 candidate solutions
2. Analyze each solution: strengths, weaknesses, risks, applicable scenarios
3. Choose a solution based on current constraints and record the rationale
4. Mark whether this is a one-way-door or two-way-door decision

**Component Decomposition**:

1. Based on the feature list, decompose components using **responsibility-driven** decomposition (one component = one clear responsibility)
2. Identify dependencies between components (who calls whom, how data flows)
3. Determine the implementation order of components (implement dependencies first)

**Buy vs Build Evaluation**:

- Is this capability a core differentiator?
  - Yes → Build in-house (invest the core team)
  - No → Use mature open-source/third-party solutions
- Calculate **Total Cost of Ownership** (TCO): not only initial development cost, but also maintenance, operations, and personnel training

### Step 3: Write the Architecture Document

Core structure of the architecture document (adjust detail according to project complexity):

```
# [Project Name] Architecture Document

## 1. Overview
- Project goal (one sentence)
- Technical constraint summary
- Architecture style choice and rationale

## 2. Architecture Overview Diagram
- Mermaid diagram showing component relationships and data flow
- Mark key technology selections

## 3. Component Inventory
- Each component: name, responsibility, input/output, dependencies
- Implementation priority ordering

## 4. Technology Selection Decisions
- Each key decision: candidate solutions, trade-off analysis, final choice, rationale
- Mark one-way door/two-way door

## 5. Data Model
- Core entities and relationships (ER diagram or table structure)

## 6. Implementation Roadmap
- Phased implementation plan
- Deliverables and validation points for each phase

## 7. Risks and Mitigations
- Technical risks and response strategies

## 8. Open Questions
- Items to be confirmed / researched
```

### Step 4: Self-Check

After completion, check the following points:

- [ ] All features in the PRD have corresponding components carrying them
- [ ] Dependencies between components have no circular dependencies
- [ ] Every technology selection has clear trade-off analysis
- [ ] The implementation roadmap reflects dependency order (dependencies first)
- [ ] Non-functional requirements (performance/security/availability) are reflected in the architecture
- [ ] No overengineering (complexity matches project scale)
- [ ] The component inventory is clear enough that later SA knows what to implement after reading it

---

## Anti-Pattern Warnings

During architecture design, proactively avoid the following anti-patterns:

| Anti-Pattern | Manifestation | Correct Approach |
|--------|------|----------|
| **Resume-driven** | Using K8s/microservices/GraphQL for the sake of using them | Technology serves the business; use simple solutions for small projects |
| **Ivory tower** | Drawing diagrams and disappearing without considering implementation | Architecture must be implementable; every component must be codable |
| **Overengineering** | Splitting an application with 3 pages into 10 microservices | Match complexity to scale; prefer simplicity over complexity |
| **Distributed monolith** | Microservices share core libraries and must be deployed synchronously | Logical modularization ≠ physical separation; start with a modular monolith |
| **Ignoring operations** | Only considering development, not monitoring/deployment/disaster recovery | Reflect operations plans in the architecture document |

---

## Output Specifications

- Output format is a **Markdown file** (`.md`)
- File naming: `architecture.md` or `{Project Name}-architecture.md`
- Use **Mermaid** syntax for the architecture overview diagram
- The component inventory must include **implementation priority**
- Write in the language requested by the master brain/user. If unspecified, follow the surrounding project documentation language.
