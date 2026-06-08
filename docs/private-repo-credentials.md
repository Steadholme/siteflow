# Private Repository Credentials

SiteFlow supports private Git repositories through an operator-mounted SSH deploy key. Do not put tokens, passwords, or deploy keys in repository URLs.

## Worker environment

Set the worker environment only to filesystem paths:

- `SITEFLOW_GIT_SSH_KEY_PATH`: absolute path to a read-only SSH private deploy key mounted into the worker.
- `SITEFLOW_GIT_KNOWN_HOSTS_PATH`: optional absolute path to a mounted `known_hosts` file for the Git provider.

Example:

```text
SITEFLOW_GIT_SSH_KEY_PATH=/etc/siteflow/secrets/git-deploy-key
SITEFLOW_GIT_KNOWN_HOSTS_PATH=/etc/siteflow/ssh/known_hosts
```

When `SITEFLOW_GIT_SSH_KEY_PATH` is configured, the worker sets a controlled `GIT_SSH_COMMAND` for Git subprocesses. The command uses the mounted key with `IdentitiesOnly=yes`, `BatchMode=yes`, and `StrictHostKeyChecking=yes`. If `SITEFLOW_GIT_KNOWN_HOSTS_PATH` is set, it is passed as `UserKnownHostsFile`.

## Operational rules

- Use SSH repository URLs such as `git@github.com:acme/site.git` or `ssh://git@github.com/acme/site.git`.
- Do not use URL-embedded credentials such as `https://token@github.com/acme/site.git`.
- Mount the private key read-only and restrict host permissions to the SiteFlow operator account.
- Prefer a repository-scoped deploy key with read-only access.
- Keep `known_hosts` pinned to the expected provider host keys. If the file is missing or stale, checkout should fail rather than prompting.

## Residual risk

This flow provides an explicit private repository credential path, but it is not the whole source-provider trust boundary. Production promotion still needs passed `source-provider:evidence` for the exact release commit and target environment, including exact checkout proof, signed provider webhook validation for the enabled GitHub/GitLab/Gitea/generic endpoint, deploy-key/host-key policy evidence, release provenance, no raw credential archival, and the worker build isolation controls documented in the production readiness materials. Deploy-key and webhook-secret rotation remain operator-managed.
