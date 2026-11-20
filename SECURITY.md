# Security policy

## Reporting a vulnerability

Write to <contact@miksumia.com>. Do not open a public issue, and do not describe the flaw in a
pull request.

Say which package and version, what an attacker can do, and how to reproduce it. If a file
triggers the flaw, attach one you built for the purpose or a public one. Never send a
confidential document.

You get an answer by email. The fix is published as a new version, and the flaw is described in
`CHANGELOG.md` once that version is out.

## Supported versions

The latest published version of the package. A fix is not ported to earlier versions.

## What counts

These libraries read files that may be hostile. A file that makes a reader run without bound
(time or memory), read outside its input, reach the network or the filesystem, or execute
anything, is a vulnerability. A file that is read wrongly, or refused, is a defect: report it as
an ordinary issue.
