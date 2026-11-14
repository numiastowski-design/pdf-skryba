/** One attachment per content: the sha256 is the name, so two identical bars
 *  share one file and a republication renames nothing.
 *  NOT here: what an image means, nor where it goes in the page
 *  (`extractor/pdf-page-markers.ts`, `extractor/pdf-page-figures.ts`).
 *  Called by: `extractor/pdf.ts`, `extractor/pdf-page-markers.ts`,
 *  `extractor/pdf-page-figures.ts`. */

import { sha256Hex } from "doc-ir/lib/digest";

import type { ImageRef } from "doc-ir/lib/ir";
import type { RawImage } from "doc-ir/extractor/raw-image";

export interface ImageStore {
  /** Une image que NOUS fabriquons — aplat, pastille, badge tiré du document.
   *
   *  `selfDescribed` VAUT AUSSI POUR UN BADGE TIRÉ DU DOCUMENT, et pas par
   *  économie. Une image de la taille d'un caractère ne porte aucun texte
   *  qu'un modèle saurait lire : l'analyse rendrait un résultat vide, et la
   *  règle de l'image muette SUPPRIMERAIT alors l'image. Le marquer est donc
   *  ce qui la publie. Accessoirement, c'est un appel au modèle en moins,
   *  conformément à la consigne active. */
  collect: (bytes: Uint8Array, mimeType: string) => ImageRef;
  /** Une image DU document, gardée seulement une fois sa place acquise. */
  keep: (image: RawImage) => void;
  /** Ce que l'extraction publiera, dans l'ordre où les images ont été prises. */
  images: () => RawImage[];
}

/** Un magasin par EXTRACTION, jamais un état de module : deux extractions
 *  concurrentes ne doivent pas mélanger leurs pièces jointes. */
export const createImageStore = (): ImageStore => {
  const bySha = new Map<string, RawImage>();
  return {
    collect: (bytes, mimeType) => {
      const sha256 = sha256Hex(bytes);
      if (!bySha.has(sha256)) bySha.set(sha256, { sha256, bytes, mimeType, selfDescribed: true });
      return { sha256, mimeType };
    },
    keep: (image) => {
      if (!bySha.has(image.sha256)) bySha.set(image.sha256, image);
    },
    images: () => [...bySha.values()],
  };
};
