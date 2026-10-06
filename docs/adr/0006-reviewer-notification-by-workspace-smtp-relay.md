# Reviewers are told about new Submissions by one email sent through the Google Workspace SMTP relay

ResourceSpace 11.0 sends nothing when an Item enters Pending Review, and its daily email digest is opt-in per user, one row per Item, and probably misses Items created through the API. The proxy instead sends one readable email per Submission, from `no-reply@sdfwa.org` to `media-reviews@sdfwa.org`, through the Google Workspace SMTP relay. It is scheduled when a Submission starts, sent immediately when it completes, and sent as partial when progress stalls for 30 minutes (the deadline slides forward whenever an Item arrives, so a slow but healthy upload is not reported as partial). A small Submission record on the staging volume lets this survive a restart. Sending is best-effort: retried three times, logged, and never allowed to block the member. ResourceSpace's My Actions list remains the source of truth.

## Consequences

The relay trusts the server's public IP address rather than a password, so any container on that Dokploy host could also send as an `@sdfwa.org` address. No new vendor (the auth app's Resend is not used).

Decided in: [Decide: How Reviewers learn about new Submissions](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/32).
