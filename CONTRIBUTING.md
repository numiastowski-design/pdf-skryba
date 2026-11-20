# Contributing to pdf-skryba

## Report a defect

Open an issue with the bug report template. Give the version, what you expected and what you
got, and the smallest PDF that shows it.

Attach only a file you may publish: one you built for the report, or one under an open licence.
Never attach a personal, confidential or company document. An issue is public.

A security flaw is not reported in an issue: see `SECURITY.md`.

## Propose a change

1. Open an issue first and describe the change. A pull request nobody expected may be refused
   whatever its quality.
2. Fork the repository, work on a branch, and open a pull request against `main`.
3. One subject per pull request. A behaviour change comes with its test, written first and seen
   failing.

**Every outside proposal is accepted or refused by the maintainer in person.** Nobody else merges
it, and no automation does. A refusal is not a judgement on your work: these libraries are kept
small on purpose.

## The licence of a contribution

**A contribution is received under the MIT licence of the repository, the one it is published
under.** No other agreement is asked.

Submit only code you have the right to submit under that licence. Code copied or adapted from
elsewhere is named in the pull request, with its source and its licence, and its notice goes into
`THIRD-PARTY.md`. Code under a copyleft licence (GPL, LGPL, AGPL) is refused.

## Checks to pass

All of these, on your branch, before you ask for a review:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
```

The same checks run on the pull request. A check is never weakened to let code through: no rule
turned off, no threshold raised.

## Test documents

A test document enters the repository only in one of two cases:

- it is **built by a generator kept in the repository**, so that anyone can rebuild it;
- it is published under an **open licence**, and its source, author and licence are written in
  the `SOURCES.md` of its folder.

Never a personal document, and never a company document, even anonymised.

## No names of people

No name of a person in the code, the comments, the tests, the test documents or the file names.
The author of this library is Miksumia. Commit authorship is the only place a name appears.

## Language

Code, identifiers, comments and documentation are in English.
