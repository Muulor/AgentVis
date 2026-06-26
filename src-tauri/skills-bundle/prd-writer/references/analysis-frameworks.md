# Analysis Framework Reference Manual

When a PRD requires deep analysis, refer to the detailed usage methods for the following frameworks.

---

## 1. OST — Opportunity Solution Tree

**Purpose**: Trace feature requirements back to business goals and ensure every feature serves a clear business outcome.

**Structure**:

```
Business Outcome
├── Opportunity 1
│   ├── Solution A
│   │   └── Experiment/Validation A1
│   └── Solution B
│       └── Experiment/Validation B1
└── Opportunity 2
    └── Solution C
```

**Usage Steps**:
1. Start from the business outcome (not from features)
2. Identify opportunities to achieve the outcome (user needs/pain points)
3. Design multiple solutions for each opportunity
4. Design a minimum validation experiment for each solution
5. Reflect the mapping between features and business goals in the PRD

---

## 2. WSJF — Weighted Shortest Job First

**Purpose**: Objectively evaluate feature priority and avoid subjective preference and the HiPPO (highest-paid person's opinion) effect.

**Formula**:

```
WSJF = Cost of Delay (CoD) / Job Size (Size)
CoD = User-Business Value + Time Criticality + Risk Reduction / Opportunity Enablement
```

**Scoring Method**:

| Dimension | 1 point | 3 points | 5 points | 8 points | 13 points |
|------|------|------|------|------|-------|
| User-Business Value | Very little impact | Some value | Medium value | High value | Critical/necessary |
| Time Criticality | Can be delayed 1 year+ | Within six months | This quarter | This month | Needed immediately |
| Risk Reduction | No impact | Slight help | Helpful | Significantly reduces | Eliminates critical risk |
| Job Size | Very small (XS) | Small (S) | Medium (M) | Large (L) | Very large (XL) |

**Example**:

| Feature | Value (V) | Urgency (T) | Risk (R) | CoD | Size (S) | WSJF | Priority |
|------|---------|---------|---------|-----|---------|------|--------|
| User login | 13 | 13 | 8 | 34 | 3 | 11.3 | 1st |
| Personalized recommendations | 8 | 3 | 3 | 14 | 8 | 1.75 | 3rd |
| Points system | 5 | 5 | 5 | 15 | 5 | 3.0 | 2nd |

---

## 3. Jobs-to-be-done (JTBD)

**Purpose**: Dig deeply into users' true needs and go beyond surface feature requests.

**Core Formula**:

```
When I [situation], I want to [motivation], so I can [desired outcome].
```

**Analysis Dimensions**:

- **Functional Job**: What task does the user want to complete?
- **Emotional Job**: What feeling does the user want to obtain?
- **Social Job**: How does the user want to be seen by others?

**Deep Questioning Checklist**:

1. In what situation does the user "hire" this product?
2. What solution did the user previously use to "make do" with this Job?
3. What specific parts of the existing solution dissatisfy the user?
4. What cost is the user willing to pay to solve this Job (money/time/effort)?
5. What is the "good enough" standard for solving this Job?

---

## 4. Pre-mortem

**Purpose**: Identify potential failure causes before project kickoff and formulate mitigation strategies in advance.

**Execution Steps**:

1. **Assume the project has already failed**: Imagine the product has completely failed 6 months after launch
2. **List reasons independently**: List possible failure causes from the four dimensions of technology, product, market, and operations
3. **Rank by probability**: Evaluate the probability of each cause occurring
4. **Formulate mitigation strategies**: Create preventive measures for high-probability causes
5. **Write into the PRD**: Reflect mitigation strategies in the "Risks and Mitigations" section

**Common Failure Cause Checklist**:

| Dimension | Common Failure Causes |
|------|-------------|
| Technology | Performance fails to meet standards, technical solution is infeasible, third-party dependencies are unstable |
| Product | Requirement misunderstanding, poor user experience, uncontrolled feature scope |
| Market | Competitors move faster, market window closes, pricing strategy is wrong |
| Operations | Insufficient resources, cross-team collaboration blockers, post-launch operations cost too high |

---

## 5. Solution Evaluation Matrix

**Purpose**: Compare multiple solutions systematically and avoid gut-feel decisions.

**Template**:

| Dimension | Weight | Solution A | Solution B | Solution C |
|------|------|--------|--------|--------|
| User Value | 30% | ? / 5 | ? / 5 | ? / 5 |
| Implementation Complexity | 25% | ? / 5 | ? / 5 | ? / 5 |
| Time Cost | 20% | ? / 5 | ? / 5 | ? / 5 |
| Risk Level | 15% | ? / 5 | ? / 5 | ? / 5 |
| Cost of Delay | 10% | ? / 5 | ? / 5 | ? / 5 |
| **Weighted Total Score** | | | | |

**Usage Method**:
1. Adjust the weight of each dimension according to actual project conditions (sum to 100%)
2. Score each solution from 1-5 on each dimension
3. Calculate the weighted total score: each item = score × weight, then sum all items
4. Record the evaluation process and final selection rationale in the PRD

---

## Quick Reference

| Framework | Core Purpose | Where to Use in PRD |
|------|----------|-----------------|
| **OST** | Trace features back to business goals | §3 Background and Goals, §5 Functional Requirements |
| **WSJF** | Priority decisions | §8.3 Priority Matrix |
| **JTBD** | User need discovery | §3.2 User Pain Points, §4 Users and Scenarios |
| **Pre-mortem** | Risk identification | §9 Risks and Mitigations |
| **Solution Evaluation Matrix** | Multi-solution comparison | §5.2 Detailed Feature Description |
