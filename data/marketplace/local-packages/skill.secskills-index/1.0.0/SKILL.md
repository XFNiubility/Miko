---
name: secskills-index
description: Use this skill to summarize and triage security Skill/MCP resources from curated indexes such as DaoYiSec/SecSkills without executing tools.
version: 1.0.0
---

# SecSkills Index

Use this skill when the task is to review, classify, or compare security-related Skills, MCP servers, or tool packages for marketplace curation.

Source reference:

- https://github.com/DaoYiSec/SecSkills
- Observed commit during packaging: `9cec50a`
- Upstream license: Apache-2.0

Operating rules:

- Treat the index as discovery metadata, not as executable trust.
- Do not install, execute, or recommend offensive tooling without explicit authorization and review.
- Prefer defensive categories: code audit, dependency review, configuration review, threat modeling, vulnerability management, and authorized assessment support.
- When preparing a marketplace entry, record source URL, license, required runtime, external commands, network needs, and whether the package mutates user config.

Output format:

```text
Resource:
Type:
Source:
License:
Runtime requirements:
Security notes:
Marketplace readiness:
```
