/** The SHA-256 hex of a text or bytes, written once.
 *  NOT here: the contents of any hash (`pipeline/content-hash.ts` decides what is hashed), and — depuis le 30/10/2026 —
 *  la comparaison en temps constant de deux secrets (`core/secrets.ts`) : elle ressortait par la porte légère et serait
 *  partie dans le paquet public, où une bibliothèque de lecture n'a rien à faire d'une primitive de jetons.
 *  Called by: `pipeline/content-hash.ts`, `extractor/docx-reader/` (l'identité d'une image, la somme d'un fichier). */

import { createHash } from "node:crypto";

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
