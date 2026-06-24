# Security Policy

gozzle is a safety tool, so safety bugs matter most. Its core guarantee is that
it is **read-only by construction** and **keeps your data local** — every query
runs with `readonly=2`, and data only leaves your cluster when you explicitly
create a local slice. A vulnerability here means anything that could:

- cause a write, DDL, or mutation against a connected ClickHouse cluster;
- bypass or weaken the read-only / cost guardrails;
- exfiltrate data or credentials off the machine gozzle runs on;
- inject SQL through a table name, query, or migration argument;
- leak secrets into logs, audit entries, or generated config.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's
[**Security Advisories**](https://github.com/lureilly1/gozzle/security/advisories/new)
("Report a vulnerability"). This keeps the report confidential until a fix is
available.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal SQL statement / table definition is ideal),
- the gozzle version (`gozzle version`) and ClickHouse version/deployment.

We aim to acknowledge reports within a few business days and will keep you
updated as we work on a fix. Coordinated disclosure is appreciated; we're happy
to credit you once a fix ships.

## Supported versions

gozzle is pre-1.0 and ships from `main`. Security fixes target the latest
published `@gozzle/cli` release on npm.
