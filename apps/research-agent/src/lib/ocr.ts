import type { Ai } from "../types";

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct" as const;
const TEXT_DENSITY_WORD_THRESHOLD = 30;
const MAX_OCR_TOKENS = 2048;

const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
]);

const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/markdown", "text/csv",
]);

export function isImageMime(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime.toLowerCase());
}

export function isTextMime(mime: string): boolean {
  return TEXT_MIME_TYPES.has(mime.toLowerCase());
}

export function isPdfMime(mime: string): boolean {
  return mime.toLowerCase() === "application/pdf";
}

const ALLOWED_MIME_TYPES = new Set([
  ...IMAGE_MIME_TYPES,
  ...TEXT_MIME_TYPES,
  "application/pdf",
]);

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_TYPES.has(mime.toLowerCase());
}

export interface OcrResult {
  text: string;
  isTextImage: boolean;
}

export async function extractTextFromImage(
  ai: Ai,
  imageBytes: Uint8Array,
  _mimeType: string,
): Promise<OcrResult> {
  const imageArray = Array.from(imageBytes);

  const response = await ai.run(VISION_MODEL, {
    messages: [
      {
        role: "user",
        content: "Extract all text from this image verbatim. If there is no text, respond with EMPTY. Output only the extracted text, nothing else.",
      },
    ],
    image: imageArray,
    max_tokens: MAX_OCR_TOKENS,
  } as unknown);

  const text = (response as { response: string }).response?.trim() ?? "";

  if (!text || text === "EMPTY") {
    return { text: "", isTextImage: false };
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const isTextImage = wordCount >= TEXT_DENSITY_WORD_THRESHOLD;

  return { text, isTextImage };
}

export function mimeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png:  "image/png",
    jpg:  "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif:  "image/gif",
    pdf:  "application/pdf",
    txt:  "text/plain",
    md:   "text/markdown",
    csv:  "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}
