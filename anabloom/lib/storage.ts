import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";

// Storage interface. Dev => local filesystem (./uploads). Prod => Supabase
// Storage private bucket, served via short-lived signed URLs.
export interface StoredFile {
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StorageDriver {
  put(userId: string, fileName: string, mimeType: string, data: Buffer): Promise<StoredFile>;
  signedUrl(storagePath: string): Promise<string>;
  get(storagePath: string): Promise<Buffer>;
  remove(storagePath: string): Promise<void>;
}

const UPLOAD_ROOT = join(process.cwd(), "uploads");

const localDriver: StorageDriver = {
  async put(userId, fileName, mimeType, data) {
    const key = `${userId}/${randomUUID()}-${fileName.replace(/[^\w.\-]/g, "_")}`;
    const full = join(UPLOAD_ROOT, key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    return { storagePath: key, fileName, mimeType, sizeBytes: data.length };
  },
  async signedUrl(storagePath) {
    // In dev, files are streamed through /api/files/[...path]
    return `/api/files/${storagePath}`;
  },
  async get(storagePath) {
    return readFile(join(UPLOAD_ROOT, storagePath));
  },
  async remove(storagePath) {
    await unlink(join(UPLOAD_ROOT, storagePath)).catch(() => {});
  },
};

function supabaseDriver(): StorageDriver {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "receipts";

  async function client() {
    const { createClient } = await import("@supabase/supabase-js");
    return createClient(url, key, { auth: { persistSession: false } });
  }

  return {
    async put(userId, fileName, mimeType, data) {
      const path = `${userId}/${randomUUID()}-${fileName.replace(/[^\w.\-]/g, "_")}`;
      const sb = await client();
      const { error } = await sb.storage.from(bucket).upload(path, data, { contentType: mimeType, upsert: false });
      if (error) throw new Error(`Storage upload failed: ${error.message}`);
      return { storagePath: path, fileName, mimeType, sizeBytes: data.length };
    },
    async signedUrl(storagePath) {
      const sb = await client();
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(storagePath, 60 * 10);
      if (error || !data) throw new Error(`Signed URL failed: ${error?.message}`);
      return data.signedUrl;
    },
    async get(storagePath) {
      const sb = await client();
      const { data, error } = await sb.storage.from(bucket).download(storagePath);
      if (error || !data) throw new Error(`Download failed: ${error?.message}`);
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(storagePath) {
      const sb = await client();
      await sb.storage.from(bucket).remove([storagePath]);
    },
  };
}

export function getStorage(): StorageDriver {
  return process.env.STORAGE_DRIVER === "supabase" ? supabaseDriver() : localDriver;
}

export function checksum(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}
