# ResourceSpace metadata fields and required-field enforcement

Research for issue #14 (part of map #12, Member Media Upload). Facts and open risks only; nothing here is built.

## Sources

- **RS source**: `https://svn.resourcespace.com/svn/rs/releases/11.0/` at revision **r29660** (fetched via `!svn/bc/29660/`; `include/api_bindings.php`, `include/resource_functions.php` and `include/metadata_functions.php` are byte-identical to the branch head at time of research, r29833). Cited below as `file::function`.
- **RS 11.0 docs** (resourcespace.com knowledge base): [API overview](https://www.resourcespace.com/knowledge-base/api/), [create_resource](https://www.resourcespace.com/knowledge-base/api/create_resource), [update_field](https://www.resourcespace.com/knowledge-base/api/update_field), [get_resource_field_data](https://www.resourcespace.com/knowledge-base/api/get_resource_field_data), [get_resource_type_fields](https://www.resourcespace.com/knowledge-base/api/get_resource_type_fields), [Configure a metadata field](https://www.resourcespace.com/knowledge-base/resourceadmin/basic-configure-metadata-field), [Display conditions](https://www.resourcespace.com/knowledge-base/resourceadmin/advanced-configure-metadata-field), [User contributions](https://www.resourcespace.com/knowledge-base/resourceadmin/user-contributions).

## Version mismatch to resolve first

The map says "RS 11.0", but `Dockerfile` line 52 checks out `releases/10.7` (`svn co ... releases/10.7`). Everything below was read from 11.0 r29660. I also diffed 10.7 for the behaviors that matter here: `api_create_resource` is identical, and `update_field`'s required check, `update_archive_required_fields_check` and `api_get_resource_type_fields` all exist in 10.7. The conclusions hold on either version, but 10.7 lacks a few newer API functions (e.g. `api_get_resource_comments`, `api_do_report`). Decide whether the Dockerfile is meant to be bumped to 11.0.

## Short answers

1. **Listing fields.**
   - `get_resource_type_fields(by_resource_types, find, by_types)` lists every field with its properties, including `required`, `type`, `name` (shortname), `title`, `global`, `resource_types`, `display_condition`. It **requires permission `a` (admin)**: `api_bindings.php::api_get_resource_type_fields` returns HTTP 403 otherwise, and the docs say "Requires permission a", available from 10.3.
   - A non-admin API user can instead call `get_resource_field_data(resource)` on an existing resource (or the user's template). It returns the fields applicable to that resource's type with their field properties (`required`, `frequired`, `type`, `name`, `title`, current `value`): `resource_functions.php::get_resource_field_data` selects `f.required AS frequired` plus all `resource_type_field` columns, and `api_get_resource_field_data` only strips `nodes_values`. Practical pattern: create the resource first, then read its field list.
   - `get_resource_types` lists resource types (no field detail).
   - `get_field_options(field, nodeinfo)` lists the options (nodes) of a fixed-list field, by field id or shortname; it only needs view access to the field (`api_get_field_options`). `get_nodes` is similar.
2. **How "required" is marked.** A per-field boolean `resource_type_field.required`, set by an administrator in the field configuration. Docs: "Administrators can specify that a metadata field is mandatory during the upload process." A field with a display condition is exempt when the condition is not met (display-conditions doc; `metadata_functions.php::missing_fields_check`).
3. **Does the API enforce required fields?** **No, not on create.**
   - `api_create_resource` calls `create_resource`, which inserts the row with no required-field check. The optional `metadata` JSON is applied with `update_field` per field and the return values are ignored (`api_bindings.php::api_create_resource`). So a resource can be created, and left in Pending Review (-1) if the API user has permission `e-1`, with zero required fields filled.
   - `update_field` only rejects an *empty* value on a required field (`if ($value === '' && $fieldinfo['required'])` returns false with a "required" error, in `resource_functions.php::update_field`). It cannot tell you that you forgot to set field X.
   - The web edit form (`save_resource_data`) does enforce required fields, but only for fields actually displayed, and not for metadata templates.
   - The one server-side gate is on state changes: moving a resource into any state other than -2 (Pending Submission) or the deletion state through the web UI calls `update_archive_required_fields_check`, which calls `missing_fields_check`, blocks the move and lists the missing required fields (`metadata_functions.php`; `resource_functions.php::save_resource_data` and the multi-edit path). The API has no state-change binding in 11.0, and `put_resource_data` can set `archive` but does not call the check. `api_create_resource($archive=-1)` bypasses it as noted above.
   - **Consequence**: the proxy must enforce required fields itself, because RS will not. A Reviewer approving an Item (Pending Review to Active) in the RS UI *will* be blocked if required fields are empty, so missing values surface late, at review time, and for the Reviewer rather than the Submitter.
4. **Field types and how each is written** (constants in `include/definitions.php`; writes via `update_field`, `resource_functions.php`):

   | Type (id) | Write value |
   |---|---|
   | Text single (0), multi (1), large multi (5), formatted/TinyMCE (8) | Plain string. |
   | Check box list (2) | Comma-separated option names (CSV rules: double quotes enclose strings, backslash escapes), or comma-separated node IDs with `nodevalues=true`. |
   | Drop down (3), Radio (12) | One option name, or one node ID with `nodevalues=true`. More than one value returns false. |
   | Category tree (7) | Node names or full paths (`A/B`), comma separated; an unmatched value returns false. |
   | Dynamic keywords (9) | Comma-separated values; unmatched values are **created as new nodes** unless the user has `bdk<field>`. |
   | Date (10) | With `$use_native_input_for_date_field = true` (set in our `config.php`) the value must be `Y-m-d` or `Y-m-d H:i:s`; the time part is dropped; otherwise returns false with an "invalid date" error. Types 4 (date and optional time) and 6 (expiry date) are stored as given, unvalidated. |
   | Date range (14) | `YYYY[-MM[-DD]]/YYYY[-MM[-DD]]`, otherwise false. |
   | Warning message (13) | Display only; no value. |

   Docs for `update_field`: "To unset a field submit a blank value without quotes."
5. **Setting many fields in one call.** Only `create_resource`'s `metadata` parameter: a JSON object `{"<field id or shortname>": "<string value>", ...}`. Values must be strings; an array value makes the whole call return false, after the resource has already been created. Failures of individual fields are silent. Otherwise it is one `update_field` call per field. `add_resource_nodes` and `add_resource_nodes_multi` accept node-ID lists but are **admin-only** (`checkperm('a')`). `put_resource_data` writes only resource columns (`resource_type`, `archive`, `access`, geo, etc.), not metadata fields.
6. **Storing Submitter name / member ID for Reviewers.**
   - A dedicated metadata field (for example single-line text with a shortname like `submitter`), written with `update_field` or the `metadata` parameter. Visible and searchable by Reviewers and works with a shared uploader account. Field permissions (`F` / `F*`, see `metadata_field_edit_access`) must let the uploader user edit it.
   - The built-in `created_by` ("Contributed by") column can be set via `put_resource_data` only if `$edit_contributed_by` is on and the user has permission `v` (`acl_can_edit_contributed_by`). It must reference an RS user id, which members do not have, so it is unsuitable for member names.
   - The resource log records the API user, not the person, so it does not identify the Submitter.

## What makes required fields hard for a non-RS user

- Required fields are whatever an RS admin configured, per resource type, changeable at any time. The proxy cannot assume a fixed list; it must read them (via an admin-scoped key, or per resource via `get_resource_field_data` after creation) and render them dynamically or cache them.
- Fields can be required but conditional (`display_condition`, shortname-based), so "required" is not a static flag; `missing_fields_check` evaluates the condition against saved values.
- Required fixed-list fields (dropdown, checkbox, category tree) force a Submitter to pick from admin-defined vocabularies they may not understand. Unknown values for non-dynamic fixed lists are silently dropped by `update_field` (it returns true with no node added, and in the same pass removes nodes not in the new set), so a typo yields an empty "required" field with no error.
- Fields may be required that make no sense for a member upload (rights, location, internal codes); provisioning must decide which fields are required for the uploader's resource type(s) (map item "RS provisioning ... required-field setup").
- API errors are mostly a bare `false`, or HTTP 403 for permission failures; there is no structured per-field validation response, so the proxy must do its own validation to give a usable message.
- `config.php` sets `$upload_then_edit = true` (web UI: upload first, then edit metadata). This does not affect the API path but is relevant if Reviewers expect the stock flow.

## Open risks

- Dockerfile pins 10.7, not 11.0 (see above).
- No server-side required-field enforcement on API writes: a proxy bug can create Items that Reviewers cannot approve.
- Reviewer approval of an incomplete Item fails in the RS UI; need a plan for who fixes the values.
- The required-field set can change under the form without notice.
- The API user needs `c` or `d` and `e-1` to create directly in Pending Review (`api_create_resource` checks `get_default_archive_state`); the default without `e-1` is -2 (Pending Submission), and the API offers no way to move out of it. Needs confirming on the provisioned uploader group.
- Not verified at runtime: this is a source and docs reading only. Behavior should be confirmed on the live instance before slicing build tickets.
