# ADR-003: Progressive qualification and deterministic authority

Status: reconciled design contract — feature implementation remains paused. Existing defect repairs are authorized.

PRD: 3.1, 4–4.3, 5, 10. Related: ADR-002, ADR-005.

## Reconciled decision

Do not reject a legitimate booking inquiry merely because it lacks a date, guest count or event type. Those are qualification gaps, not evidence that a message is unrelated. Distinguish eligible/needs-information, clearly unrelated and uncertain/requires-review. Preserve reasons and source evidence; do not invent a universal keyword/date threshold.

## Authority boundaries

- Model extraction/classification can propose candidate fields; it never grants authority. Existing deterministic checks continue to own prices, exact approved actions, recipients and scope.
- Embedded malicious instructions are untrusted content. Ignore/reject the unauthorized instruction while processing legitimate booking content under normal permissions. “Zero tools for any message containing injection” is not a valid universal acceptance condition.
- Customer claims of owner-approved discounts are not owner policies. Concessions default off unless explicit scoped authority exists; cumulative concessions must remain within that authority.
- Recipients and content come from the exact approved booking action, never free model parameters. Test allowlists restrict rather than expand production authority.
- Classifier output cannot widen business/account scope. An incomplete inquiry may enter qualification but cannot cause an unsupported price, send or hold.
- Controlled tools must be reviewed by capability and authority, not replaced with an invented seven-name list that contradicts the registered interfaces. No general inbox/file/shell tool is permitted merely because its prompt says to stay scoped.

## Existing interfaces / future scope

Intake and source identity exist in `operator-runtime/intake.ts` and `identity/`; offer preparation in `business-operator/` and `offers/`; exact approval/execution in `booking-service.ts`; controlled tools in `live-model/` and `operator-runtime/mcp-tools.ts`. Event classification, composer UI and complete concession policy UX remain feature work. Repair existing boundary violations without implementing that backlog.

## Required future evidence

A packages-only inquiry stays eligible and asks for missing details; an invoice/newsletter is separated; uncertain classification is visible. Mixed legitimate inquiry plus injected discount preserves legitimate work but cannot change authority, price, scope or recipient. Floor/cumulative-policy violations fail before effects. Every surfaced claim cites actual records, not model prose.
