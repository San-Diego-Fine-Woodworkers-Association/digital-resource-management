<?php
// Live permission test for the Member Media Upload setup (#34). Run it after
// provision.php, via scripts/rs-setup.sh verify (see docs/resourcespace-setup.md).
//
// It copies the real "Member Upload Service" and "Media Reviewers" permission
// strings into throwaway groups with throwaway users, then drives the real API
// and web UI over HTTP(S): an upload exactly as the proxy does it, then review,
// approve and reject. The real groups and users are never touched, and every
// Item, user and group it creates is deleted at the end. Exits 1 on any FAIL.
//
// RS_TEST_BASEURL  URL the container uses to reach ResourceSpace (default: $baseurl)
// RS_TEST_PRUNE=1  also re-run with each permission removed, to show which are needed

include "/var/www/html/include/boot.php";
include_once "/var/www/html/include/api_functions.php";
include_once "/var/www/html/include/dash_functions.php";

const UPLOADER_GROUP = "Member Upload Service";
const REVIEWER_GROUP = "Media Reviewers";
const PENDING_TILE_TITLE = "Pending review";
const SUBMITTER_FIELDS = [
    "submittername", "submitteremail", "submittermemberid", "submissionid", "submitterrights", "submitterfilename",
];
const PROXY_FIELDS = [
    "title", "programevent", "subjecttype", "date", "location", "eventname", "caption", ...SUBMITTER_FIELDS,
];
const PENDING_TILE_ADMIN_GROUPS = ["Administrators", "Super Admin"];
const OPTION_FIELDS = ["programevent", "subjecttype", "location"];
const UA = "Mozilla/5.0 (rs-setup permission test)";

// Known ResourceSpace limits, accepted in #34. Reported as KNOWN, not FAIL.
const KNOWN_LIMITS = [
    "cannot activate own Item via resource-data API" =>
        "core checks only edit access there, not e0; the proxy must never change an Item's status",
    "cannot write a field outside its 13" =>
        "f<ref> governs view only; the proxy must write only its 13 fields",
];

$base = rtrim(getenv("RS_TEST_BASEURL") ?: $baseurl, "/") . "/";
$tag = "zzrstest" . bin2hex(random_bytes(3));   // unique, searchable token for this run
$tmpdir = sys_get_temp_dir() . "/$tag";   // created once the lookups have succeeded
$created = ["resources" => [], "users" => [], "groups" => []];

function field(string $shortname): int
{
    $ref = (int) ps_value("SELECT ref value FROM resource_type_field WHERE name = ?", ["s", $shortname], 0);
    if (!$ref) {
        fwrite(STDERR, "ERROR: field '$shortname' not found; run provision first\n");
        exit(1);
    }
    return $ref;
}

function group_perms(string $name): string
{
    $perms = ps_value("SELECT permissions value FROM usergroup WHERE name = ?", ["s", $name], null);
    if ($perms === null) {
        fwrite(STDERR, "ERROR: group '$name' not found; run provision first\n");
        exit(1);
    }
    return $perms;
}

function db_archive(int $ref): int
{
    return (int) ps_value("SELECT archive value FROM resource WHERE ref = ?", ["i", $ref], -99);
}

// Copy of a real group: same permissions and the same group dash tiles.
function make_group(string $name, string $copyOf): int
{
    global $created;
    $real = (int) ps_value("SELECT ref value FROM usergroup WHERE name = ?", ["s", $copyOf], 0);
    $g = (int) save_usergroup(0, ["name" => $name, "permissions" => group_perms($copyOf), "request_mode" => 1]);
    foreach (ps_query("SELECT dash_tile, default_order_by FROM usergroup_dash_tile WHERE usergroup = ?", ["i", $real]) as $t) {
        add_usergroup_dash_tile($g, $t["dash_tile"], $t["default_order_by"]);
    }
    $created["groups"][] = $g;
    return $g;
}

function make_user(string $name, int $group): array
{
    global $created;
    $u = new_user($name, $group);
    build_usergroup_dash($group, $u);   // as save_user() does when an admin sets a user's group
    // 48 chars: rs_password_verify() rejects 32- and 64-char passwords as look-alike legacy hashes
    $pass = bin2hex(random_bytes(24));
    ps_query(
        "UPDATE user SET approved = 1, account_expires = NULL, fullname = ?, password = ? WHERE ref = ?",
        ["s", $name, "s", rs_password_hash("RS{$name}{$pass}"), "i", $u]
    );
    $created["users"][] = $u;
    return ["ref" => $u, "name" => $name, "pass" => $pass, "key" => get_api_key($u)];
}

// Signed API call; the signed query goes in the URL, an upload is a multipart POST.
function api(array $u, string $function, array $params = [], ?string $file = null): array
{
    global $base;
    $query = "user=" . urlencode($u["name"]) . "&function=$function" . ($params ? "&" . http_build_query($params) : "");
    $ch = curl_init($base . "api/?" . $query . "&sign=" . hash("sha256", $u["key"] . $query));
    if ($file !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, ["file" => new CURLFile($file, "image/jpeg", basename($file))]);
    }
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 120]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ["code" => $code, "raw" => $body, "data" => json_decode((string) $body, true)];
}

// Browser session. Answers RS's JS browser_check() in case $browser_check is on.
function web(string $jar, string $path, ?array $post = null): array
{
    global $base, $browser_check_key;
    $ch = curl_init($base . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar,
        CURLOPT_FOLLOWLOCATION => true, CURLOPT_TIMEOUT => 120, CURLOPT_USERAGENT => UA,
        CURLOPT_COOKIE => "browser_check_cookie=" . xor_base64_encode(hash_hmac("sha512", UA . date('Ymd'), $browser_check_key)),
    ]);
    if ($post !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($post));
    }
    $body = (string) curl_exec($ch);
    $r = ["code" => curl_getinfo($ch, CURLINFO_HTTP_CODE), "type" => (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE), "body" => $body];
    curl_close($ch);
    return $r;
}

function csrf(string $html): string
{
    return preg_match('/name="CSRFToken"\s+value="([^"]+)"/', $html, $m) ? $m[1] : "";
}

function test_image(string $label): string
{
    global $tmpdir;
    $im = imagecreatetruecolor(800, 600);
    imagefill($im, 0, 0, imagecolorallocate($im, 90, 60, 30));
    imagestring($im, 5, 40, 280, "rs-setup permission test $label", imagecolorallocate($im, 255, 255, 255));
    $f = "$tmpdir/$label.jpg";
    imagejpeg($im, $f, 85);
    return $f;
}

// ---------- uploader: what the proxy does ----------
function uploader_suite(array $u, string $tag, bool $info = false): array
{
    global $created, $F, $options, $outsideField;
    $c = [];
    $r = api($u, "create_resource", ["resource_type" => $GLOBALS["photoType"], "archive" => -1]);
    $ref = is_int($r["data"]) ? $r["data"] : null;
    if ($ref) {
        $created["resources"][] = $ref;
    }
    $c["create Item in Quarantine (Pending Review)"] = $ref !== null && db_archive($ref) === -1;
    if ($ref === null) {
        $info && print("  create_resource response {$r['code']}: " . substr((string) $r["raw"], 0, 200) . "\n");
        return ["checks" => $c, "ref" => null];
    }

    $up = api($u, "upload_multipart", ["ref" => $ref, "no_exif" => 1, "revert" => 0], test_image("r$ref"));
    $c["upload file"] = in_array($up["code"], [200, 204], true)
        && (string) ps_value("SELECT file_extension value FROM resource WHERE ref = ?", ["i", $ref], "") === "jpg";
    if ($info && !$c["upload file"]) {
        echo "  upload_multipart response {$up['code']}: " . substr((string) $up["raw"], 0, 300) . "\n";
    }

    $values = [
        "title" => "Permission test $tag",
        "programevent" => $options["programevent"],
        "subjecttype" => $options["subjecttype"],
        "date" => "2026-05-03",
        "location" => $options["location"],
        "eventname" => "Permission test event $tag",
        "caption" => "Permission test caption $tag",
        "submittername" => "Zzname {$tag}person",
        "submitteremail" => "{$tag}@example.invalid",
        "submittermemberid" => "TEST-$tag",
        "submissionid" => "sub$tag",
        "submitterrights" => "Confirmed 2026-01-01T00:00:00Z: test statement $tag",
        "submitterfilename" => "{$tag}_original.jpg",
    ];
    foreach ($values as $short => $value) {
        $res = api($u, "update_field", ["resource" => $ref, "field" => $F[$short], "value" => $value]);
        $c["write $short"] = $res["data"] === true;
        if ($info && $res["data"] !== true) {
            echo "  update_field $short response {$res['code']}: " . substr((string) $res["raw"], 0, 200) . "\n";
        }
    }
    foreach (OPTION_FIELDS as $short) {
        $res = api($u, "get_field_options", ["ref" => $F[$short]]);
        $c["read options of $short"] = is_array($res["data"]) && count($res["data"]) > 0;
    }
    $got = [];
    foreach ((array) api($u, "get_resource_field_data", ["resource" => $ref])["data"] as $row) {
        if (is_array($row) && isset($row["ref"])) {
            $got[(int) $row["ref"]] = (string) ($row["value"] ?? "");
        }
    }
    $mismatch = array_keys(array_filter($values, function ($value, $short) use ($got, $F) {
        $have = $got[$F[$short]] ?? null;
        return $short === "date" ? !str_starts_with((string) $have, $value) : $have !== $value;
    }, ARRAY_FILTER_USE_BOTH));
    $c["read back all 13 values"] = $mismatch === [];
    if ($info && $mismatch) {
        echo "  read-back mismatches: " . implode(", ", $mismatch) . "\n";
    }

    $res = api($u, "create_resource", ["resource_type" => $GLOBALS["photoType"], "archive" => 0]);
    if (is_int($res["data"])) {
        $created["resources"][] = $res["data"];
    }
    $c["cannot create Item as Active"] = !is_int($res["data"]);

    api($u, "put_resource_data", ["resource" => $ref, "data" => json_encode(["archive" => 0])]);
    $c["cannot activate own Item via resource-data API"] = db_archive($ref) !== 0;
    if (db_archive($ref) === 0) {
        ps_query("UPDATE resource SET archive = -1 WHERE ref = ?", ["i", $ref]);  // restore the fixture
    }
    $res = api($u, "update_field", ["resource" => $ref, "field" => $outsideField, "value" => "x"]);
    $c["cannot write a field outside its 13"] = $res["data"] !== true;
    return ["checks" => $c, "ref" => $ref];
}

// ---------- reviewer: review, approve, reject ----------
function reviewer_suite(array $rv, array $fixtureUploader, string $tag, bool $info = false): array
{
    global $tmpdir, $F;
    $c = [];
    $a = uploader_suite($fixtureUploader, $tag)["ref"];
    $b = uploader_suite($fixtureUploader, $tag . "b")["ref"];
    if (!$a || !$b) {
        return ["checks" => ["create fixture Items" => false]];
    }
    $jar = "$tmpdir/jar-" . bin2hex(random_bytes(4));
    $login = web($jar, "login.php");
    $page = web($jar, "login.php", ["username" => $rv["name"], "password" => $rv["pass"], "url" => "", "CSRFToken" => csrf($login["body"])]);
    $c["log in"] = str_contains((string) @file_get_contents($jar), "\tuser\t");
    if ($info && !$c["log in"]) {
        echo "  login response {$page['code']}: " . substr(strip_tags($page["body"]), 0, 300) . "\n";
    }
    // Tile contents load by AJAX; home.php itself carries each tile's ref.
    $tile = (int) ps_value("SELECT ref value FROM dash_tile WHERE title = ? ORDER BY ref LIMIT 1", ["s", PENDING_TILE_TITLE], 0);
    $home = web($jar, "pages/home.php")["body"];
    $tileCheck = "home dash shows '" . PENDING_TILE_TITLE . "' tile";
    $c[$tileCheck] = $tile > 0 && (bool) preg_match('/[?&;]tile=' . $tile . '(?!\d)/', $home);
    if ($info && !$c[$tileCheck]) {
        $rows = ps_value("SELECT count(*) value FROM user_dash_tile WHERE user = ? AND dash_tile = ?", ["i", $rv["ref"], "i", $tile], 0);
        echo "  tile ref $tile, user_dash_tile rows for reviewer: $rows\n";
    }
    foreach (PENDING_TILE_ADMIN_GROUPS as $group) {
        $c["'" . PENDING_TILE_TITLE . "' tile assigned to $group"] = (bool) ps_value(
            "SELECT count(*) value FROM usergroup_dash_tile ugt JOIN usergroup g ON g.ref = ugt.usergroup
                WHERE ugt.dash_tile = ? AND g.name = ?",
            ["i", $tile, "s", $group],
            0
        );
    }
    $list = web($jar, "pages/search.php?search=&archive=-1&resetrestypes=true");
    $c["pending list includes the Item"] = (bool) preg_match('/[?&;]ref=' . $a . '(?!\d)/', $list["body"]);

    $view = web($jar, "pages/view.php?ref=$a");
    $c["open the Item"] = $view["code"] === 200 && str_contains($view["body"], "Permission test $tag");
    $c["Item offers Approval (Publish button)"] = str_contains($view["body"], "rse_workflow_action_1");
    $p = api($rv, "get_resource_path", ["ref" => $a, "size" => "scr", "generate" => 0, "extension" => "jpg"]);
    $prev = is_string($p["data"]) ? web($jar, preg_replace('#^https?://[^/]+/#', "", $p["data"])) : ["code" => 0, "type" => ""];
    $c["load the preview"] = $prev["code"] === 200 && str_starts_with($prev["type"], "image/");
    $dl = web($jar, "pages/download.php?ref=$a&ext=jpg&size=&noattach=true&iaccept=on");
    $c["download the original"] = $dl["code"] === 200 && str_starts_with($dl["body"], "\xFF\xD8");

    $res = api($rv, "update_field", ["resource" => $a, "field" => $F["title"], "value" => "Reviewer edited $tag"]);
    $c["edit Title"] = $res["data"] === true;
    $res = api($rv, "update_field", ["resource" => $a, "field" => $F["submittername"], "value" => "tampered"]);
    $still = (string) ps_value(
        "SELECT n.name value FROM node n JOIN resource_node rn ON rn.node = n.ref WHERE rn.resource = ? AND n.resource_type_field = ?",
        ["i", $a, "i", $F["submittername"]],
        ""
    );
    $c["cannot edit a Submitter field"] = $res["data"] !== true && $still === "Zzname {$tag}person";
    $submitterInputs = implode("|", array_map(fn($s) => $F[$s], SUBMITTER_FIELDS));
    $edit = web($jar, "pages/edit.php?ref=$a");
    $c["edit page has no Submitter inputs"] = $edit["code"] === 200 && !preg_match('/name="field_(' . $submitterInputs . ')"/', $edit["body"]);

    foreach (["Submission ID" => "sub$tag", "Submitter Name" => "{$tag}person", "Submitter Email" => "{$tag}@example.invalid"] as $label => $q) {
        $res = api($rv, "do_search", ["search" => $q, "archive" => -1]);
        $refs = array_map(fn($row) => (int) ($row["ref"] ?? 0), is_array($res["data"]) ? $res["data"] : []);
        $c["find by $label"] = in_array($a, $refs, true);
    }

    // Approval with the real Publish button (rse_workflow action 1)
    web($jar, "pages/view.php?ref=$a", [
        "rse_workflow_action_1" => "true", "resource_status_check_1" => "-1",
        "more_workflow_action_1" => "", "CSRFToken" => csrf($view["body"]),
    ]);
    $c["approve to Active"] = db_archive($a) === 0;

    // Reject = the Delete button, which calls delete_resource -> Deleted (state 3)
    api($rv, "delete_resource", ["resource" => $b]);
    $c["reject to Deleted"] = db_archive($b) === 3;
    return ["checks" => $c];
}

function report(string $title, array $checks): int
{
    echo "$title\n";
    $fails = 0;
    foreach ($checks as $name => $ok) {
        if (!$ok && isset(KNOWN_LIMITS[$name])) {
            echo "  KNOWN $name (" . KNOWN_LIMITS[$name] . ")\n";
        } else {
            echo "  " . ($ok ? "PASS " : "FAIL ") . " $name\n";
            $fails += $ok ? 0 : 1;
        }
    }
    return $fails;
}

function failures(array $checks): array
{
    return array_keys(array_filter($checks, fn($ok) => !$ok));
}

$fails = 0;
try {
    $F = [];
    foreach (PROXY_FIELDS as $short) {
        $F[$short] = field($short);
    }
    $photoType = (int) ps_value("SELECT ref value FROM resource_type WHERE name = 'Photo'", [], 0);
    if (!$photoType) {
        fwrite(STDERR, "ERROR: resource type 'Photo' not found\n");
        exit(1);
    }
    $options = [];
    foreach (OPTION_FIELDS as $short) {
        $options[$short] = (string) ps_value(
            "SELECT name value FROM node WHERE resource_type_field = ? ORDER BY order_by, ref LIMIT 1",
            ["i", $F[$short]],
            ""
        );
    }
    // Any ordinary text field the uploader was not granted, to prove what it can write
    $outsideField = (int) ps_value(
        "SELECT ref value FROM resource_type_field WHERE type IN (0, 1) AND global = 1 AND active = 1
            AND ref NOT IN (" . implode(",", $F) . ") ORDER BY ref LIMIT 1",
        [],
        0
    );

    mkdir($tmpdir);
    $upPerms = group_perms(UPLOADER_GROUP);
    $rvPerms = group_perms(REVIEWER_GROUP);
    $tug = make_group("$tag uploader", UPLOADER_GROUP);
    $trg = make_group("$tag reviewer", REVIEWER_GROUP);
    $fug = make_group("$tag fixture uploader", UPLOADER_GROUP);   // stays at full perms to create reviewer fixtures
    $up = make_user("$tag-uploader", $tug);
    $rv = make_user("$tag-reviewer", $trg);
    $fx = make_user("$tag-fixture", $fug);

    echo "Testing against $base\n";
    echo "uploader: $upPerms\nreviewer: $rvPerms\n\n";
    $u = uploader_suite($up, $tag, true);
    $fails += report("Uploader", $u["checks"]);
    $r = reviewer_suite($rv, $fx, $tag . "r", true);
    $fails += report("Reviewer", $r["checks"]);

    if (getenv("RS_TEST_PRUNE") === "1") {
        echo "\nPruning: drop one permission at a time; anything that newly breaks means it is needed\n";
        $baseUp = failures($u["checks"]);
        $baseRv = failures($r["checks"]);
        foreach (explode(",", $upPerms) as $p) {
            save_usergroup($tug, ["permissions" => implode(",", array_diff(explode(",", $upPerms), [$p]))]);
            $new = array_diff(failures(uploader_suite($up, $tag . "u" . preg_replace('/\W/', '', $p))["checks"]), $baseUp);
            echo "  uploader without $p: " . ($new ? "needed (" . implode("; ", $new) . ")" : "NOT needed") . "\n";
        }
        save_usergroup($tug, ["permissions" => $upPerms]);
        foreach (explode(",", $rvPerms) as $p) {
            if (preg_match('/^F\d+$/', $p)) {
                continue;  // denials, covered by "cannot edit a Submitter field"
            }
            save_usergroup($trg, ["permissions" => implode(",", array_diff(explode(",", $rvPerms), [$p]))]);
            $new = array_diff(failures(reviewer_suite($rv, $fx, $tag . "v" . preg_replace('/\W/', '', $p))["checks"]), $baseRv);
            echo "  reviewer without $p: " . ($new ? "needed (" . implode("; ", $new) . ")" : "NOT needed") . "\n";
        }
    }
} finally {
    foreach (array_unique($created["resources"]) as $ref) {
        delete_resource($ref);              // CLI: moves to Deleted
        if (get_resource_data($ref, false)) {
            delete_resource($ref);          // already Deleted: permanent delete
        }
    }
    foreach ($created["users"] as $user) {
        foreach (ps_array("SELECT ref value FROM collection WHERE user = ?", ["i", $user]) as $col) {
            delete_collection($col);
        }
        ps_query("DELETE FROM user_dash_tile WHERE user = ?", ["i", $user]);
        ps_query("DELETE FROM user WHERE ref = ?", ["i", $user]);
    }
    foreach ($created["groups"] as $g) {
        delete_usergroup($g);
    }
    if (is_dir($tmpdir)) {
        array_map("unlink", glob("$tmpdir/*"));
        rmdir($tmpdir);
    }
    $left = $created["resources"]
        ? ps_value("SELECT count(*) value FROM resource WHERE ref IN (" . implode(",", array_map("intval", $created["resources"])) . ")", [], 0)
        : 0;
    echo "\nCleanup: " . count(array_unique($created["resources"])) . " test Items ($left left), "
        . count($created["users"]) . " users, " . count($created["groups"]) . " groups removed\n";
}
echo $fails ? "\n$fails check(s) FAILED\n" : "\nAll checks passed\n";
exit($fails ? 1 : 0);
