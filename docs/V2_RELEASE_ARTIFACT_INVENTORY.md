# V2 Release Artifact Inventory / Retention Report

Generated: 2026-07-31T10:12:42Z  
Redacted: 2026-07-31T11:05:00Z

Scope: `/Users/ronnie/Desktop/代码/商城/output/releases` scanned read-only by filename, size and mode only. No file was moved, deleted, chmodded, uploaded or opened for content extraction.

## Summary

- Files: 2,297
- Total size: 1.63 GiB
- Files >= 10 MiB: 34
- Sensitive-name candidates: 115
- Candidate bytes under sensitive names: 716,579 bytes
- Mode `0600` sensitive-name candidates: 107
- World-readable files: 2,124

## Aggregate Buckets

| Bucket | Files | Size |
|---|---:|---:|
| Image archives | 8 | 743.7 MiB |
| Source archives | 30 | 374.2 MiB |
| Other compressed archives | 73 | 269.6 MiB |
| Source / evidence text files | 1,508 | 114.7 MiB |
| Screenshots / static assets | 443 | 162.5 MiB |
| Acceptance evidence files | 106 | 472.7 KiB |
| Runtime / config evidence files | 6 | 3.8 KiB |
| Other files | 123 | 190.1 KiB |

## File Types

| Type | Files |
|---|---:|
| `.sql` | 426 |
| `.ts` | 388 |
| `.png` | 249 |
| `.json` | 220 |
| `.js` | 191 |
| `.webp` | 156 |
| `.html` | 119 |
| `.css` | 119 |
| `.tar.gz` | 111 |
| `<none>` | 78 |
| `.sha256` | 54 |
| `.mjs` | 46 |
| `.sh` | 45 |
| `.jpg` | 38 |
| `.env` | 17 |

## Redacted Sensitive-Name Summary

The scan found 115 filename/mode candidates matching private evidence, environment, key, certificate, wallet, secret, token or credential patterns. Concrete names and paths are intentionally omitted from this report to avoid turning an audit artifact into a sensitive index.

| Category | Count / Status |
|---|---:|
| Sensitive-name candidates | 115 |
| Sensitive candidates with mode `0600` | 107 |
| Sensitive candidates not confirmed mode `0600` | 8 |
| Content reviewed | No |
| Files moved / deleted | No |

## Retention Recommendation

1. Keep all current files until a separate destructive cleanup task maps each release to a manifest/checksum and confirms audit lineage.
2. Prioritize future archival review for duplicated image archives, source archives and one-off static/UI patch bundles after their manifests and SHA256SUMS are indexed.
3. Before any upload, broad share, migration or deletion, create a redaction/export plan for private evidence, environment, key, PEM/cert, wallet, token, credential, receipt and production-readiness artifacts.
4. For future cleanup, prefer: immutable manifest index -> encrypted cold archive -> explicit delete list reviewed by release ID.
5. Do not treat this report as production authorization; it is inventory-only evidence.
