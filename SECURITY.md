# Security Policy

This is financial software. Source review and local tests do not certify a live
deployment, custody arrangement, solvency or safety for real funds.

## Reporting A Vulnerability

Do not put exploit details, credentials, customer information or private keys in
a public issue or pull request. When private vulnerability reporting is enabled
for this repository, use the Security tab's **Report a vulnerability** flow.
If that private channel is unavailable, open an issue asking the maintainer to
provide a private channel, without including vulnerability details.

Provide the affected revision, package and a synthetic local reproduction.
Never move funds, change production configuration or test against other users
to demonstrate a problem. There is no implied bug-bounty payment or response
time guarantee.

## Credentials And History

Use a fresh clone of the sanitized history. Do not merge or push from an older
backup clone: it can restore removed credentials and private data. Keep local
environment files ignored and access-restricted. Historical credentials must
not be reused, even if their wallets currently have no balance.

Public release requires a separate check that old sensitive Git objects and
cached views are no longer accessible on GitHub. A clean branch or a passing
secret scan alone is insufficient. Existing third-party clones cannot be
erased by changing this repository.

## Operational Boundaries

Network, signer, database and service credentials must be configured separately.
Mainnet deployment and transactions require separate bounded authorization.
Preserve the documented circuit breakers, finality checks, reconciliation and
recovery paths when proposing changes.
