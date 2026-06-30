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

# CLIP AI Smart Search. The CLIP plugin ships bundled in RS 11 core; the
# heavy ML inference runs in the separate "clip" container (see docker-compose).
$plugins[] = "clip";
$clip_service_url = getenv('CLIP_SERVICE_URL') ?: 'http://clip:8000';

# AI Faces (InsightFace). Bundled in RS 11 core; inference runs in the separate
# "faces" container. Used under the InsightFace free non-commercial allowance
# (SDFWA is a non-profit). Set $faces_tag_field to a Dynamic Keywords List field
# (created in the field admin) that stores person names.
$plugins[] = "faces";
$faces_service_endpoint = getenv('FACES_SERVICE_URL') ?: 'http://faces:8001';

$simplesamlconfig['authsources'] = 
        [
        'admin' => ['core:AdminPassword'],
        'resourcespace-sp' => [
        'saml:SP',
        'privatekey' => '/var/www/html/filestore/system/saml_6a2f03087abbb.pem',
        'certificate' => '/var/www/html/filestore/system/saml_6a2f03087abbf.crt',
        'entityID' => null,
        'idp' => 'https://accounts.google.com/o/saml2?idpid=C01h8wmv1',
        'discoURL' => null,
        ]
    ];

$simplesamlconfig["config"]["technicalcontact_name"] = 'SDFWA Digital Services';
$simplesamlconfig["config"]["auth.adminpassword"] = getenv('SIMPLESAML_ADMIN_PASSWORD_HASH');

$simplesamlconfig["metadata"]['https://accounts.google.com/o/saml2?idpid=C01h8wmv1'] = array (
  'entityid' => 'https://accounts.google.com/o/saml2?idpid=C01h8wmv1',
  'contacts' => 
  array (
  ),
  'metadata-set' => 'saml20-idp-remote',
  'expire' => 1931121227,
  'SingleSignOnService' => 
  array (
    0 => 
    array (
      'Binding' => 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
      'Location' => 'https://accounts.google.com/o/saml2/idp?idpid=C01h8wmv1',
    ),
    1 => 
    array (
      'Binding' => 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
      'Location' => 'https://accounts.google.com/o/saml2/idp?idpid=C01h8wmv1',
    ),
  ),
  'SingleLogoutService' => 
  array (
  ),
  'ArtifactResolutionService' => 
  array (
  ),
  'NameIDFormats' => 
  array (
    0 => 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  ),
  'keys' => 
  array (
    0 => 
    array (
      'encryption' => false,
      'signing' => true,
      'type' => 'X509Certificate',
      'X509Certificate' => 'MIIDdjCCAl6gAwIBAgIGAZzpVZtrMA0GCSqGSIb3DQEBCwUAMHwxFDASBgNVBAoTC0dvb2dsZSBJbmMuMRYwFAYDVQQHEw1Nb3VudGFpbiBWaWV3MQ8wDQYDVQQDEwZHb29nbGUxGTAXBgNVBAsTEEdvb2dsZSBXb3Jrc3BhY2UxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpDYWxpZm9ybmlhMB4XDTI2MDMxMzIyMzM0N1oXDTMxMDMxMjIyMzM0N1owfDEUMBIGA1UEChMLR29vZ2xlIEluYy4xFjAUBgNVBAcTDU1vdW50YWluIFZpZXcxDzANBgNVBAMTBkdvb2dsZTEZMBcGA1UECxMQR29vZ2xlIFdvcmtzcGFjZTELMAkGA1UEBhMCVVMxEzARBgNVBAgTCkNhbGlmb3JuaWEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDB2uXd+sXhs5jwh6yP923DjCtZ4saAa8QYFUis4gsDLJEPFIp26i1VUQA2UHZFfhHh82OmdI8/zpcWccfzOUOo0Ujl2JYXdaJI8g1/Rw/ckYyWGyj5wzs//hmXs0pAfFAh7+bzMCpo1VJvly00nLmUkd8g0wTQ4vPaEidybPeSVPn5DoK48Vqokp12pZQUwkTGsaNS937v7p5vaCziEpCHE2CG0rIGobj167BnDkVrkr+fII2Zc6Sr/RP3jNVTSXAOAKi84ULyL8X7V+TeD1lWgPALagTdJKuZWhx9enHmECepXUHT+FGIkk/hws2GzYTMEdS26rBeQmUCfAJbDAmNAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAI1PHXov/87GrZloI+JvtSWUcwbWOFQNdJV3RFx/KmXaKXMPj9kBLlHTOANUOppIHAwmr96tWfdiCpb1ceNXsh5vsaQcFOuluDEKODdqhM/V/2Vgn80q6Jjkc+/ySyspG805a7tSwJEiGtjKKson3pozI/+0P6bilvBraQ3wJ1vu6LdCozGCja0A3g7iIxQwZjmbrSCX+rfM+l3k5YtMJ2X9iFD2ebS02oIaNlZv3BmpG07pdM1u0N60mJmtYcIvpUaSWtGV4970GwQLW08HcOEi/rKHTCcVP0oinPSyWwa8XJ0QSEruImyLcu5LdSsgNsLBJSBcEXBzdFiFBzxNBuU=',
    ),
  ),
);