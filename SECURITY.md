# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/eRom/erom-IDNMA/security/advisories/new). Do not open a public issue.

You can expect a first answer within a week. IdnmA is maintained by a single developer: fixes ship as fast as that allows.

## Scope

IdnmA is local and single-user by design. Its sockets, keys and registry entries are restricted to the current macOS user, and nothing goes through a remote relay. Reports that matter most:

- another local user, or a process outside the agent's tree, being admitted to a peer socket;
- a peer message changing an agent's configuration or permissions;
- a secret from the environment ending up in a log, a message or a file.
