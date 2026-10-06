# The form's field list is static; the option values come live from ResourceSpace

The proxy's configuration lists which ResourceSpace fields the form asks for (by shortname), their plain-language labels, and which are required. The choices inside dropdown and checkbox fields (Program / Event, Subject Type, Location) are fetched live from ResourceSpace with `get_field_options`, which needs only view access to the field, not admin permission. We accept that there is **no drift check**: if an administrator later makes a different field required, the form will not know, and Items will arrive without it until a Reviewer fills it in at Approval. ResourceSpace's API does not enforce required fields at all, so the proxy validates the three required fields itself, and after creating each Item it reads the fields back to confirm they were saved.

## Considered options

- **A live schema, read through a narrow read-only database user:** rejected for v1, it couples the proxy to ResourceSpace's table layout.
- **An admin-level API key to list fields:** rejected, a leaked proxy would hold admin-level access.
- **A static list plus a scheduled drift check:** rejected as unnecessary for now.

## Consequences

An option removed in ResourceSpace between form load and submit is silently dropped by ResourceSpace; the read-back check is what catches it.

Decided in: [Decide: Metadata model for Batch metadata, overrides, and required fields](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/19).
