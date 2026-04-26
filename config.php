<?php
###############################
## ResourceSpace
## Local Configuration Script
###############################

# All custom settings should be entered in this file.
# Options may be copied from config.default.php and configured here.

# MySQL database settings
$mysql_server = getenv('MYSQL_SERVER');
$mysql_username = getenv('MYSQL_ROOT_USER');
$mysql_password = getenv('MYSQL_ROOT_PASSWORD');
$read_only_db_username = getenv('MYSQL_READ_ONLY_USER');
$read_only_db_password = getenv('MYSQL_READ_ONLY_PASSWORD');
$mysql_db = getenv('MYSQL_DATABASE');

$domain = getenv('DOMAIN_NAME') ?: 'localhost';
// Use HTTPS if you're in production, otherwise HTTP
$protocol = (getenv('STAGE') === 'production' || $domain !== 'localhost') ? 'https://' : 'http://';

if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = 443;
}

# Base URL of the installation
$baseurl = $protocol . $domain;

# Email settings
$email_notify = getenv('EMAIL_NOTIFY');
$email_from = getenv('EMAIL_FROM');
# Secure keys
$scramble_key = getenv('SCRAMBLE_KEY');
$api_scramble_key = getenv('API_SCRAMBLE_KEY');

# Paths
$imagemagick_path = '/usr/bin';
$ghostscript_path = '/usr/bin';
$ffmpeg_path = '/usr/bin';
$exiftool_path = '/usr/bin';
$pdftotext_path = '/usr/bin';

$applicationname = 'ResourceSpace';
$homeanim_folder = 'filestore/system/slideshow_e281c223b771530';

$password_salt = "";
$hash_algorithm = "sha256";
/*

New Installation Defaults
-------------------------

The following configuration options are set for new installations only.
This provides a mechanism for enabling new features for new installations without affecting existing installations (as would occur with changes to config.default.php)

*/
     
// Set imagemagick default for new installs to expect the newer version with the sRGB bug fixed.
$imagemagick_colorspace = "sRGB";

$contact_link=false;
$themes_simple_view=true;

$stemming=true;
$case_insensitive_username=true;
$user_pref_user_management_notifications=true;

$use_zip_extension=true;
$collection_download=true;

$ffmpeg_preview_force = true;
$ffmpeg_preview_extension = 'mp4';
$ffmpeg_preview_options = '-f mp4 -b:v 1200k -b:a 64k -ac 1 -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3 -c:a aac -strict -2';

$daterange_search = true;
$upload_then_edit = true;

$purge_temp_folder_age=90;
$filestore_evenspread=true;

$comments_resource_enable=true;

$api_upload_urls = array();

$use_native_input_for_date_field = true;
$resource_view_use_pre = true;

$sort_tabs = false;
$maxyear_extends_current = 5;
$thumbs_display_archive_state = true;
$file_checksums = true;
$hide_real_filepath = true;
$annotate_enabled = true;

$plugins[] = "brand_guidelines";