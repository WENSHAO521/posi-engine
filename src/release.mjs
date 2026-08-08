/**
 * PJR release assembly — implements posi-data/PJR-SPEC.md § 1–3.
 *
 * STUB. Intended flow, run by a GitHub Actions workflow against a specific
 * posi-data commit:
 *   1. Collect that commit's generated metrics/ and rankings/ records.
 *   2. Build manifest.json (§ 2), pinning data_commit and this repo's own commit.
 *   3. Package bulk CSV/JSONL assets + SHA256SUMS (§ 3).
 *   4. Tag and publish a GitHub Release on posi-data named PJR-{year}.{revision}.
 * Not implemented — there is no metrics/rankings data to package yet.
 */

export function buildManifest() {
  throw new Error('not implemented — see PJR-SPEC.md § 2 for the target manifest shape')
}
