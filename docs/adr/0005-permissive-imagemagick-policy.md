# ResourceSpace's ImageMagick policy is a deny-list with generous limits, not a format allowlist

ResourceSpace itself runs ImageMagick, ffmpeg and exiftool on every upload, and its container holds the MariaDB root credentials and scramble keys in its environment, so a crafted file that exploited one of those tools would be serious. We add an ImageMagick `policy.xml` to the ResourceSpace image but make it deliberately **permissive about formats**: a short deny-list of high-risk coders and path patterns plus generous pixel, memory, time and disk caps. Members can upload only a narrow subset (JPEG, PNG, HEIC, MP4, MOV, enforced in the proxy by file content), but staff uploading through ResourceSpace use the full range of media formats and must not be blocked.

## Consequences

This is a weaker posture than a strict allowlist, and the risk is accepted knowingly: the member path is narrow because of the proxy, the staff path is trusted, and the rest depends on keeping ImageMagick, ffmpeg and exiftool patched. No malware scanner is used in v1; it catches known malware, not media-format exploits.

Decided in: [Decide: Hardening the upload proxy against untrusted files and disk exhaustion](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/23).
