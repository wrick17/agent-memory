# Phase 1 DNS lookup

Observed 2026-10-28. This lookup made no Cloudflare changes.

Helium was listening on `127.0.0.1:9222`. A fresh Browser MCP health check succeeded. A new background Cloudflare tab redirected to `https://dash.cloudflare.com/login`, where the dashboard displayed its sign-in form. The Cloudflare account and DNS dashboard were not accessible. The owner must sign in to Cloudflare in the existing Helium browser, then the lookup can be repeated.

The authoritative record state, conflicts, TTLs, proxy status and edit permissions are **unknown** for every record type at these full names:

- `memory.wrick17.com`
- `clerk.memory.wrick17.com`
- `accounts.memory.wrick17.com`
- `clkmail.memory.wrick17.com`
- `clk._domainkey.memory.wrick17.com`
- `clk2._domainkey.memory.wrick17.com`

The first Clerk proposal, pending authoritative conflict inspection and separate owner approval, is a CNAME for `clerk.memory.wrick17.com` to `frontend-api.clerk.services`, DNS only, TTL Auto. The other Clerk proposals recorded in [phase 1 setup](phase-1-setup.md#clerk-setup-fresh-session) also require individual approval. Do not infer absence from this failed lookup. Workers Paid remains unverified.

Browser MCP reported `Transport closed` during the owned tab's close. DevTools reported the selected page closed and showed the same 11 pages as the baseline. This confirms bounded page cleanup, not task group removal; earlier cleanup remains unconfirmed.

## Signed-in dashboard lookup

On 2026-10-28, the signed-in Cloudflare dashboard showed `wrick17.com` active with Full DNS setup and 44 records. With no record-type filter, searching `memory` returned no DNS records. The search was checked against `botter`, which returned seven records including names containing that substring. Thus the dashboard showed no records of any type at any of these six names:

- `memory.wrick17.com`
- `clerk.memory.wrick17.com`
- `accounts.memory.wrick17.com`
- `clkmail.memory.wrick17.com`
- `clk._domainkey.memory.wrick17.com`
- `clk2._domainkey.memory.wrick17.com`

There are no existing targets, TTLs, proxy settings or same-name record conflicts at those names in the dashboard. The Add record control and Edit controls on ordinary records were enabled. This is visible UI permission, not a tested write. No DNS changes were made.

The first proposal for individual owner approval is `CNAME clerk.memory.wrick17.com` to `frontend-api.clerk.services`, DNS only, TTL Auto. Clerk requires it for the production Frontend API. Each other record still requires its own approval. Workers Paid remains unverified.

The owned task tab closed according to DevTools after Browser MCP's close returned `Transport closed`. Two pages from the initial baseline disappeared independently during this session; group removal and prior cleanup remain unconfirmed.

## Approved Clerk Frontend API record

On 2026-10-28, the owner individually approved the `clerk.memory.wrick17.com` record. Before the write, the Cloudflare DNS dashboard's exact-name search with no type filter showed no records. The reviewed form specified CNAME `clerk.memory.wrick17.com` to `frontend-api.clerk.services`, DNS only, TTL Auto. The record was saved at approximately 15:16:05 UTC.

At 15:16:17 UTC, the Cloudflare dashboard showed the same single CNAME, target, DNS-only status and Auto TTL after a reload. A public DNS query at 15:16:11 UTC through resolver `183.82.243.66` returned that CNAME with a 300-second TTL. This is one resolver's observation, not proof of universal propagation or Clerk login. G1, refresh tokens and cross-machine checks remain pending.

Browser MCP returned `Transport closed` when closing the owned tab. DevTools confirmed the page closed and the same nine pages remained as at the baseline. Task-group removal remains unconfirmed.

The next proposal for separate owner approval is CNAME `accounts.memory.wrick17.com` to `accounts.clerk.services`, DNS only, TTL Auto. It has not been applied.

## Approved Clerk accounts record

On 2026-10-28, the owner individually approved CNAME `accounts.memory.wrick17.com` to `accounts.clerk.services`, DNS only, TTL Auto. Before the write, the Cloudflare dashboard's exact-name search with no type filter returned no records. The reviewed form showed those exact fields. The record was saved at approximately 15:19:32 UTC.

At 15:19:43 UTC, the dashboard showed one matching CNAME with the approved target, DNS-only status and Auto TTL after a reload. One public DNS query returned the same CNAME with a 300-second TTL. This resolver's answer does not prove universal propagation or Clerk login. G1, live login, refresh and cross-machine checks remain pending.

Browser MCP returned `Transport closed` while closing the owned tab. DevTools confirmed the page closed and the same nine pages remained as at the baseline. Task-group removal remains unconfirmed.

The next proposal for the parent to seek separate owner approval is CNAME `clkmail.memory.wrick17.com` to `mail.y1pdlga1re5i.clerk.services`, DNS only, TTL Auto. It was not applied in this session.

## Completed Clerk records, 2026-10-28

The owner authorized all necessary non-deleting setup, superseding the earlier per-record approval gates in this document. In Helium on CDP 9222, the Cloudflare dashboard search for `memory`, with no type filter, showed only the existing `clerk.memory` and `accounts.memory` CNAMEs. The three remaining names were absent. The search also showed no record at `memory.wrick17.com` at that time.

| Name under `wrick17.com` | CNAME target |
|---|---|
| `clkmail.memory` | `mail.y1pdlga1re5i.clerk.services` |
| `clk._domainkey.memory` | `dkim1.y1pdlga1re5i.clerk.services` |
| `clk2._domainkey.memory` | `dkim2.y1pdlga1re5i.clerk.services` |

Each was added as DNS only, TTL Auto. After reload the dashboard showed exactly these three plus the existing two Clerk records, all with their expected targets, DNS-only status and Auto TTL. One public DNS lookup per new record returned its expected CNAME with TTL 300. This does not establish universal propagation. Clerk’s Verify Records action subsequently reported the primary domain, Frontend API, account portal and all three email records verified, with both SSL certificates issued.

Browser MCP closed its owned tab but returned `Transport closed`. DevTools reported the selected page closed and the original nine-page baseline remained. Group removal is unconfirmed.
