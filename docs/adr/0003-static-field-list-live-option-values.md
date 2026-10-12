# The form's field list is static; the option values come live from ResourceSpace

The proxy's configuration lists which ResourceSpace fields the form asks for (by shortname), their plain-language labels, and which are required. The choices inside dropdown and checkbox fields (Program / Event, Subject Type, Location) are fetched live from ResourceSpace with `get_field_options`, which needs only view access to the field, not admin permission. We accept that there is **no drift check**: if an administrator later makes a different field required, the form will not know, and Items will arrive without it until a Reviewer fills it in at Approval. ResourceSpace's API does not enforce required fields at all, so the proxy validates the three required fields itself, and after creating each Item it reads the fields back to confirm they were saved.

## Considered options

- **A live schema, read through a narrow read-only database user:** rejected for v1, it couples the proxy to ResourceSpace's table layout.
- **An admin-level API key to list fields:** rejected, a leaked proxy would hold admin-level access.
- **A static list plus a scheduled drift check:** rejected as unnecessary for now.

## Consequences

An option that changes in ResourceSpace between form load and submit has to be caught by the proxy, not by ResourceSpace.

**Corrected 2026-10-12 (#56).** The original text said a removed option is "silently dropped by ResourceSpace". Tested on RS 11.0 r29660, that holds only for a name the field no longer has (deleted or renamed). A **deactivated** option is not dropped:
- plain `get_field_options` still lists it;
- `update_field` saves it;
- it reads back unchanged.

The proxy therefore:
- asks `get_field_options` with `nodeinfo` and offers only the choices whose `active` flag is set;
- refuses a choice that isn't currently active when the Submission starts, re-fetching the list before refusing one the cache doesn't know;
- in the read-back, checks the saved choices against a fresh active list as well as for presence, and rewrites what doesn't hold.

Decided in: [Decide: Metadata model for Batch metadata, overrides, and required fields](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/19).
