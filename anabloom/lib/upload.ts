export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];

export function validateUpload(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return "File exceeds the 10 MB limit.";
  if (!ALLOWED_MIME.includes(file.type)) return "Only images and PDFs are allowed.";
  return null;
}
