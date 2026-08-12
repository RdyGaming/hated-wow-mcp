# Security Policy

## Supported versions

This project is pre-1.0 and ships from `main`. Only the latest release gets
fixes; there are no maintained backport branches.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No — please update |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting:

**<https://github.com/RdyGaming/hated-wow-mcp/security/advisories/new>**

That opens a thread visible only to you and the maintainer. Include what you
found, the steps to reproduce it, and what an attacker gains. A proof of concept
helps but is not required.

You should get an initial response within a week. This is a hobby project
maintained by one person, so please allow reasonable time for a fix before
disclosing publicly. Credit is given in the advisory unless you would rather
stay anonymous.

## What is in scope

This server runs locally with the privileges of whoever started it, and it is
driven by an AI client rather than by a human typing commands. That shapes what
counts as a vulnerability here:

- **Escaping a confined path.** The addon tools are restricted to the resolved
  addon root, and UI source reads are restricted to the synced checkout. Any
  input that reads or writes outside those roots is a vulnerability — including
  via symlinks, `..` segments, or Windows path quirks such as `\\?\`, alternate
  data streams, or 8.3 short names.
- **Arbitrary file write.** The scaffolder creates files. Anything that lets a
  tool argument place a file outside the intended addon directory is in scope.
- **Command injection.** The UI source sync shells out to `git`. Any input that
  reaches a command line unescaped is in scope.
- **Malicious upstream data.** The syncs fetch from public mirrors. Crashes are
  a bug; anything that turns fetched data into code execution, a file write
  outside the data directory, or a path traversal during extraction is a
  vulnerability.
- **Tool output that hijacks the client.** Data flows from these tools into an
  AI client's context. If content from a synced file or a tool result can be
  crafted so that a client reliably treats it as instructions, that is worth
  reporting.

## What is not in scope

- **The data being wrong or out of date.** Missing functions, stale indexes and
  incorrect signatures are ordinary bugs — please use the issue templates.
- **Anything requiring an already-compromised machine.** This server trusts the
  local filesystem and the process that launched it, by design.
- **Reading files the user pointed it at.** Setting `WOW_ADDON_PATH` to a
  sensitive directory and then reading from it is the tool working as
  documented.
- **Denial of service through huge inputs.** A 149 MB listfile is a normal day
  here; slow is not a vulnerability.
- **Vulnerabilities in Blizzard's client, or in game data mirrors.** Report
  those upstream.

## What this server does not do

For clarity, since it narrows the surface considerably:

- No Battle.net or web API calls, no credentials, no API keys, no auth of any
  kind.
- No telemetry, no analytics, no outbound traffic at all during normal
  operation — only the sync scripts reach the network, and only to the public
  mirrors named in the README.
- Nothing is executed from synced data; Lua and XML are parsed, never run.
