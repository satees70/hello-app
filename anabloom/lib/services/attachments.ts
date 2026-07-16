import { prisma } from "../prisma";
import { getStorage } from "../storage";
import { validateUpload } from "../upload";

/** Store uploaded files against an entry (validates size/mime, skips empties). */
export async function saveEntryAttachments(userId: string, entryId: string, files: File[]): Promise<void> {
  const entry = await prisma.journalEntry.findFirst({ where: { id: entryId, userId } });
  if (!entry) throw new Error("Entry not found.");
  const storage = getStorage();
  for (const file of files) {
    if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) continue;
    const err = validateUpload(file);
    if (err) throw new Error(err);
    const stored = await storage.put(userId, file.name, file.type, Buffer.from(await file.arrayBuffer()));
    await prisma.attachment.create({
      data: {
        journalEntryId: entryId,
        fileName: stored.fileName,
        storagePath: stored.storagePath,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
      },
    });
  }
}

/** Remove the storage files backing an entry's attachments (rows cascade). */
export async function removeEntryFiles(entryId: string): Promise<void> {
  const attachments = await prisma.attachment.findMany({ where: { journalEntryId: entryId } });
  const storage = getStorage();
  for (const a of attachments) await storage.remove(a.storagePath).catch(() => {});
}
