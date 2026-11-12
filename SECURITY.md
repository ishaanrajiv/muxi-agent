# Security policy

Muxi Agent runs coding agents on a user's machine, with that user's own Claude
and Codex logins. It enforces boundaries a host relies on: the workspace
sandbox (where a thread may read and write, and whether it reaches the
network), tool approvals and the guard, and isolation from the user's own agent
configuration. A way around any of those is a security bug.

## Reporting a vulnerability

Please report it privately, not in a public issue, pull request or discussion.
Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**.

Include what you can of:

- the version or commit, the backend (Claude or Codex) and its CLI version, and the OS;
- what a host configured (thread options, `WorkspaceSettings`, the guard);
- the steps or a minimal script that reproduces it, and what happened against what should have.

Use synthetic data in a report. Don't include real credentials, account data or
transcripts from a real account.

I aim to acknowledge a report within a week. Once a fix is out, the advisory is published
with credit to you, unless you'd rather not be named.

## Supported versions

Muxi Agent is pre-1.0 and is installed from a git commit. Fixes land on `main`
and in the latest 0.x release; older versions and commits are not patched.

| Version | Supported |
| --- | --- |
| latest 0.x and `main` | yes |
| anything older | no |

## Scope

In scope, in this repository's code:

- a thread reading, writing or running anything outside what its workspace
  settings allow: writes outside `root` and `cacheDir`, writes to `root/.git`,
  reads of the denied paths (home-folder credentials, the agents' own homes,
  `.env*` files, `protectedPaths`), or network access with `network` off;
- a tool call running without the approval or guard decision the README
  describes, or a declined call that still runs;
- a thread seeing MCP servers, settings, memory, skills or plugins it wasn't given;
- the host's secrets reaching the agent's shell environment;
- MCP credentials appearing unmasked where the README says they are masked;
- recorded fixtures or other files in this repository that expose real account data.

Out of scope:

- vulnerabilities in the Claude Agent SDK, the `claude` or `codex` CLIs, or the
  operating system's sandbox itself: report those to their maintainers (a
  report here is still welcome if this library uses them unsafely);
- what a model chooses to do with the access a host granted it, including
  calls auto mode's classifier allows, which the README documents as not
  reaching the host;
- the known gaps the README lists (for example, Codex running in-sandbox
  commands in a workspace without asking);
- issues that need an already compromised machine or user account.
