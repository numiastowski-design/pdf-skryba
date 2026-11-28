# Changelog

All notable changes to `pdf-skryba` are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): while the version is `0.x`, a minor
version may break the published surface, and a patch never does. Dates are the publication dates on
the npm registry (UTC).

The package was named `skryba` from 0.1.0 to 0.6.2; `skryba` stays frozen at 0.6.2 and is deprecated
with the message « Renamed to pdf-skryba ». Before 0.1.0 the same reader was published as
`@miksumia/reader`, which the registry no longer serves; those versions are not reconstructed here.

## [0.10.1] - 2026-11-28

### Changed

- No change to the published code. The tests that read only public documents are back in this repository, and
  the development dependencies are at their latest (TypeScript 7 checks the types beside TypeScript 6).

## [0.10.0] - 2026-11-24

### Added

- A `pdf-part-unread` notice (`doc-ir` 0.2.0) names the pages where an object could not be read
  and the page was published without it: its kind was in the damaged bytes, so it may have been a
  picture or a block of text. It is never counted as a lost picture.
- `detectPdfTableGrids` on the first-party reader entry.
- Fuzz property tests, lots 0 to 8, in the repository: the content-stream tokenizer, values, stream
  filters, fonts, the cross-reference table, then the whole document damaged outside its text,
  encrypted, and updated incrementally.

### Changed

- `doc-ir` moves to `^0.2.0`.
- One damaged part that carries no text no longer refuses the whole document: the document
  information, an outline item, an image, a link annotation. That part is left out and the read
  goes on, with the same words.
- A refusal for security still refuses the whole document, never only the part: a bound of the
  reader that bit, such as the work budget. A stream that decodes past the reader's ceiling is now
  refused with its own reason, `stream-too-large`, instead of `stream-decode`.
- Comments and test titles are in English.

### Fixed

- The images of an encrypted file drawn with CCITT fax compression are decrypted before they are
  decoded, like the other images. They were lost.
- After an AI reading, a `table-withheld` notice is kept: only the two loss notices were composed
  again, and the others were dropped.
- The abbreviation `/LZW` of a stream filter is served like `LZWDecode`, and a chain ending in `/Fl`
  or `/LZW` keeps its predictor.
- Every control character is removed from the text of a glyph, not only a glyph made of them.

## [0.9.1] - 2026-11-23

### Fixed

- Faster on long pages: the size test of a drop cap reads a column's smallest line once, instead of
  scanning every line for each short run.
- Less memory: the plan of each page is kept only when a caller asks for it (`onPagePlan`).
- The search for figures set aside skips a page that holds no picture.
- No change to what a document reads as: the published output is the same as 0.9.0.

## [0.9.0] - 2026-11-20

### Changed

- `doc-ir` becomes a dependency taken from the npm registry (`^0.1.0`): the base both readers share
  — the representation a read document comes back in, and the measure that says no word was lost —
  now installs as its own package instead of shipping inside this one.
- Licence: MIT (was AGPL-3.0-or-later up to 0.8.0). The versions already published keep their
  licence. `THIRD-PARTY.md` now carries every third-party notice the bundle owes: the hyphenation
  patterns, the Adobe glyph list and font metrics, the DeviceCMYK conversion, and the text of the
  Apache License 2.0.
- The type declarations of the package's own modules moved inside the archive, from
  `dist/types/packages/doc-read/src/…` to `dist/types/packages/reader/src/…`. The `exports` map
  follows, so the four entries resolve as before; only a deep import of a declaration file sees it.
- The declarations of the layout modules and of the byte gate that only this reader uses moved too,
  from `dist/types/packages/doc-ir/src/…` and `dist/types/packages/doc-gate/src/…` to
  `dist/types/packages/reader/src/…`. What stays under `dist/types/packages/doc-ir/` is what both
  readers share. The four entries resolve as before.

## [0.8.0] - 2026-11-17

### Added

- `require("pdf-skryba")` works from CommonJS on the announced Node.js versions: every entry is
  served under the `default` condition of `exports`. It is the same ES module; no CommonJS build is
  added.
- This changelog ships in the package.

### Changed

- The package announces Node.js 24 or later (`engines`), instead of 20: these are the versions its
  checks run on. npm warns on an older Node and still installs.

### Fixed

- The type declarations name their files with an extension (`./pdf.js`). A project compiled with
  `moduleResolution` set to `node16` or `nodenext` resolved none of the package's internal type
  imports, so every type of the package became `any`.

## [0.7.0] - 2026-11-17

### Changed

- Renamed from `skryba` to `pdf-skryba`.
- The package ships readable code: `dist/index.js` is the default entry, with its source map, and
  the same code minified is available as `pdf-skryba/min` and `pdf-skryba/light/min`.
- A page whose text could not be read never counts as a scanned page, and a file none of whose
  pages gave text is refused (`EXTRACT_FAILED`) instead of being published empty.
- A font that cannot be read publishes no stand-in letters: its words are missing, and said so.

### Added

- A `pdf-text-unread` notice names the pages published without their text, and those where a font
  could not be read (reason `font`). Text a viewer would not show raises none.

## [0.6.2] - 2026-11-16

Published as `skryba`.

### Fixed

- The published type declarations no longer import a package that is not published, so they
  resolve.

## [0.6.1] - 2026-11-14

Published as `skryba`.

### Changed

- `repository` points to the public source repository, and the licence section says the
  Corresponding Source is published there. No code change.

## [0.6.0] - 2026-11-13

Published as `skryba`.

### Changed

- **Breaking for deep type imports**: the declaration files moved from `dist/types/src/` to
  `dist/types/packages/doc-read/src/`. The declared entries are not affected.
- The reader's code changed since 0.5.0; those changes are not itemised here.

## [0.5.0] - 2026-11-11

Published as `skryba`.

### Changed

- A catalogue page laid out in two columns is read column by column. `BandLayout` gains the values
  `items` and `item-cells`; `item-cells` is the default.

## [0.4.0] - 2026-11-10

Published as `skryba`.

### Added

- The `bands` option, with the `rows` layout as its default.
- The `color` and `background` fields.

## [0.3.1] - 2026-11-10

Published as `skryba`.

### Changed

- Hyphenation: a paragraph that ends on a cut word and the next one, starting in lower case, become
  one paragraph; the hyphen stays when both halves are words of the document; the hyphenation table
  is the one of the document's language, where it was English unless the caller named a language.

## [0.3.0] - 2026-11-09

Published as `skryba`.

### Changed

- **Breaking**: the package reads PDF only. The readers of Word, PowerPoint, Excel and Google
  formats moved to the new package [`docs-scribe`](https://www.npmjs.com/package/docs-scribe).
- **Breaking**: `conservationOfRender`, `ConservationSource` and `StructureSets` left the main
  entry. The check is published by the light entry (`skryba/light`, now `pdf-skryba/light`): it
  takes the published text block by block and returns edits in block coordinates, instead of
  writing a page's markup.
- The ceilings shaped by one destination left the reader: the caller sets its own limits.

A version 0.2.0 was prepared and never published.

## [0.1.3] - 2026-11-07

Published as `skryba`.

### Changed

- README and package description corrected to match the code. Documentation only.

## [0.1.2] - 2026-11-07

Published as `skryba`.

### Changed

- Built from the most recent source of the day, so that `latest` carries it. What it changes
  against 0.1.0 is not itemised here.

## [0.1.1] - 2026-11-07

Published as `skryba`.

### Changed

- The first version published from continuous integration. It was built from a source tree two
  days older than the one of 0.1.0; its exact difference from 0.1.0 is not established.

## [0.1.0] - 2026-11-07

Published as `skryba`.

### Added

- First release under the name `skryba`.

The registry also lists `0.0.0-stage` for each name, a placeholder npm creates for staged
publishing. It is not a release.

[Unreleased]: https://github.com/numiastowski-design/pdf-skryba
[0.10.1]: https://www.npmjs.com/package/pdf-skryba/v/0.10.1
[0.8.0]: https://www.npmjs.com/package/pdf-skryba/v/0.8.0
[0.7.0]: https://www.npmjs.com/package/pdf-skryba/v/0.7.0
[0.6.2]: https://www.npmjs.com/package/skryba/v/0.6.2
[0.6.1]: https://www.npmjs.com/package/skryba/v/0.6.1
[0.6.0]: https://www.npmjs.com/package/skryba/v/0.6.0
[0.5.0]: https://www.npmjs.com/package/skryba/v/0.5.0
[0.4.0]: https://www.npmjs.com/package/skryba/v/0.4.0
[0.3.1]: https://www.npmjs.com/package/skryba/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/skryba/v/0.3.0
[0.1.3]: https://www.npmjs.com/package/skryba/v/0.1.3
[0.1.2]: https://www.npmjs.com/package/skryba/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/skryba/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/skryba/v/0.1.0
