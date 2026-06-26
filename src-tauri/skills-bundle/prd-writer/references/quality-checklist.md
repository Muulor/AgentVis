# PRD Quality Self-Check Checklist

After the PRD is complete, check each item in the checklist below. All Must items must pass, and Should items should be satisfied as much as possible.

---

## Structural Completeness [Must]

- [ ] Executive summary is no more than 150 Chinese characters and covers goals, user value, and expected outcomes
- [ ] All Must-have feature modules have independent detailed descriptions
- [ ] Each feature module includes: description, user story, acceptance criteria, boundary conditions
- [ ] Non-functional requirements (performance/security/availability/compatibility) are covered
- [ ] In-Scope and Out-of-Scope boundaries are clear

## Goals and Metrics [Must]

- [ ] North Star metric is defined and reflects user value (not a pure business metric)
- [ ] North Star metric has a clear target value and measurement cycle
- [ ] Each major feature can be traced back to at least one business goal
- [ ] Success criteria are quantifiable and contain no vague descriptions

## User Analysis [Must]

- [ ] Target user persona includes demographic characteristics, behavioral characteristics, and core needs
- [ ] At least 3 core use scenarios are defined
- [ ] Each scenario has clear trigger conditions and expected results
- [ ] Users' current alternatives have been analyzed (current workarounds)

## Feature Definitions [Must]

- [ ] Each user story follows the format: As a [role], I want [feature], so that [value]
- [ ] Each feature's acceptance criteria are specific and verifiable conditions
- [ ] Boundary conditions are listed (empty values, extreme inputs, concurrent scenarios, etc.)
- [ ] Exception handling methods are defined (error messages, degradation strategies, etc.)
- [ ] No vague language ("possibly," "roughly," "maybe") appears in requirement descriptions

## Priority and Trade-Offs [Should]

- [ ] Features are classified by MoSCoW (Must/Should/Could/Won't)
- [ ] Key decisions record the trade-off process (why choose A instead of B)
- [ ] If WSJF evaluation is included, the scoring rationale is reasonable

## Risk Management [Must]

- [ ] At least 3 major risks are identified
- [ ] Each risk has probability and impact assessment
- [ ] Each risk has a corresponding mitigation measure (not empty)

## Open Questions [Must]

- [ ] All assumption-based content is marked and listed in open questions
- [ ] Open questions have owners and expected closure dates

## Language and Standards [Should]

- [ ] No typos or grammar errors
- [ ] Terminology is consistent (the same concept does not use multiple names)
- [ ] Table formatting is neat and data is aligned
- [ ] The document can be read independently without relying on external context
