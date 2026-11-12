/**
 * Leaf types shared by the event and input schemas.
 */

import { z } from "zod";

/**
 * An image attached to a turn. The bytes ride inline as a `data:` URI, so
 * nothing touches disk: each provider hands it straight to its backend (Codex
 * as an image `UserInput`, Claude as a base64 image block).
 *
 * The `data:` cap is a coarse abuse guard (about 3 MB of base64, a 2 MB image).
 */
export const ImageAttachment = z.object({
  /** `data:image/<type>;base64,…` */
  dataUrl: z
    .string()
    .regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "must be an image data URI")
    .max(3_500_000, "image too large"),
  /** Original filename, for display and alt text. */
  name: z.string().optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

/**
 * A document attached to a turn: a PDF as base64, or a text file as its UTF-8
 * text. Like an image it rides inline, so nothing touches disk. Claude reads
 * both as `document` content blocks; Codex reads the text inline and is told a
 * PDF was attached but can't read it.
 *
 * The caps are coarse abuse guards, as for images: about 28 M base64 chars
 * (a 20 MB PDF) and about 1 M chars of text.
 */
export const DocumentAttachment = z.discriminatedUnion("mediaType", [
  z.object({
    /** Original filename, shown to the model as the document's title. */
    name: z.string().min(1).max(255),
    mediaType: z.literal("application/pdf"),
    /** The PDF's bytes, base64 (no `data:` prefix). */
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be base64")
      .max(28_000_000, "document too large"),
  }),
  z.object({
    name: z.string().min(1).max(255),
    mediaType: z.literal("text/plain"),
    /** The file's text. */
    data: z.string().max(1_100_000, "document too large"),
  }),
]);
export type DocumentAttachment = z.infer<typeof DocumentAttachment>;

/** What an event says about an attached document: its name and type, never
 *  its contents. */
export const DocumentRef = z.object({
  name: z.string(),
  mediaType: z.string(),
});
export type DocumentRef = z.infer<typeof DocumentRef>;

