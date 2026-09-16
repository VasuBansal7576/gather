# ADR-NNN: <one-line decision>

Status: proposed | paused | accepted | in-progress | shipped (<merge commit>)
Depends on: ADR-XXX
Authorization: <explicit owner instruction; a status alone is not permission to implement>
PRD: <section numbers this ADR implements, e.g. 4.3, 10 (gate name)>

## Decision
<What we are doing and the one or two sentences of why. A worker should be able to restate this without reading the PRD.>

## Owns
<Exact paths the worker may create or edit. Globs allowed.>

## Must not touch
<Paths that are off limits even if tempting. Always include the personal `~/.openclaw` and anything another in-flight ADR owns.>

## Do
- <Concrete, ordered instructions. File names. Function names where they matter. Test names.>

## Don't
- <The mistakes a capable model would otherwise make here. Be specific.>

## Out of scope
<Adjacent things that belong to another ADR, with its number.>

## Acceptance
<Each line is provable by one artifact. The PR evidence table mirrors this list exactly.>
- ...
- `npm test`, `npm run typecheck`, `npm run build` pass; report skips. Run the golden path if it exists; otherwise state it is absent.
