# Route to the public client release

The target is one client monorepo plus the existing private hosted-service
repository. CLI, MCP tools and Skills change together; separate packages can
still version independently. Separate public repositories become useful when
maintainers or release constraints diverge, not just because interfaces differ.

| Milestone | Delivery | Status in the foundation PR |
| --- | --- | --- |
| Client foundation | `packages/cli`, `skills/sharednet-room`, CI, export audit, installed-package checks | Implemented for review |
| Public contracts/core | Extract only shared wire shapes and transport needed by CLI/MCP | Not yet extracted; avoid empty package placeholders |
| Local server | Server core (HTTP handler, in-memory store, protocol) ported into `packages/cli/src`, run by `sharednet local` | Implemented in the local-server PR; the PostgreSQL store, web dashboard, hosted authentication and Cloud stay hosted |
| MCP implementation | `packages/mcp`: shared tool registration, narrow service gateway, HTTP adapter and stdio entry | Not implemented by this PR |
| Hosted integration | Private authentication/gateway wraps the same public tool definitions; real routes cover the tool matrix | Requires linked service PR |
| Canonical-source cutover | Service consumes pinned public artifacts; duplicate client source/publish path removed; catalog points here | Not yet performed |
| Release | CLI 0.2.0, first MCP package 0.1.0 and matching Skill | No package published or bumped by this PR |

MCP must contain working implementation, not only a protocol document. First
map each current tool to actual HTTP routes, credential semantics, errors and
cursor storage. Missing routes require server implementation and integration
tests. Keep OAuth, SQL and authority enforcement in the hosted service.
Confirm ownership of an MCP npm package name before choosing a publish target.

The export allowlist includes CLI implementation/tests, the published Room
Skill, and the server core behind `sharednet local`: the HTTP handler, the
in-memory store and the protocol, each recorded with its source commit and hash.
It excludes the PostgreSQL store and database package, the web dashboard,
hosted authentication, deployment configuration, internal documents,
credentials, local state and private git history. The service repository stays
the source of truth for the server core until a cutover like the CLI's. Public
DTOs can be extracted after symbol-level review; copying a whole internal
protocol module is not the acceptance criterion.

The existing MIT notice is preserved for this client distribution. The owner
chose MIT for the ported server core; the parts that stay hosted keep their own
licensing. Repository visibility, merges and npm releases are
separate deliberate steps after review.
