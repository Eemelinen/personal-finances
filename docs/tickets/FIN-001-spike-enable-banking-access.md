# FIN-001: Spike: confirm Enable Banking access

**Milestone:** M0 Foundation · **Status:** Todo · **Depends on:** none

## Description

Before building the integration, confirm that Enable Banking can be used for personal access to my own Nordea and S-Pankki accounts, and record the facts the implementation depends on.

## Acceptance criteria

- [ ] Enable Banking account created and an application registered in the **sandbox**, with an RSA key pair generated and the private key stored in `secrets/` (never committed)
- [ ] The sandbox flow works end to end for Nordea FI and S-Pankki mock banks: authorize, list accounts, fetch balances and transactions (curl or a small script is fine)
- [ ] Production terms confirmed: is linking **my own accounts** free in restricted/personal mode? What are the limits (number of accounts, request rate)?
- [ ] Documented for both banks: consent validity (days), how much transaction history is available, how often balances and transactions can be fetched per day, pending transaction support
- [ ] Findings written into the **Findings** section below, and [plan.md](../plan.md) updated if anything changes the approach
- [ ] If Enable Banking is not viable: an alternative recorded (another aggregator, or CSV-only with FIN-012 pulled forward)

## Notes

- Docs: <https://enablebanking.com/docs/> and the Finland market page <https://enablebanking.com/docs/markets/fi/>
- Enable Banking authenticates applications with a JWT signed with RS256 using the application's private key. The application ID is the `kid`.
- Research so far ([API access research](../api-access-research.md#1-banks-nordea-and-s-pankki)): **restricted production** mode is free for your own accounts with no contract. You link the accounts in the control panel and the API only returns those. Consent lasts about 180 days, and unattended fetches are reportedly limited to about 4 per day per bank. Verify all of this here.
- GoCardless Bank Account Data stopped accepting new signups in July 2025, so it is not an alternative.

## Findings

_To be filled in._
