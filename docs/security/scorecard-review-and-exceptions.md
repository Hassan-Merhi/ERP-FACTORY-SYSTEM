# Security Scorecard: review practice and documented exceptions

This application is proprietary. Do not change repository visibility, replace the
proprietary `LICENSE`, or weaken merge protection merely to increase a public
open-source score. Treat the underlying risks on their merits.

## Real code review (Scorecard Code-Review, alert #92)

An independent GitHub **Approve** review on a pull request is different from
CI success, an AI-generated review comment, or an author's own review.
Scorecard counts actual approved changesets over a recent sample; adding a
workflow or checklist does **not** retroactively improve that score.

For sensitive changes, ask a different eligible human maintainer to inspect
the diff and record an approval when feasible. Review authentication,
tenant isolation, financial and inventory posting, secret handling, and
rollback/testing evidence. Keep the PR template's reviewer field honest.
If no eligible reviewer is available, say so and use the existing CI and
security checks without manufacturing an approval.

This is an advisory review practice. It does not change GitHub branch
protection or require approvals for every merge.

## Gradle wrapper JAR (Scorecard Binary-Artifacts, alert #17)

`android/gradle/wrapper/gradle-wrapper.jar` is needed for the standard Gradle
wrapper launcher and is an official known Gradle wrapper JAR. Its pinned
SHA-256 is:

`2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`

The build also pins the Gradle 9.8.1 distribution SHA-256 in
`android/gradle/wrapper/gradle-wrapper.properties`.

`.github/workflows/gradle-wrapper-integrity.yml` validates both checksums and
uses SHA-pinned `gradle/actions/wrapper-validation` on PRs, pushes to main,
and a weekly schedule. Keeping the wrapper JAR is a conscious compatibility
decision; deleting it just to improve Scorecard can break Android builds.
Scorecard can still mark the tracked binary despite verified provenance.

Before accepting this finding, verify that the latest wrapper-integrity run
passed and that the file's checksum remains unchanged. A repository maintainer
may then mark the finding `Won't fix` in GitHub code scanning, with a
reference to the verified integrity workflow. Do not label it a false positive:
the tracked binary exists.

## OpenSSF Best Practices badge (Scorecard CII-Best-Practices, alert #93)

OpenSSF Best Practices is a self-certification program for Free/Libre and Open
Source Software, requiring a FLOSS license and publicly readable source.
The ERP `LICENSE` expressly keeps its source proprietary. The badge is
therefore not appropriate for the current licensing/business model, and a
0/10 badge score does not establish an exploitable vulnerability.

References:
- https://openssf.org/projects/best-practices-badge/
- https://www.bestpractices.dev/en/criteria/0

Do **not** submit unsupported certification claims or change the license to
earn this badge. A maintainer can mark the Code Scanning finding `Won't fix`
because this proprietary project is outside the badge's intended scope.
Revisit only if the owner explicitly chooses a FLOSS/public-source model.

## Branch Protection (Scorecard alert #1)

The owner intentionally manages merges and post-merge certification separately.
Changes to protection policy are **out of scope** for this document.

## Alert lifecycle and review

- A GitHub Actions workflow succeeding is not the same as its security score
  being 10/10 or the Code Scanning alert being closed.
- CodeQL code findings require a fix and a completed analysis on the default
  branch before assuming auto-closure.
- Scorecard alerts may remain open after controls have mitigated the risk.
  Record the reason and evidence before any `Won't fix` dismissal.
- Only an authorized repository maintainer should decide to dismiss a finding.
  This document does not itself dismiss or close any alerts.
