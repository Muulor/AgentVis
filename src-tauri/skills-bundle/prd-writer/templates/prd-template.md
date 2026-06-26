# PRD Document Template

> **Usage Notes**: Fill in each section based on this template. Each section's `<!-- Guidance -->` comment explains what to include; delete the comments after filling them in.

---

# [Product/Feature Name] PRD

## 1. Document Information

| Field | Content |
|------|------|
| Version | v1.0 |
| Author | [Author] |
| Date | [YYYY-MM-DD] |
| Status | Draft |

---

## 2. Executive Summary

<!-- Guidance: Summarize the product goal, core user value, and expected outcome in one paragraph. Senior decision-makers should understand "what this product is, why it is being built, and what will happen after completion" after reading this paragraph. Keep it under 150 Chinese characters. -->

---

## 3. Background and Goals

### 3.1 Business Background

<!-- Guidance: Explain the market environment, current business state, and why this product/feature should be built now. Include data support such as market size, growth rate, and user scale. -->

### 3.2 User Pain Points

<!-- Guidance: Analyze with the "Four-Layer User Psychology Model":
- Surface need: the problem users describe themselves
- Situational motivation: the specific scenario that triggers the need
- Implicit expectation: the experience users do not state but expect by default
- Latent value: possibilities users do not know they need
-->

### 3.3 Product Goals

<!-- Guidance: Define 1 primary goal + 1-2 secondary goals. Each goal must satisfy the SMART principles (specific, measurable, achievable, relevant, time-bound). Explain priority relationships between goals. -->

### 3.4 North Star Metric

<!-- Guidance: Choose one core metric that best reflects users obtaining value. Explain why this metric is chosen and how it relates to business goals. Also list 2-3 supporting metrics. -->

| Metric Type | Metric Name | Target Value | Measurement Cycle |
|----------|----------|--------|----------|
| North Star metric | | | |
| Supporting metric | | | |
| Supporting metric | | | |

---

## 4. Users and Scenarios

### 4.1 Target User Persona

<!-- Guidance: Define primary users and secondary users. Each user type includes demographic characteristics, behavioral characteristics, technical proficiency, and core needs. If information is insufficient to determine a precise persona, give reasonable assumptions and mark them as assumptions. -->

**Primary Users**:

| Characteristic Dimension | Description |
|----------|------|
| Demographics | |
| Behavioral characteristics | |
| Technical proficiency | |
| Core needs | |

**Secondary Users**:

| Characteristic Dimension | Description |
|----------|------|
| Demographics | |
| Behavioral characteristics | |
| Core needs | |

### 4.2 Core Use Scenarios

<!-- Guidance: Describe 3-5 core scenarios in the format "scenario → behavior → expectation." For each scenario, explain trigger conditions, user operation flow, and expected result. -->

**Scenario 1**: [Scenario Name]

- **Trigger Conditions**:
- **User Behavior**:
- **Expected Result**:

### 4.3 User Journey Map

<!-- Guidance: Describe the complete journey from first contact to continuous use. Mark key touchpoints, user emotions, and potential churn points at each stage. -->

| Stage | Touchpoint | User Behavior | User Emotion | Opportunity/Risk |
|------|------|----------|----------|-----------|
| Awareness | | | | |
| Acquisition | | | | |
| Activation | | | | |
| Retention | | | | |
| Referral | | | | |

---

## 5. Functional Requirements

### 5.1 Feature Overview

<!-- Guidance: List all feature modules and their priorities in one table. Use the MoSCoW classification method for priority. -->

| Feature Module | Priority | Description |
|----------|--------|------|
| | Must-have | |
| | Should-have | |
| | Could-have | |

### 5.2 Detailed Feature Description

<!-- Guidance: Each Must-have and Should-have feature module needs an independent detailed description. Each module includes: description, user story, acceptance criteria, boundary conditions, and exception handling. -->

#### 5.2.1 [Feature Module Name]

**Description**:

**User Story**:
> As a [role], I want [feature], so that [value].

**Acceptance Criteria**:

- [ ] [Specific and verifiable condition 1]
- [ ] [Specific and verifiable condition 2]
- [ ] [Specific and verifiable condition 3]

**Boundary Conditions and Exception Handling**:

| Scenario | Handling Method |
|------|----------|
| [Boundary case 1] | |
| [Exception case 1] | |
| [Extreme input] | |

---

## 6. Non-Functional Requirements

### 6.1 Performance Requirements

<!-- Guidance: Define quantifiable performance metrics such as response time, throughput, and concurrent users. -->

| Metric | Requirement | Description |
|------|------|------|
| Response time | | |
| Concurrent users | | |
| Availability | | |

### 6.2 Security Requirements

<!-- Guidance: Data encryption, authentication and authorization, privacy compliance (GDPR/PIPL, etc.). -->

### 6.3 Usability Requirements

<!-- Guidance: Accessibility, multilingual support, device adaptation, etc. -->

### 6.4 Compatibility Requirements

<!-- Guidance: Supported browser/system versions and third-party integration requirements. -->

---

## 7. Technical Constraints and Dependencies

### 7.1 Technical Limitations

<!-- Guidance: Existing tech stack constraints and team technical capability boundaries. -->

### 7.2 Third-Party Dependencies

<!-- Guidance: External services/APIs/SDKs to be integrated and their stability assessment. -->

### 7.3 Technical Debt Considerations

<!-- Guidance: Technical debt introduced by the new feature and its impact on existing debt. Follow the 70/20/10 rule: 70% core functionality / 20% improvements / 10% experiments. -->

---

## 8. Scope and Priority

### 8.1 Current Scope (In-Scope)

<!-- Guidance: Explicitly list all features and non-functional requirements to be delivered in this phase. -->

### 8.2 Deferred Considerations (Out-of-Scope)

<!-- Guidance: Explicitly list items not being built in this phase but that may be built in the future, and the reasons for not doing them temporarily. -->

### 8.3 Priority Matrix (WSJF)

<!-- Guidance: Evaluate using the WSJF (Weighted Shortest Job First) formula. To learn the WSJF calculation method in detail, see analysis-frameworks.md. -->

| Feature | User-Business Value | Time Criticality | Risk Reduction | CoD Total | Job Size | WSJF |
|------|-------------|-----------|---------|---------|---------|------|
| | | | | | | |

---

## 9. Risks and Mitigations

<!-- Guidance: Every risk must have a corresponding mitigation plan. Do not only list risks; also provide "how to respond." -->

| Risk | Probability | Impact | Mitigation | Owner |
|------|------|------|----------|--------|
| | High/Medium/Low | High/Medium/Low | | |

---

## 10. Open Questions

<!-- Guidance: All pending items must be recorded here. Include assumptions requiring user/stakeholder confirmation, items awaiting technical research conclusions, and blockers dependent on external team feedback. Mark the expected closure date for each question. -->

| # | Question | Status | Owner | Expected Closure Date |
|---|------|------|--------|-------------|
| 1 | | Pending confirmation | | |

---

## 11. Appendix

<!-- Guidance: Include the following content as needed. Optional; add selectively based on project complexity. -->

- Competitive analysis
- User research summary
- Prototype/wireframe links
- Technical architecture diagrams
- Glossary
