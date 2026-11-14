# Third-party notices

This package is AGPL-3.0-or-later. It also **redistributes** material owned by others, inside
`dist/index.js`, and carries their notices here.

## Adobe CMap resources: `UniCNS-UCS2-H` and `UniJIS-UCS2-H`, code → CID

`dist/index.js` carries the code → CID tables of Adobe's `UniCNS-UCS2-H` (collection Adobe-CNS1) and
`UniJIS-UCS2-H` (Adobe-Japan1) CMaps, transcribed into three sixteen-bit columns by
`tools/poc/build-cns-cmap.ts` from Adobe's own resources — nothing is taken from any reader. Source:
`adobe-type-tools/cmap-resources`. Their notice:

> Copyright 1990-2019 Adobe. All rights reserved.
>
> Redistribution and use in source and binary forms, with or without modification, are permitted provided
> that the following conditions are met:
>
> Redistributions of source code must retain the above copyright notice, this list of conditions and the
> following disclaimer. Redistributions in binary form must reproduce the above copyright notice, this list
> of conditions and the following disclaimer in the documentation and/or other materials provided with the
> distribution. Neither the name of Adobe nor the names of its contributors may be used to endorse or promote
> products derived from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
> WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
> PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY
> DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
> PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
> HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
> NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

**What is carried and what is not.** The 16 418 `cidrange` entries of the Chinese table and the 8 533 of the
Japanese one, whole and exact — neither resource holds a `cidchar` block or a `usecmap`, so nothing is
inherited from another file (the generator refuses loudly if either ever appears). Left out: the codespace
declaration (`<0000>–<D7FF>`, `<E000>–<FFFF>`), which the reader already applies by cutting two-byte codes;
and the single `notdefrange` of each (`<0000>–<001F>` → CID 1), the C0 control characters, which this product
never publishes anyway.

Until 1/11/2026 the bundle embedded instead the predefined CMaps of pdf.js (`pdfjs-dist/cmaps/*.bcmap`), ~594 KB
for every collection; they left with pdf.js. A PDF that relies on any OTHER predefined CMap (`90ms-RKSJ-H`,
`ETen-B5-H`, the GB and KS collections) falls back on the font's own default width `/DW`, and says so in its tests.

## PDFium, CCITT fax decoding

`dist/index.js` carries a port of the fax (CCITT G3 / G4) decoder of PDFium, in TypeScript:
`src/extractor/codecs/ccitt-fax.ts` and its run-length code tables `ccitt-run-tables.ts`, ported
line for line from PDFium's `core/fxcodec/fax/faxmodule.cpp` (the decoding half). The original
notice, in each file:

> Copyright 2014 The PDFium Authors. Use of this source code is governed by a BSD-style license
> that can be found in the LICENSE file. Original code copyright 2014 Foxit Software Inc.

The licence text is PDFium's own (BSD-3-Clause, Google Inc. and the PDFium Authors). Redistribution
is permitted under it, provided this notice and the copyright line travel with the code. They do.

## JPEG decoder (jpeg-js 0.4.4), vendored

`dist/index.js` carries the decoder of jpeg-js 0.4.4, kept as published in
`src/extractor/codecs/vendor/jpeg-js-decoder.cjs`, with one function added (`decodeRaw`: the four-component
components before colour conversion). The decoding code is jpgjs, copyright 2011 notmasteryet, under the
Apache License 2.0 (its notice is in the file). The jpeg-js package is under the BSD 3-Clause licence below
(Copyright (c) 2014, Eugene Ware).

```
Copyright (c) 2014, Eugene Ware
All rights reserved.
  
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:  

1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.  
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.  
3. Neither the name of Eugene Ware nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.  
  
THIS SOFTWARE IS PROVIDED BY EUGENE WARE ''AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL EUGENE WARE BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Dependencies, not redistributed

These are **not** in the bundle; a consumer installs them and their licences apply to their own
copies: `parse5` (MIT), `@cantoo/pdf-lib` (MIT).

## Why this file exists

A licence scanner reads the registry metadata, which says AGPL only, and a reader of the README
has no reason to suspect embedded resources. Found by the security review of 30/10/2026, before
the first publication — which would have been irreversible.

### PDFium licence (verbatim, BSD part)

```
// Copyright 2014 The PDFium Authors
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google Inc. nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
