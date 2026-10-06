# Quarantine is ResourceSpace's native Pending Review state, fed by one shared uploader user

Uploads from members are held in ResourceSpace's own Pending Review state (archive state -1) until a volunteer Reviewer approves them to Active in ResourceSpace's normal interface. There is no custom review tool. Members have no ResourceSpace accounts, so every Item is created by a single least-privilege `upload-service` user, and who actually sent it is recorded in six dedicated fields (Submitter Name, Email, Member ID, Submission ID, Rights Confirmation and Original Filename) that the proxy stamps from the verified SDFWA session, never from the browser. Volunteers review in a dedicated Media Reviewers group; rejecting means moving an Item to Deleted.

## Considered options

- **A custom review interface:** rejected, ResourceSpace already supports reviewing and approving from Pending Review.
- **A ResourceSpace account per member:** rejected, members sign in through the SDFWA SSO, not ResourceSpace.
- **The built-in "contributed by" field:** rejected, it must hold a ResourceSpace user ID, which members do not have.

## Consequences

The ResourceSpace "contributor" of every member Item is the shared service user, so the Submitter fields are the only record of who sent it. The six fields do not exist yet and must be created before the build can be tested.

Decided in: [Decide: Metadata model for Batch metadata, overrides, and required fields](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/19), [Decide: ResourceSpace provisioning plan (uploader user, Reviewer group, Submitter fields)](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/24).
