# Deployment boundaries

The public application repository contains source, offline tests, configuration
examples, and container build checks. Actual Azure resource identifiers,
deployment workflows, manifests, monitoring configuration, execution records,
and production logs belong in a separate private deployment repository.

The private workflow selects an immutable commit from the application's main
branch, runs its checks, builds both containers, and deploys the corresponding
image revision. Production credentials are available only to the protected
deployment job. Azure access uses GitHub OIDC; runtime secrets stay in Key Vault.

Do not put deployment secrets, Azure identifiers, private workflow calls, or
deployment dispatch tokens in this public repository. Masked GitHub Secrets do
not hide workflow source, job structure, transformed values, logs, artifacts,
or deployment metadata. Running a private reusable workflow from a public
workflow is not the same isolation as running the entire deployment privately.

Operators can deploy manually from the private repository. Keep the Azure
federated credential bound to that repository and its protected environment.
Changing repository ownership or names requires checking the OIDC subject,
package access, environment protections, and organization policies before use.

Configuration examples describe required settings; they are not deployable
inventories. Populate them privately for your own infrastructure. The service
interfaces and internal role names remain part of the application architecture.
