---
type: code
project: PD
# allow_harness_changes: true   # only if this task must change test config / acceptance scripts / package.json scripts
---
# Goal
<one paragraph: the observable outcome that means "done">

# Scope
- src/<module>/**
- tests/<module>/**

# Acceptance
npm test -- <module>

# Forbidden
- do not change public API signatures
- do not touch CI config

# Context
<optional: links, decisions already made, gotchas>

