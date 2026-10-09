import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PlaneExport } from './plane';
import { fileSchema } from '../shared/model';

const attachmentSchema = z
  .object({
    id: z.string().uuid(),
    size: z.number().int().nonnegative(),
    is_uploaded: z.boolean(),
    is_deleted: z.boolean().optional(),
    attributes: z.object({ name: z.string(), type: z.string().max(200) }),
  })
  .passthrough();
const MAX_BYTES = 25 * 1024 * 1024;
const responseSchema = z.object({ status: z.enum(['new', 'unchanged', 'conflict']), sha256: z.string().nullable() });
export type AttachmentTransport = (
  name: 'imports:fileStatus' | 'files:uploadUrl' | 'imports:attachFile' | 'files:download',
  args: Record<string, string>,
) => Promise<unknown>;
async function bytes(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Attachment response has no body.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Attachment exceeds the 25 MB limit.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
export async function importPlaneAttachments(source: PlaneExport, apiKey: string, workspace: string, member: string, transport: AttachmentTransport) {
  if (!source.complete) throw new Error('Finish the source export before importing attachment bytes.');
  const namespace = `${source.source}/${source.workspace}`,
    results: Array<{ id: string; status: string }> = [];
  for (const bundle of source.projects)
    for (const entry of bundle.tasks)
      for (const raw of entry.attachments) {
        const attachment = attachmentSchema.parse(raw),
          key = `plane_f_${attachment.id}`,
          project = `plane_p_${bundle.project.id}`,
          task = `plane_t_${entry.task.id}`;
        if (!attachment.is_uploaded || attachment.is_deleted) {
          results.push({ id: attachment.id, status: 'skipped-unavailable-source' });
          continue;
        }
        if (attachment.size > MAX_BYTES) {
          results.push({ id: attachment.id, status: 'skipped-over-25-MB' });
          continue;
        }
        const status = responseSchema.parse(await transport('imports:fileStatus', { workspace, namespace, sourceId: attachment.id, key, project, task }));
        if (status.status === 'conflict') throw new Error(`Attachment ${attachment.id} changed locally or was deleted. Review before retrying.`);
        if (status.status === 'unchanged') {
          results.push({ id: attachment.id, status: 'unchanged' });
          continue;
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
        // Plane authentication is sent only to Plane. The presigned redirect is fetched without it.
        const endpoint = `${source.source}/api/v1/workspaces/${source.workspace}/projects/${bundle.project.id}/issues/${entry.task.id}/issue-attachments/${attachment.id}/`;
        const response = await fetch(endpoint, { headers: { 'X-Api-Key': apiKey }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
        if (![301, 302, 303, 307, 308].includes(response.status)) throw new Error(`Plane attachment ${attachment.id} returned ${response.status}.`);
        const location = response.headers.get('location');
        if (!location) throw new Error('Plane attachment has no download redirect.');
        const url = new URL(location, source.source);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe source attachment redirect.');
        const download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!download.ok) throw new Error(`Source attachment download returned ${download.status}.`);
        const content = await bytes(download);
        if (content.byteLength !== attachment.size) throw new Error('Source attachment size does not match its metadata.');
        const sha256 = createHash('sha256').update(content).digest('base64');
        const uploadUrl = z
          .string()
          .url()
          .parse(await transport('files:uploadUrl', { workspace, project }));
        const upload = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': attachment.attributes.type || 'application/octet-stream' },
          body: content,
          signal: AbortSignal.timeout(30000),
        });
        if (!upload.ok) throw new Error(`Lux attachment upload returned ${upload.status}.`);
        const { storageId } = z.object({ storageId: z.string() }).parse(await upload.json());
        const type = attachment.attributes.type.startsWith('image/')
          ? 'img'
          : attachment.attributes.type === 'application/pdf'
            ? 'pdf'
            : attachment.attributes.type === 'application/zip'
              ? 'zip'
              : 'file';
        const file = fileSchema.parse({
          id: key,
          name: attachment.attributes.name,
          type,
          size: `${content.byteLength} B`,
          by: member,
          at: Date.now(),
          project,
          task,
        });
        await transport('imports:attachFile', {
          workspace,
          namespace,
          sourceId: attachment.id,
          storage: storageId,
          file: JSON.stringify(file),
          raw: JSON.stringify(raw),
          sha256,
        });
        const targetUrl = z
          .string()
          .url()
          .parse(await transport('files:download', { workspace, file: key }));
        const target = await fetch(targetUrl, { signal: AbortSignal.timeout(30000) });
        if (!target.ok) throw new Error('Lux attachment verification download failed.');
        if (
          createHash('sha256')
            .update(await bytes(target))
            .digest('base64') !== sha256
        )
          throw new Error('Lux attachment checksum verification failed.');
        results.push({ id: attachment.id, status: 'created-and-verified' });
        console.error(`Attachment ${results.length}: copied and verified`);
      }
  return results;
}
