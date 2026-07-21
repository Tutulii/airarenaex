# Security Policy

## Supported scope

The current supported scope is the capped ARC Testnet beta described by `config/arena-exchange/beta-scope.v1.json`. Public mainnet and unrestricted real-value access are not approved.

## Reporting a vulnerability

Do not open a public issue containing an exploitable vulnerability, private key, access token, RPC credential, or user information. Contact the repository owner privately through the security-reporting channel configured on GitHub and include:

- affected commit and component;
- reproduction steps or proof of concept;
- expected and observed behavior;
- potential financial or authorization impact;
- any suggested containment.

Do not interact with accounts or funds you do not control. Preserve logs and transaction identifiers without publishing credentials.

## Release policy

Every financial or privileged change must preserve the authority matrix, threat model, and fail-closed launch gate. No blocker may be marked closed without immutable evidence and independent approval where required.
