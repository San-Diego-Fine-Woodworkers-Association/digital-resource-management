# Member Media Upload

Domain vocabulary for the member-facing upload form that feeds SDFWA's
ResourceSpace instance (media.sdfwa.org).

## Language

**Submission**:
One sitting's batch of Items from one person, uploaded together and described
together. The unit a person thinks of as "my upload".
_Avoid_: "batch" (reserved for describing how metadata is applied across a Submission), "upload" as a noun for the whole group

**Item**:
A single photo or video within a Submission.
_Avoid_: "file", "asset", "resource" (ResourceSpace's word for a stored Item once it exists there)

**Submitter**:
The signed-in member or volunteer who makes a Submission. Identified by their
SDFWA login, not by a ResourceSpace account (members have none).
_Avoid_: "contributor" — ResourceSpace uses that word for the account that owns a resource, which here is a shared uploader user, not the person

**Reviewer**:
A volunteer with a ResourceSpace account who approves Items out of Quarantine.
Reviews happen in ResourceSpace's own UI.
_Avoid_: "moderator", "admin"

**Quarantine**:
The state where an Item exists in ResourceSpace but is not yet part of the
media collection. This is ResourceSpace's native Pending Review archive state,
not a separate concept or system.
_Avoid_: "staging", "inbox"

**Approval**:
A Reviewer moving an Item out of Quarantine into the media collection.
_Avoid_: "publish"

**Batch metadata**:
Metadata a Submitter sets once and that applies to every Item in the Submission.
An Item may **override** it individually.

**Title**:
The human-written label for an Item, exactly as the Submitter typed it. May repeat
across Items and contains ordinary spaces and punctuation.
_Avoid_: using "name" for both Title and File name

**File name**:
The system-synthesized, unique, portable name an Item is stored and downloaded under
(date, slugged Title, Submission code, Item number). Distinct from the Title and from
the **Original filename** the Submitter's device gave it.
_Avoid_: "title" for this

**Submission ID**:
The identifier shared by every Item in one Submission, so a Reviewer can find and
Approve them together.

**Member-facing vocabulary**:
In the form, members see "photos and videos", "send", and "a volunteer". They never see
Submission, Item, Quarantine, Reviewer, or Batch metadata; those are internal terms.
_Avoid_: "upload" as the verb shown to members
