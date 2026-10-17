# Runbook: the Reviewers' email did not arrive

The upload service sends one email per Submission to
`media-reviewers@sdfwa.org`. How and when:
[the Reviewers' email](../upload-service.md#the-reviewers-email).

**Nothing is lost when the email is missing.** Every Item is in Pending Review
whatever happens to the email. Tell the Reviewers to check Pending Review in
ResourceSpace while you look.

```sh
HOST=root@<server IP>   # the server's public IPv4 or IPv6: Hetzner Cloud console, under the project's server
```

## Symptoms

- A member says they sent photos, and the Reviewers got no email.
- Items are in Pending Review with no email about them.
- Some Reviewers get the email and others don't.

## Check

**1. Is it too early?** A Submission whose page closed partway sends its
partial email only after 30 minutes with nothing arriving
(`REVIEWER_EMAIL_STALL_MINUTES`).

**2. Is the kill switch on?** In Dokploy's Environment tab, check
`REVIEWER_EMAIL_PAUSED`. Anything but `false`, `0`, `no`, `off` or empty
pauses it, a typo included.

**3. What does the log say?** Find the Submission ID: it is the Submission ID
field on any of its Items in ResourceSpace.

```sh
ssh $HOST 'docker logs --since 48h $(docker ps -q --filter label=com.docker.compose.service=upload) 2>&1' \
  | grep -E 'reviewer_email|reviewer email' | grep '<submission id>'
```

Leave out the last `grep` to see every email. What you may find:

| In the log | Means | Go to |
|---|---|---|
| `"outcome":"sent_complete"`, `sent_partial` or `sent_unknown` | The relay accepted it. The problem is after the relay: the Group, or spam. | Fix A |
| `could not send the reviewer email` (several), then `"outcome":"failed"` | The relay refused it 4 times. The line carries the relay's error. | Fix B |
| `could not send the reviewer email` without a `failed` yet | Still retrying (after 30 s, 2 min and 10 min). | wait, then recheck |
| `no reviewer email: nothing in the Submission arrived` | Nothing reached ResourceSpace, so there was nothing to review. | the member's uploads: [ResourceSpace is down](resourcespace-down.md) |
| `could not schedule the reviewer email` or `could not save the reviewer email's state` | Something went wrong writing to staging. | [Staging is full](staging-full.md) |
| Nothing at all for that Submission | The kill switch was on when it started, or the container was recreated since (its log went with it). Or the kill switch was on for more than 7 days, so the email was given up (`held_too_long` in the audit log). | step 2; [Logs](../upload-service.md#logs-and-the-audit-trail) |

**4. Can the server reach the relay?**

```sh
HOST_SSH=$HOST scripts/host-setup.sh check
```

Check "Outbound SMTP" shows `smtp-relay.gmail.com:587 open`, and note the
public IPv4 and IPv6 it prints (the same as the Hetzner Cloud console shows for
the server). Both must be allowed on the relay, because the server connects
over IPv6. Compare them with the relay's allowed IPs in the Google Workspace
admin console.

**5. Does a test message get through?**

```sh
HOST_SSH=$HOST scripts/host-setup.sh mail-test media-reviewers@sdfwa.org
```

It prints the SMTP conversation. `250 2.0.0 OK` means the relay accepted it.

## Fix

**A. The relay accepted it, but it didn't reach a Reviewer.**

- Ask them to check spam, and to mark it "not spam".
- Check they are a member of `media-reviewers@sdfwa.org`, and their delivery
  setting in the Group is not "No email": [Adding a Reviewer](../upload-service.md#adding-or-removing-a-reviewer).
- Check the Group still lets `no-reply@sdfwa.org` post (Group settings > Who
  can post). If not, the Group rejects it, often with a bounce to
  `no-reply@sdfwa.org`, which is not a mailbox.

**B. The relay refused it.** Read the relay's error in
`could not send the reviewer email`.

- **`530 5.7.0 Authentication Required`:** the service is talking to Gmail's
  ordinary server, not the relay. Check `SMTP_HOST` in Dokploy's Environment
  tab: it must be `smtp-relay.gmail.com` (the default), never
  `smtp.gmail.com`, which needs a password the service doesn't have. Delete the
  line or correct it, then press Deploy. Seen on 2026-10-16. If you redeploy
  before the last try (about 13 minutes after the first), the restart reloads
  the pending email and sends it.
- **The relay does not recognise the server** (for example "Invalid
  credentials for relay"): the server's public IPv4 or IPv6 is not allowed.
  This happens after a server move or an IP change. In the Google Workspace
  admin console, Apps > Google Workspace > Gmail > Routing > SMTP relay service,
  add the addresses `check` printed. See
  [host-setup.md](../host-setup.md#reviewer-notification-mail).
- **Connection timed out or refused:** port 587 is blocked. Check the
  `check` output and Hetzner's firewall.
- **A TLS error:** the service requires STARTTLS on 587 with TLS 1.2 or later.
  Check `SMTP_HOST` and `SMTP_PORT` have not been changed from their defaults.
- **A sender refused:** `REVIEWER_EMAIL_FROM` must be an `@sdfwa.org` address,
  because the relay allows only addresses in our domains.

An email that was given up is **not sent again**. Once the fix is in, send the
Reviewers the Submission's Pending Review link by hand:

```
https://media.sdfwa.org/pages/search.php?search=submissionid%3A<submission id>&archive=-1
```

**Kill switch was on:** set `REVIEWER_EMAIL_PAUSED=false` and redeploy.
Submissions started while it was on never get an email; send their links by
hand as above.

## Verify

1. `HOST_SSH=$HOST scripts/host-setup.sh mail-test media-reviewers@sdfwa.org`
   reaches every Reviewer's inbox, not spam.
2. Send two photos through `https://media.sdfwa.org/upload`. Within a minute
   of the second being sent, every Reviewer gets "New photos from …", and
   **Open them in Pending Review** shows those two Items.
3. The log shows `"event":"reviewer_email","outcome":"sent_complete"`.
