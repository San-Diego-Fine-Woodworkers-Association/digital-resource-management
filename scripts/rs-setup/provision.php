<?php
// Provision what the Member Media Upload flow needs in ResourceSpace (#34):
// the Submitter fields, the Member Upload Service group + upload-service user,
// the Media Reviewers group, and the reviewers' "Pending review" dash tile.
//
// Host-independent: everything is looked up by shortname / name, never by ref,
// so it replays on production, a fresh local install, or a new host. Idempotent:
// safe to re-run. Run it with scripts/rs-setup.sh (see docs/resourcespace-setup.md).
//
// Ownership rules, so re-running never clobbers admin edits to the wider schema:
// - Base fields (Program / Event etc.) are only CREATED if missing, never modified.
// - Submitter fields, the two groups, the upload-service user and the dash tile
//   are owned by this script: their settings are reset to what is declared here.

include "/var/www/html/include/boot.php";
include_once "/var/www/html/include/dash_functions.php";
include_once "/var/www/html/include/api_functions.php";
include_once "/var/www/html/include/plugin_functions.php";

// Resource types the member upload form can create (it never offers audio).
const UPLOAD_RESOURCE_TYPES = ["Photo", "Video"];

// Stock ResourceSpace fields the upload proxy writes. They ship with every install.
const STOCK_FIELDS = ["title", "date", "caption"];

// SDFWA's member-facing fields (live refs 88-93 on media.sdfwa.org, #22).
// Created with these definitions only when missing, e.g. on a fresh install.
const BASE_FIELDS = [
    "eventname" => ["title" => "Program / Event Name", "type" => FIELD_TYPE_TEXT_BOX_SINGLE_LINE, "required" => 0, "simple_search" => 0, "options" => []],
    "programevent" => ["title" => "Program / Event", "type" => FIELD_TYPE_DROP_DOWN_LIST, "required" => 1, "simple_search" => 1, "options" => [
        "Design in Wood (exhibit)", "Holiday Gift Sale", "Old Tool Swap Meet", "Classes & Workshops",
        "Special Interest Group (SIG) Meeting", "Eye Openers (speaker series)", "Shop / ShopOps",
        "Community Service", "General Meeting / Membership Event", "Board / Admin",
        "Marketing & Promotional", "Other / Uncategorized",
    ]],
    "subjecttype" => ["title" => "Subject Type", "type" => FIELD_TYPE_CHECK_BOX_LIST, "required" => 1, "simple_search" => 1, "options" => [
        "Finished Piece", "Work in Progress", "Technique / Process Demo", "Tool or Equipment",
        "Instruction / Class in Session", "People / Portraits", "Venue / Facility", "Event Candid",
        "Award / Recognition Moment",
    ]],
    "location" => ["title" => "Location", "type" => FIELD_TYPE_DROP_DOWN_LIST, "required" => 0, "simple_search" => 0, "options" => [
        "Shop", "Design in Wood", "Swap Meet", "Shop Tour",
    ]],
];

// Set by the proxy from the verified session. Visible to anyone with f*, editable by nobody but the uploader.
const SUBMITTER_FIELDS = [
    "submittername" => ["title" => "Submitter Name", "type" => FIELD_TYPE_TEXT_BOX_SINGLE_LINE, "indexed" => true],
    "submitteremail" => ["title" => "Submitter Email", "type" => FIELD_TYPE_TEXT_BOX_SINGLE_LINE, "indexed" => true],
    "submittermemberid" => ["title" => "Submitter Member ID", "type" => FIELD_TYPE_TEXT_BOX_SINGLE_LINE, "indexed" => false],
    "submissionid" => ["title" => "Submission ID", "type" => FIELD_TYPE_TEXT_BOX_SINGLE_LINE, "indexed" => true],
    "submitterrights" => ["title" => "Submitter Rights Confirmation", "type" => FIELD_TYPE_TEXT_BOX_MULTI_LINE, "indexed" => false],
    "submitterfilename" => ["title" => "Submitter Original Filename", "type" => FIELD_TYPE_TEXT_BOX_SINGLE_LINE, "indexed" => false],
];

const UPLOADER_GROUP = "Member Upload Service";
const UPLOADER_USER = "upload-service";
// Pruned by the live permission test (#34): every entry is required. f<ref> is
// added for each of the 13 proxy fields (stock + base + submitter).
const UPLOADER_PERMS = ["d", "e-1"];

const REVIEWER_GROUP = "Media Reviewers";
// Pruned by the live permission test (#34). F<ref> denials on the Submitter
// fields are added below. Reviewers reach the pending list from the dash tile:
// Team Centre's link needs `c`, which with e0 would allow uploading straight to Active.
const REVIEWER_PERMS = ["s", "g", "f*", "j*", "v", "t", "e-1", "e0"];

const PENDING_TILE_TITLE = "Pending review";
const PENDING_TILE_TEXT = "Items waiting for review";
const PENDING_TILE_LINK = "pages/search.php?search=&archive=-1&resetrestypes=true";
const PENDING_TILE_URL = "pages/ajax/dash_tile.php?tltype=srch&tlsize=&tlstyle=multi";
// Who gets the tile. Missing groups are skipped (stock installs ship the two admin groups).
const PENDING_TILE_GROUPS = [REVIEWER_GROUP, "Administrators", "Super Admin"];

// Approval uses the rse_workflow plugin's Publish button; it ships with RS but is off by default.
const REQUIRED_PLUGINS = ["rse_workflow"];

function field_ref(string $shortname): int
{
    return (int) ps_value("SELECT ref value FROM resource_type_field WHERE name = ?", ["s", $shortname], 0);
}

function fail(string $msg): void
{
    fwrite(STDERR, "ERROR: $msg\n");
    exit(1);
}

// ---------- plugins ----------
foreach (REQUIRED_PLUGINS as $plugin) {
    if (is_plugin_activated($plugin)) {
        echo "exists  plugin          $plugin\n";
    } else {
        activate_plugin($plugin) || fail("could not activate plugin $plugin");
        echo "enabled plugin          $plugin\n";
    }
}

// ---------- resource types ----------
$restypes = [];
foreach (UPLOAD_RESOURCE_TYPES as $name) {
    $ref = (int) ps_value("SELECT ref value FROM resource_type WHERE name = ?", ["s", $name], 0);
    $ref || fail("resource type '$name' not found");
    $restypes[] = $ref;
}

// ---------- stock + base fields ----------
$proxyFields = [];
foreach (STOCK_FIELDS as $short) {
    ($proxyFields[$short] = field_ref($short)) || fail("stock field '$short' not found");
}
foreach (BASE_FIELDS as $short => $def) {
    $ref = field_ref($short);
    if ($ref) {
        echo "exists  base field      $ref $short\n";
    } else {
        $ref = create_resource_type_field($def["title"], 0, $def["type"], $short, true);
        ps_query(
            "UPDATE resource_type_field SET required = ?, simple_search = ? WHERE ref = ?",
            ["i", $def["required"], "i", $def["simple_search"], "i", $ref]
        );
        foreach ($def["options"] as $i => $option) {
            set_node(null, $ref, $option, null, ($i + 1) * 10);
        }
        echo "created base field      $ref $short (" . count($def["options"]) . " options)\n";
    }
    $proxyFields[$short] = $ref;
}

// ---------- submitter fields ----------
$submitterFields = [];
foreach (SUBMITTER_FIELDS as $short => $def) {
    $ref = field_ref($short);
    if ($ref) {
        echo "exists  submitter field $ref $short\n";
    } else {
        $ref = create_resource_type_field($def["title"], $restypes, $def["type"], $short, $def["indexed"]);
        echo "created submitter field $ref $short\n";
    }
    ps_query(
        "UPDATE resource_type_field SET title = ?, type = ?, required = 0, hide_when_uploading = 1,
            external_user_access = 0, keywords_index = ? WHERE ref = ?",
        ["s", $def["title"], "i", $def["type"], "i", $def["indexed"] ? 1 : 0, "i", $ref]
    );
    update_resource_type_field_resource_types($ref, $restypes);
    $submitterFields[$short] = $ref;
    $proxyFields[$short] = $ref;
}
clear_query_cache("schema");

// ---------- groups ----------
function ensure_group(string $name, array $perms): int
{
    $permstring = implode(",", $perms);
    $ref = (int) ps_value("SELECT ref value FROM usergroup WHERE name = ?", ["s", $name], 0);
    if ($ref) {
        save_usergroup($ref, ["permissions" => $permstring]);
        echo "updated group           $ref $name: $permstring\n";
    } else {
        $ref = (int) save_usergroup(0, ["name" => $name, "permissions" => $permstring, "request_mode" => 1]);
        echo "created group           $ref $name: $permstring\n";
    }
    return $ref;
}

$uploaderGroup = ensure_group(
    UPLOADER_GROUP,
    array_merge(UPLOADER_PERMS, array_map(fn($r) => "f$r", array_values($proxyFields)))
);
$reviewerGroup = ensure_group(
    REVIEWER_GROUP,
    array_merge(REVIEWER_PERMS, array_map(fn($r) => "F$r", array_values($submitterFields)))
);

// ---------- upload-service user ----------
$user = (int) ps_value("SELECT ref value FROM user WHERE username = ?", ["s", UPLOADER_USER], 0);
if ($user) {
    echo "exists  user            $user " . UPLOADER_USER . "\n";
} else {
    // new_user() stores a hash of a random password that is never shown
    $user = (int) new_user(UPLOADER_USER, $uploaderGroup);
    $user > 0 || fail("could not create user " . UPLOADER_USER);
    echo "created user            $user " . UPLOADER_USER . "\n";
}
ps_query(
    "UPDATE user SET usergroup = ?, approved = 1, account_expires = NULL, fullname = ? WHERE ref = ?",
    ["i", $uploaderGroup, "s", UPLOADER_GROUP, "i", $user]
);

// ---------- "Pending review" dash tile ----------
$tileGroups = [];
foreach (PENDING_TILE_GROUPS as $name) {
    $ref = (int) ps_value("SELECT ref value FROM usergroup WHERE name = ?", ["s", $name], 0);
    if ($ref) {
        $tileGroups[$name] = $ref;
    } else {
        echo "skipped dash tile group '$name' (not found)\n";
    }
}
$tile = (int) ps_value("SELECT ref value FROM dash_tile WHERE title = ? ORDER BY ref LIMIT 1", ["s", PENDING_TILE_TITLE], 0);
if ($tile) {
    echo "exists  dash tile       $tile " . PENDING_TILE_TITLE . "\n";
} else {
    $tile = (int) create_dash_tile(
        PENDING_TILE_URL,
        PENDING_TILE_LINK,
        PENDING_TILE_TITLE,
        0,      // no auto reload
        1,      // see all_users below
        null,   // append to the default order
        1,      // show resource count
        PENDING_TILE_TEXT,
        1,
        array_values($tileGroups)
    );
    echo "created dash tile       $tile " . PENDING_TILE_TITLE . "\n";
}
// RS only hands a group tile to users moved into the group (save_user ->
// build_usergroup_dash) when all_users = 1, which is how the admin UI makes them.
// Users outside the groups never get it: create_new_user_dash() skips group tiles.
ps_query(
    "UPDATE dash_tile SET url = ?, link = ?, txt = ?, resource_count = 1, all_users = 1 WHERE ref = ?",
    ["s", PENDING_TILE_URL, "s", PENDING_TILE_LINK, "s", PENDING_TILE_TEXT, "i", $tile]
);
foreach ($tileGroups as $name => $group) {
    add_usergroup_dash_tile($group, $tile, null);
    // Give it to current members who lack it, appended so their own order is kept.
    $missing = ps_array(
        "SELECT ref value FROM user WHERE usergroup = ?
            AND ref NOT IN (SELECT user FROM user_dash_tile WHERE dash_tile = ?)",
        ["i", $group, "i", $tile]
    );
    foreach ($missing as $member) {
        add_user_dash_tile($member, $tile, null, false);
    }
    echo "dash tile group         $group $name" . ($missing ? ", added for " . count($missing) . " user(s)" : "") . "\n";
}

echo "\n" . json_encode([
    "fields" => $proxyFields,
    "uploader_group" => $uploaderGroup,
    "reviewer_group" => $reviewerGroup,
    "upload_user" => $user,
    "pending_tile" => $tile,
    "pending_tile_groups" => $tileGroups,
], JSON_PRETTY_PRINT) . "\n";

if (getenv("RS_PRINT_API_KEY") === "1") {
    // For local development only. In production, copy the key from the user's page into the deploy secret.
    echo "\nRS_UPLOADER_API_KEY=" . get_api_key($user) . "\n";
} else {
    echo "\nNext: copy " . UPLOADER_USER . "'s API key (Admin > Users > " . UPLOADER_USER
        . ") into the deploy secret RS_UPLOADER_API_KEY.\n";
}
