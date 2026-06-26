# UI-Spec Quality Self-Check Checklist

After the UI-Spec is complete, check each item one by one. All Must items must pass.

---

## Design Tokens Completeness [Must]

- [ ] Color system covers five categories: background/text/action/feedback/border
- [ ] Both Light and Dark Token sets are defined
- [ ] Typography system defines display/heading/body/caption/mono
- [ ] Spacing system has at least 6 levels of scale (xs ~ 2xl)
- [ ] Radius/shadow/animation Tokens are defined
- [ ] No hardcoded color values appear in the document (all colors are referenced through Tokens)

## Component Definitions [Must]

- [ ] All interactive components define the complete state chain (Default/Hover/Active/Focus/Disabled/Loading/Error)
- [ ] Buttons have Primary/Secondary/Ghost variants
- [ ] Inputs have Default/Focus/Error/Disabled states
- [ ] The component inventory covers all reusable UI elements on the pages

## Page Specifications [Must]

- [ ] Each core page has a clear page goal
- [ ] Each page has a layout specification (ASCII sketch or text description)
- [ ] Each page has a component usage inventory
- [ ] Each page has an interaction specification (trigger → behavior → feedback)
- [ ] Each page has responsive adaptation plans (desktop/tablet/mobile)
- [ ] Accessibility requirements are listed

## Information Architecture [Must]

- [ ] Site map is defined
- [ ] Navigation structure is clear
- [ ] At least 1 core user flow has a flowchart

## Motion Specifications [Should]

- [ ] Overall motion strategy is defined (tone + rationale)
- [ ] Key transitions such as page transitions/modal pop-ups are defined
- [ ] Tokens used by microinteractions are marked

## Feasibility [Must]

- [ ] All components can be implemented with HTML/CSS/JS (no infeasible design)
- [ ] Motion specifications can be implemented with CSS transition/animation or a lightweight JS library
- [ ] No commercial fonts are required (only Google Fonts or system fonts are used)

## Consistency [Should]

- [ ] The same concept uses consistent terminology throughout the document
- [ ] Token naming follows consistent hierarchy rules (category.variant.state)
- [ ] Table formatting is neat and aligned
- [ ] The document can be read independently without relying on external context

## Visual Tone [Should]

- [ ] Visual direction is explicitly named (referencing design-directions.md or custom)
- [ ] Rationale for the choice is explained
- [ ] Reference brands/websites are listed
