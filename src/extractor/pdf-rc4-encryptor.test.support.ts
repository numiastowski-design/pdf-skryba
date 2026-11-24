/**
 * A test ENCRYPTOR of clear PDF files with the standard security handler and RC4, written from ISO 32000-1:2008 §7.6,
 * never from the reader: §7.6.2 Algorithm 1 (the key of one object), §7.6.3.3 Algorithm 2 (the document key),
 * Algorithm 3 (`/O`), Algorithms 4 and 5 (`/U`, revisions 2 and 3).
 * Decides: what is written (every in-use object of the clear file at an offset, its strings and stream data encrypted
 * with its own key, a stream's `/Length` made direct; the `/Encrypt` dictionary in the clear, §7.6.1; a classic
 * cross-reference table; the trailer's `Root`, `Info`, a new `ID` and `Encrypt`); which securities it can write
 * (`/V 1 /R 2`, 40 bits; `/V 2 /R 3`, 40 to 128 bits; an empty or a real user password).
 * NOT here: AES (`/V 4`, `/V 5`), which the reader refuses by design (`pdf-decrypt.ts`): there is nothing to encrypt
 * for it. The properties (`pdf-decrypt.property.test.ts`).
 * Called by: `pdf-decrypt.property.test.ts`.
 */

import { createHash } from "node:crypto";

import { openPdfObjects } from "./pdf-objects/document";
import type { PdfValue } from "./pdf-objects/objects";
import { parseIndirectObject } from "./pdf-objects/parse";
import { type Choices, modelOf, type ValueModel, writeValue } from "./pdf-objects/pdf-syntax-writer.test.support";
import { readXref } from "./pdf-objects/xref";

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** §7.6.3.3 Algorithm 2 step (a): the 32 padding bytes. */
const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** A password padded or cut to 32 bytes (Algorithm 2 step a). */
function padded(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const head = password.subarray(0, 32);
  out.set(head);
  out.set(PAD.subarray(0, 32 - head.length), head.length);
  return out;
}

function md5(...parts: readonly Uint8Array[]): Uint8Array {
  // eslint-disable-next-line sonarjs/hashing -- MD5 is what ISO 32000-1 §7.6.3.3 prescribes for RC4 keys.
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

/** RC4 (the stream cipher §7.6.2 names), its key scheduling then its output XORed with the data. */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + (s[i] as number) + (key[i % key.length] as number)) % 256;
    const swap = s[i] as number;
    s[i] = s[j] as number;
    s[j] = swap;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k += 1) {
    a = (a + 1) % 256;
    b = (b + (s[a] as number)) % 256;
    const swap = s[a] as number;
    s[a] = s[b] as number;
    s[b] = swap;
    out[k] = (data[k] as number) ^ (s[((s[a] as number) + (s[b] as number)) % 256] as number);
  }
  return out;
}

/** What a writer chooses for its security. */
export interface Rc4Security {
  /** 2 (`/V 1`, 40 bits) or 3 (`/V 2`). */
  readonly revision: 2 | 3;
  /** The key length in bits: 40 for revision 2, a multiple of 8 from 40 to 128 for revision 3. */
  readonly lengthBits: number;
  /** `/P`, a signed 32-bit integer (Table 22). */
  readonly permissions: number;
  readonly userPassword: Uint8Array;
  readonly ownerPassword: Uint8Array;
  /** The first string of the trailer's `/ID` (§14.4). */
  readonly id: Uint8Array;
  /** Declares another algorithm than the one used (`/V 4 /R 4` or `/V 5 /R 5`, AES): the refusal case only. */
  readonly declared?: { readonly v: number; readonly r: number };
}

const keyBytes = (security: Rc4Security): number => (security.revision === 2 ? 5 : security.lengthBits / 8);

function permissionBytes(p: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, p, true);
  return out;
}

/** Algorithm 3: `/O`, the user password encrypted under a key made from the owner password. */
function ownerValue(security: Rc4Security): Uint8Array {
  const n = keyBytes(security);
  let hash = md5(padded(security.ownerPassword.length > 0 ? security.ownerPassword : security.userPassword));
  if (security.revision >= 3) for (let i = 0; i < 50; i += 1) hash = md5(hash);
  const key = hash.subarray(0, n);
  let out = rc4(key, padded(security.userPassword));
  if (security.revision >= 3) {
    for (let i = 1; i <= 19; i += 1)
      out = rc4(
        key.map((byte) => byte ^ i),
        out,
      );
  }
  return out;
}

/** Algorithm 2: the document key, from the USER password. */
function documentKey(security: Rc4Security, owner: Uint8Array): Uint8Array {
  const n = keyBytes(security);
  let hash = md5(padded(security.userPassword), owner, permissionBytes(security.permissions), security.id);
  if (security.revision >= 3) for (let i = 0; i < 50; i += 1) hash = md5(hash.subarray(0, n));
  return hash.subarray(0, n);
}

/** Algorithm 4 (revision 2) and Algorithm 5 (revision 3): `/U`. Revision 3 pads its 16 bytes with 16 arbitrary ones. */
function userValue(security: Rc4Security, key: Uint8Array): Uint8Array {
  if (security.revision === 2) return rc4(key, PAD);
  let out = rc4(key, md5(PAD, security.id));
  for (let i = 1; i <= 19; i += 1)
    out = rc4(
      key.map((byte) => byte ^ i),
      out,
    );
  return concat([out, new Uint8Array(16).fill(0x5a)]);
}

/** Algorithm 1: the key of object `num gen`, the low three bytes of the number and two of the generation. */
function objectKey(key: Uint8Array, num: number, gen: number): Uint8Array {
  const tail = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]);
  return md5(key, tail).subarray(0, Math.min(key.length + 5, 16));
}

/** A value with each string encrypted by `encrypt`. */
function encryptedStrings(model: ValueModel, encrypt: (bytes: Uint8Array) => Uint8Array): ValueModel {
  switch (model.kind) {
    case "string":
      return { kind: "string", bytes: encrypt(model.bytes) };
    case "array":
      return { kind: "array", items: model.items.map((item) => encryptedStrings(item, encrypt)) };
    case "dict":
      return {
        kind: "dict",
        entries: model.entries.map(([key, item]) => [key, encryptedStrings(item, encrypt)] as const),
      };
    default:
      return model;
  }
}

const isStructure = (value: PdfValue): boolean => {
  if (value.kind !== "stream") return false;
  const type = value.dict.get("Type");
  return type?.kind === "name" && (type.value === "XRef" || type.value === "ObjStm");
};

/** One in-use object of the clear file: its value, and the raw data of a stream (undecoded: the file is clear). */
interface ClearObject {
  readonly num: number;
  readonly gen: number;
  readonly value: PdfValue;
  readonly data: Uint8Array | undefined;
}

function clearObjects(bytes: Uint8Array): { objects: ClearObject[]; trailer: ReadonlyMap<string, PdfValue> } {
  const doc = openPdfObjects(bytes);
  const xref = readXref(bytes);
  const lengthOf = (ref: { readonly num: number; readonly gen: number }): number | undefined => {
    const value = doc.resolve({ kind: "ref", num: ref.num, gen: ref.gen });
    return value?.kind === "number" ? value.value : undefined;
  };
  const objects: ClearObject[] = [];
  for (const [num, entry] of [...xref.entries].sort(([a], [b]) => a - b)) {
    if (entry.kind === "offset") {
      const { value } = parseIndirectObject(bytes, entry.offset, lengthOf);
      if (isStructure(value)) continue;
      const data = value.kind === "stream" ? bytes.slice(value.start, value.start + value.length) : undefined;
      objects.push({ num, gen: entry.gen, value, data });
    } else {
      const value = doc.resolve({ kind: "ref", num, gen: 0 });
      if (value !== undefined) objects.push({ num, gen: 0, value, data: undefined });
    }
  }
  return { objects, trailer: xref.trailer };
}

/** The clear file written again, every object at an offset, encrypted with `security` (or left clear when it is
 *  `undefined`, the control that the writing alone changes nothing). */
export function encryptPdf(bytes: Uint8Array, security: Rc4Security | undefined, choices: Choices): Uint8Array {
  const { objects, trailer } = clearObjects(bytes);
  const owner = security === undefined ? undefined : ownerValue(security);
  const key = security === undefined || owner === undefined ? undefined : documentKey(security, owner);
  const parts: Uint8Array[] = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let at = (parts[0] as Uint8Array).length;
  const offsets = new Map<number, { offset: number; gen: number }>();
  const push = (num: number, gen: number, body: Uint8Array): void => {
    offsets.set(num, { offset: at, gen });
    const whole = concat([latin1(`${num} ${gen} obj\n`), body, latin1("\nendobj\n")]);
    parts.push(whole);
    at += whole.length;
  };
  for (const object of objects) {
    const cipher = key === undefined ? undefined : objectKey(key, object.num, object.gen);
    const encrypt = (data: Uint8Array): Uint8Array => (cipher === undefined ? data : rc4(cipher, data));
    if (object.value.kind === "stream") {
      const data = encrypt(object.data as Uint8Array);
      const entries = new Map(object.value.dict);
      entries.set("Length", { kind: "number", value: data.length });
      const dict = encryptedStrings(modelOf({ kind: "dict", entries }), encrypt);
      push(
        object.num,
        object.gen,
        concat([writeValue(dict, choices), latin1("\nstream\n"), data, latin1("\nendstream")]),
      );
    } else {
      push(object.num, object.gen, writeValue(encryptedStrings(modelOf(object.value), encrypt), choices));
    }
  }
  let size = Math.max(0, ...objects.map((object) => object.num)) + 1;
  let encryptRef = "";
  if (security !== undefined && owner !== undefined && key !== undefined) {
    const encryptNum = size;
    size += 1;
    const dict: ValueModel = {
      kind: "dict",
      entries: [
        ["Filter", { kind: "name", value: "Standard" }],
        ["V", { kind: "number", value: security.declared?.v ?? (security.revision === 2 ? 1 : 2) }],
        ["R", { kind: "number", value: security.declared?.r ?? security.revision }],
        ["Length", { kind: "number", value: security.revision === 2 ? 40 : security.lengthBits }],
        ["O", { kind: "string", bytes: owner }],
        ["U", { kind: "string", bytes: userValue(security, key) }],
        ["P", { kind: "number", value: security.permissions }],
      ],
    };
    push(encryptNum, 0, writeValue(dict, choices));
    encryptRef = ` /Encrypt ${encryptNum} 0 R`;
  }
  const xrefAt = at;
  let table = `xref\n0 ${size}\n0000000000 65535 f\r\n`;
  for (let num = 1; num < size; num += 1) {
    const placed = offsets.get(num);
    table +=
      placed === undefined
        ? "0000000000 00001 f\r\n"
        : `${String(placed.offset).padStart(10, "0")} ${String(placed.gen).padStart(5, "0")} n\r\n`;
  }
  const keys: Uint8Array[] = [latin1(`/Size ${size}`)];
  for (const name of ["Root", "Info"]) {
    const value = trailer.get(name);
    if (value !== undefined) keys.push(latin1(` /${name} `), writeValue(modelOf(value), choices));
  }
  const id = security?.id ?? new Uint8Array(16).fill(7);
  const idText = [...id].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  keys.push(latin1(` /ID [<${idText}> <${idText}>]${encryptRef}`));
  parts.push(latin1(`${table}trailer\n<< `), ...keys, latin1(` >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  return concat(parts);
}
