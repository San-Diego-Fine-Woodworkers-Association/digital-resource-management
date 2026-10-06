# ResourceSpace setup for Member Media Upload

ResourceSpace keeps its fields, user groups and users in the database, not in
this repo. `scripts/rs-setup.sh` recreates what the Member Media Upload flow
needs, on any host, so a fresh local install, a restored backup or a new server
ends up the same as production. Background and decisions: #24 (plan), #34
(provisioning and test results).

## What `provision` creates

Everything is looked up by shortname or name, never by ref, because refs differ
between hosts. Re-running is safe.

| Thing | Details |
|---|---|
| `rse_workflow` plugin | Enabled if it is off. It ships with ResourceSpace and provides the **Publish** button that reviewers use for Approval. |
| Base fields, **created only if missing** | Program / Event Name (`eventname`), Program / Event (`programevent`, required dropdown), Subject Type (`subjecttype`, required checkbox list), Location (`location`, dropdown), matching production: all resource types, the same option lists. An existing field is never modified. |
| Submitter fields | Submitter Name, Submitter Email, Submitter Member ID, Submission ID, Submitter Rights Confirmation (multi-line), Submitter Original Filename. Photo and Video only, not required, hidden on the upload form, external access off. Name, Email and Submission ID are indexed for search. |
| **Member Upload Service** group | `d,e-1` plus `f<ref>` for the 13 fields the upload proxy writes: Title, Program / Event, Subject Type, Date, Location, Program / Event Name, Caption and the six Submitter fields. |
| **upload-service** user | In that group, approved, no expiry, with a random password that is never shown. |
| **Media Reviewers** group | `s,g,f*,j*,v,t,e-1,e0` plus `F<ref>` on the six Submitter fields, so reviewers can read them but not edit them. |
| "Pending review" dash tile | Shown to Media Reviewers, Administrators and Super Admin; any of those groups missing on a host is skipped. It links to the Quarantine (Pending Review) list. Reviewers need it because Team Centre's link to that list needs `c`, which together with `e0` would let them upload straight to Active. |

The script owns the Submitter fields, both groups, the user and the tile. Each
run resets them to what `scripts/rs-setup/provision.php` declares, so make any
permission change there, not in the admin UI.

Re-running does not reindex existing Items, so turning search indexing on for a
Submitter field affects only values written afterwards.

Not covered: which people are Media Reviewers. Add them in Admin > Users; a
user's dash picks up the tile when their group changes.

## Running it

The wrapper finds the container of the compose service `resourcespace`, whatever
the compose project is called, and pipes the PHP script into it as `www-data`.

```sh
# Local docker compose stack
scripts/rs-setup.sh provision
scripts/rs-setup.sh verify

# A remote Docker host (e.g. the Dokploy server)
RS_SSH=root@<host> scripts/rs-setup.sh provision
RS_SSH=root@<host> scripts/rs-setup.sh verify
```

| Variable | Use |
|---|---|
| `RS_SSH=user@host` | Run against a remote Docker host over SSH. |
| `RS_CONTAINER=name` | Pick the container when more than one `resourcespace` is running. |
| `RS_PRINT_API_KEY=1` | `provision` also prints `RS_UPLOADER_API_KEY=...`. For local development only. |
| `RS_TEST_BASEURL=url` | `verify`: the URL the container uses to reach ResourceSpace. The default is `$baseurl`. Locally you may need `http://localhost/`. |
| `RS_TEST_PRUNE=1` | `verify`: also re-run with each permission removed, to show which are needed (takes 15–25 minutes). |

**After provisioning production or a new server,** copy upload-service's API key
(Admin > Users > upload-service) into the Dokploy secret `RS_UPLOADER_API_KEY`.
Keep it nowhere else. The key is derived from the user's ref and the
`API_SCRAMBLE_KEY`, so it changes if either changes, for example when the user
is recreated on a new host.

**Back up the database first** when running against a server that has data.

## What `verify` checks

It copies the two groups' live permission strings into throwaway groups with
throwaway users, and drives the real API and web UI the way the proxy and a
reviewer would. It never touches the real groups or users, deletes everything it
created, and exits non-zero on any FAIL.

- **Uploader:**
  - creates an Item in Quarantine (Pending Review) and uploads a file;
  - writes all 13 fields;
  - reads the option lists of Program / Event, Subject Type and Location;
  - reads every value back;
  - cannot create an Item as Active.
- **Reviewer:**
  - logs in and sees the dash tile and the Quarantine list (the tile is also checked for the two admin groups);
  - opens the Item, loads the preview and downloads the original;
  - edits Title;
  - cannot edit a Submitter field, through the API or on the edit page;
  - finds the Item by Submission ID, Submitter Name and Submitter Email;
  - Approval moves the Item to Active with the **Publish** button, and rejection moves it to Deleted with **Delete**.

Two checks are reported as **KNOWN**. These are ResourceSpace limits accepted in
#34, not failures:

- **The upload account can activate its own pending Item through one core API
  path.** That path checks only edit access, not `e0`. The upload proxy must
  never change an Item's status.
- **The upload account can write fields outside its 13.** `f<ref>` controls only
  viewing. The upload proxy must write only its 13 fields. Adding `F*` plus
  `F-<ref>` for the 13 fields closes this; it was tested but not adopted.
