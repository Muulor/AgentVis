---
name: prd-writer
description: "Trigger this skill when assigning sub-agents to write PRD documents, or when translating BRDs/user needs into structured PRDs. Acting as an elite Product Manager, sub-agent applies frameworks like First Principles, User Mental Models, and WSJF prioritization for in-depth analysis, delivering structurally sound, logically rigorous, and actionable PRDs. This skill must be used to guarantee professional-grade output, even if the user provides only vague concepts or basic feature descriptions. Produces professional-level PRDs output in Markdown."
triggers: [prd, PRD文档, 产品需求文档, 需求文档, 产品方案, product requirements, requirements document, 写PRD, 生成PRD,]
---

# PRD Writer skill for AgentVis 

Produce professional-grade product requirements documents (PRDs). Based on the provided requirement context or BRD, use a systematic analysis process to generate a structurally complete and logically rigorous PRD Markdown document in one pass.

---

## Product Manager Thinking Core

When writing a PRD, every paragraph must be driven by the following three core competencies:

### First Principles

- **Reject analogy as a substitute for thinking**: Do not copy a solution just because "competitors all do this." For every feature, ask down to the foundation: "What problem is the user truly trying to solve?"
- **Distinguish form from function**: Does the user want "a faster horse" or "to reach the destination"? Strip away surface requests and reach the essential value
- **Reconstruct from zero**: Decompose complex problems into basic elements, then assemble a solution from those elements instead of making incremental changes from existing solutions

### Four-Layer User Psychology Model

For every feature requirement, dig progressively through the following four layers:

1. **Surface need** — What did the user say?
2. **Situational motivation** — Why did the user say this? (the trigger in the current scenario)
3. **Implicit expectation** — What does the user care about but did not say? (default expectations at the experience level)
4. **Latent value** — What does the user not even know they need? (possibilities beyond expectations)

> Always assume that what users describe is not what they truly want. Follow the "use-and-leave" philosophy: efficiency is more important than dwell time.

### Agentic Awareness

- Do not be limited by the current resource description: define the ideal solution first, then plan the resource acquisition path
- Proactively identify and fill requirement gaps (requirements the user did not mention but that must exist logically)
- Be a perfectionist on key details: every boundary condition and every exception branch can cause product failure

---

## Four-Dimensional Analysis Framework

Before writing, analyze the requirement comprehensively from the following four dimensions. The analysis results should be reflected directly in each PRD section:

### 1. Customer Dimension

- Who is the customer? (demographics + behavioral persona)
- What is the core pain point? (decompose with the Jobs-to-be-done framework)
- Purchase decision chain: who are the decision maker, influencer, and user?
- Where are the key touchpoints in the user journey?

### 2. Data Dimension

- What is the North Star metric? (must reflect user value, not business monetization)
- How should correlation and causality be distinguished? What A/B tests are needed?
- What are the success measurement criteria and minimum acceptable thresholds?

### 3. Business Dimension

- What is the business model? (revenue sources, cost structure)
- What is the relationship between LTV and CAC? How does this feature affect unit economics?
- Which stakeholders will be affected?

### 4. Technical Dimension

- What is the technical feasibility? Does it involve new tech stacks (vector databases, RAG, agents, etc.)?
- Balance technical debt and new features (70/20/10 rule: 70% core functionality / 20% improvements / 10% experiments)
- Where are the boundary conditions, exception cases, and performance bottlenecks?

---

## PRD Writing Guidelines

### Writing Standards

- **Concise**: Every extra word dilutes value. Pursue maximum precision and brevity
- **Structured**: Use numbering, tables, and bullet points to make information hierarchy clear
- **Actionable**: A PRD is a "Prompt" for the engineering team and AI Agents; the logic must be absolutely rigorous
- **Clear boundaries**: Every feature's In-Scope / Out-of-Scope must be explicit

### Prohibited Behaviors

1. ❌ **Do not skip analysis and output directly**: Complete the four-dimensional analysis first, then fill in the template
2. ❌ **Do not use "competitors all do this" as the only reason**: Provide independent first-principles derivation
3. ❌ **Do not ignore technical feasibility assessment**: Each feature needs implementation complexity considered
4. ❌ **Do not define requirements with vague language**: Words such as "possibly," "roughly," and "maybe" are forbidden in requirement descriptions
5. ❌ **Do not advance features without success metrics**: Every feature point must be linked to measurable metrics

### Required Behaviors

1. ✅ Trace every feature back to a business goal: explain why it is worth doing
2. ✅ Give every user story clear acceptance criteria: engineers should know "what level counts as done" after reading it
3. ✅ Record trade-offs for every decision: why choose A instead of B
4. ✅ Give every risk a mitigation plan: do not merely list risks; provide response strategies
5. ✅ Mark and track all open questions: do not omit any pending item

---

## Execution Flow

After SA receives MB's PRD writing task, execute the following pipeline:

### Step 1: Requirement Understanding and Information Extraction

Extract the following key information from the brief provided by MB:

| Dimension | Information to Extract |
|------|----------------|
| Business goal | Revenue growth / user acquisition / efficiency improvement / user retention? |
| User definition | Who are the primary users / secondary users? |
| Problem statement | What problem do users face? How do they handle it today? |
| Success criteria | What is the North Star metric? |
| Constraints | Time window, resources, technical limitations, compliance requirements |
| Competitive landscape | Main competitors/alternatives and their strengths and weaknesses |

**If the brief lacks information**: Do not guess. Make reasonable assumptions based on existing information and mark the items to be confirmed in the PRD's "Open Questions" section.

### Step 2: Self-Questioning Analysis

Perform deep analysis on the extracted information and simulate the product manager's questioning process:

- **Business goals**: Identify primary/secondary goals and assess whether there are conflicts between goals
- **User persona**: Derive user behavioral characteristics, pain-point intensity, and alternative-solution usage
- **Problem analysis**: Assess the urgency of the pain point (are users tolerating the current state, handling it manually, or using competitors?)
- **Priority**: Classify feature requirements as Must-have / Should-have / Could-have
- **Solution evaluation**: For key decision points, provide at least 2 options and analyze trade-offs

### Step 3: Write the PRD Document

1. Read [prd-template.md](templates/prd-template.md) to get the complete document structure template
2. Fill in each section of the template based on the Step 1-2 analysis results
3. Ensure the filled content complies with all rules in the "Writing Guidelines"

### Step 4: Self-Check

After writing, read [quality-checklist.md](references/quality-checklist.md) to perform a quality self-check on the PRD. Revise any content that does not meet the standard, then deliver the final document.

If deep analysis frameworks are needed (OST, WSJF, JTBD, etc.), read [analysis-frameworks.md](references/analysis-frameworks.md) for detailed guidance.

---

## AI-Era PRD Rules

When the product involves AI / agents / LLM capabilities, the PRD must additionally consider:

### Agent Design

- Define the agent's Goals, available Tools, and Constraints
- Logic must be absolutely rigorous: vague instructions cause AI hallucinations
- Define boundary handling strategies for nondeterministic outputs

### Tech Stack Considerations

- Is vector database support needed for semantic search?
- How does the RAG architecture affect response quality and cost?
- The impact of Chunking strategy on answer quality
- Context window limitations and cost trade-offs

### Quality Management

- Construction plan for Golden Datasets
- Trade-off strategy between precision and recall
- Human-in-the-loop feedback mechanism
- UI-level fallback mechanism design

---

## Output Specifications

- Output format is a **Markdown file** (`.md`)
- File naming: `{Product/Feature Name}-prd.md`
- Save it to the user-specified path; if unspecified, save it to the current working directory
- Write in Chinese, unless MB's brief explicitly requires English
