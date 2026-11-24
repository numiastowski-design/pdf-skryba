# Third-party notices

This package is under the MIT licence (`LICENSE`). Its bundle (`dist/`) also **redistributes**
material owned by others, each under its own permissive licence. Their notices are carried here,
as those licences ask. The MIT licence covers the rest.

## Adobe CMap resources: `UniCNS-UCS2-H` and `UniJIS-UCS2-H`, code → CID

`dist/index.js` carries the code → CID tables of Adobe's `UniCNS-UCS2-H` (collection Adobe-CNS1) and
`UniJIS-UCS2-H` (Adobe-Japan1) CMaps, transcribed into three sixteen-bit columns from Adobe's own
resources — nothing is taken from any reader. Source: `adobe-type-tools/cmap-resources`. Their notice:

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
inherited from another file. Left out: the codespace declaration (`<0000>–<D7FF>`, `<E000>–<FFFF>`), which the
reader already applies by cutting two-byte codes; and the single `notdefrange` of each (`<0000>–<001F>` →
CID 1), the C0 control characters.

A PDF that relies on any OTHER predefined CMap (`90ms-RKSJ-H`, `ETen-B5-H`, the GB and KS collections) falls
back on the font's own default width `/DW`.

## Adobe Glyph List

`dist/index.js` carries the glyph name → Unicode table of the Adobe Glyph List (`glyphlist.txt`), packed
into one string, and the glyph names of the PDF encodings read through it. The Symbol table of the base
(`doc-ir`) is built from the same list. Source: `adobe-type-tools/agl-aglfn`. Its notice (BSD 3-Clause):

> Copyright 2002-2019 Adobe (http://www.adobe.com/).
>
> Redistribution and use in source and binary forms, with or without modification, are permitted provided
> that the following conditions are met:
>
> Redistributions of source code must retain the above copyright notice, this list of conditions and the
> following disclaimer.
>
> Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
> following disclaimer in the documentation and/or other materials provided with the distribution.
>
> Neither the name of Adobe nor the names of its contributors may be used to endorse or promote products
> derived from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
> WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
> PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY
> DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
> PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
> HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
> NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

## Adobe Font Metrics of the 14 standard PDF fonts (APAFML)

`dist/index.js` carries the advance widths of the 14 standard fonts, by glyph name, and the built-in
encodings of Helvetica, Symbol and ZapfDingbats, all read from Adobe's Core 14 AFM files. The AFM files
themselves are not in the package; the repository keeps them whole, as the generator's input
(`tools/poc/data/afm/`), together with Adobe's `MustRead.html`. Their notice (SPDX `APAFML`):

> Copyright (c) 1985, 1987, 1989, 1990, 1991, 1992, 1993, 1997 Adobe Systems Incorporated. All Rights
> Reserved.
>
> This file and the 14 PostScript(R) AFM files it accompanies may be used, copied, and distributed for any
> purpose and without charge, with or without modification, provided that all copyright notices are
> retained; that the AFM files are not distributed without this file; that all modifications to this file
> or any of the AFM files are prominently noted in the modified file(s); and that this paragraph is not
> modified. Adobe Systems has no responsibility or obligation to support the use of the AFM files.

**Modification, noted as the notice asks.** Only the widths and the encoding slots are kept, rewritten as
`name=width` lists and arrays of names; every other AFM field (kerning, bounding boxes, composites) is left
out.

## Code page tables (WinAnsi, MacRoman)

The glyph names of `WinAnsiEncoding` and `MacRomanEncoding` are derived from two mapping tables published
by the Unicode Consortium: `CP1252.TXT` (cp1252 to Unicode, Microsoft) and `ROMAN.TXT` (Mac OS Roman to
Unicode, © 1994-2002, 2005 Apple Computer, Inc.). Neither file is in the package: each code was turned into
a glyph name through the Adobe Glyph List. The repository keeps both whole, as the generator's input
(`tools/poc/data/`), with the Unicode License v3 that covers the data files the Consortium publishes
(`tools/poc/data/LICENSE-UNICODE.txt`).

## Hyphenation patterns (hyph-utf8): American English and French

`dist/index.js` carries the Knuth-Liang hyphenation patterns of the `hyph-utf8` package for American
English (`hyph-en-us.tex`, 2005-05-30) and French (`hyph-fr.tex`, V2.13 2016/05/12). The TeX comments are
stripped and the tokens joined by spaces; the tokens themselves are unmodified.

American English (the file holds the additional patterns of its author together with the original
patterns of the Plain TeX `hyphen.tex`). Its notice:

> Copyright (C) 1990, 2004, 2005 Gerard D.C. Kuiken
>
> Copying and distribution of this file, with or without modification, are permitted in any medium without
> royalty provided the copyright notice and this notice are preserved.

French. Its notice (MIT):

> Copyright (C) 1994-2002 Daniel Flipo, Bernard Gaulle, 2016 Arthur Reutenauer
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction, including
> without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
> following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial
> portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
> LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
> EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
> IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
> USE OR OTHER DEALINGS IN THE SOFTWARE.

## PDFium, CCITT fax decoding

`dist/index.js` carries a port of the fax (CCITT G3 / G4) decoder of PDFium, in TypeScript:
`src/extractor/codecs/ccitt-fax.ts` and its run-length code tables `ccitt-run-tables.ts`, ported
line for line from PDFium's `core/fxcodec/fax/faxmodule.cpp` (the decoding half). The original
notice, in each file:

> Copyright 2014 The PDFium Authors. Use of this source code is governed by a BSD-style license
> that can be found in the LICENSE file. Original code copyright 2014 Foxit Software Inc.

The licence text is PDFium's own (BSD 3-Clause, Google Inc. and the PDFium Authors), reproduced whole:

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

## JPEG decoder (jpeg-js 0.4.4), vendored

`dist/index.js` carries the decoder of jpeg-js 0.4.4, kept as published in
`src/extractor/codecs/vendor/jpeg-js-decoder.cjs`. **Changed file, as the Apache licence asks to say:**
one function is added at its end (`decodeRaw`: the components before colour conversion), marked as
added in the file. The decoding code is jpgjs, copyright 2011 notmasteryet, under the Apache License 2.0
(its notice is in the file; the licence text is at the end of this document). The jpeg-js package is
under the BSD 3-Clause licence below.

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

## pdf.js: DeviceCMYK conversion and Symbol table

`dist/index.js` carries the polynomial that turns DeviceCMYK into RGB (`src/extractor/pdf-colour-ours.ts`,
`cmykBytes`), whose coefficients are those of pdf.js (`src/core/colorspace.js`), and the Symbol code →
Unicode table of the base (`doc-ir`), generated once from the tables of pdf.js. pdf.js is under the Apache
License 2.0 (text at the end of this document). Its notice:

> Copyright 2012 Mozilla Foundation
>
> Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in
> compliance with the License. You may obtain a copy of the License at
>
> http://www.apache.org/licenses/LICENSE-2.0
>
> Unless required by applicable law or agreed to in writing, software distributed under the License is
> distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
> See the License for the specific language governing permissions and limitations under the License.

## Dependencies, not redistributed

This one is **not** in the bundle; a consumer installs it and its licence applies to their own copy:
`@cantoo/pdf-lib` (MIT).

## Test documents

The test documents of the repository are not part of the package and are not under the MIT licence. Each
keeps its own licence, written in the `SOURCES.md` of its folder (`fixtures/**/SOURCES.md`).

## Apache License 2.0 (text)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
