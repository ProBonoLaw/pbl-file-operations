# Publication checks

Publishing a cleaned tree does not clean its existing Git history. Use a new
repository initialized from the reviewed source snapshot, with one signed
initial commit, when historical deployment data must remain private. Do not
transfer the existing repository and make it public, or mirror its branches,
tags, pull request refs, issues, releases, artifacts, or Git LFS objects.

The private repository retains the historical source and deployment records.
Do not merge its historical branches into the public repository. Apply future
changes as reviewed patches and rescan them before publication.

Run these checks in the candidate public repository:

```sh
node --test .github/scripts/check-public-repository.test.mjs
node .github/scripts/check-public-repository.mjs
node .github/scripts/check-public-repository.mjs --history
gitleaks git --redact=100 --no-banner --log-opts='--all' .
```

The identifier check reports locations without printing values. It detects
non-example GUIDs, Azure resource hosts, organization resource names, private
configuration files, and deployment directories. Synthetic endpoints and the
nil account-partition sentinel are allowed. Gitleaks checks credential patterns.
These checks reduce exposure; passing them is not proof that every possible
secret or identifier has been recognized. Review fixtures and other document
content for public release separately.

The repository hygiene workflow runs identifier and credential checks as
independent jobs so one failure cannot prevent the other scan. Public repositories
always scan all fetched history for both identifiers and credentials. Make both
jobs required on the public main branch, alongside the application checks. Enable
GitHub secret scanning and push protection. Keep production secrets and Azure
variables exclusively in the private repository.

During preparation in the existing internal repository, an administrator may set
the repository variable `PUBLIC_HISTORY_BASELINE` to the full SHA of the reviewed
cleanup commit. The CI identifier scan includes that commit and every reachable
descendant's file tree, including temporary reintroductions, renamed files, and
reused historical blobs. Older archived branches remain outside that bounded scan.
The boundary must be an ancestor of the checkout; invalid boundaries fail the job.
Current files and credential history are always checked without this exception.

Public repositories ignore the boundary variable, even if it is copied during
migration. Unknown visibility and a missing boundary also require a full history
scan. The manual `--history` command above always audits all history. A passing
internal PR therefore validates cleanup and subsequent changes; it does not make
the original history suitable for public release. Publish the clean import only.

Before publication, also review the license, signed commit author information,
submodules, LFS storage, releases, wiki, issue/PR content, Actions logs and
artifacts, GitHub Pages, and repository/environment settings. A new import
does not bring over those surfaces, which is why it is preferred here.
