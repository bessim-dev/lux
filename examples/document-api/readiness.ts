import { z } from 'zod';
import { parseServiceOrigin } from '@reotech/mcp-kit';

export const readinessInputSchema = z.strictObject({
  jurisdiction: z.string().regex(/^[A-Z]{2,16}$/u),
  version: z
    .string()
    .max(32)
    .regex(/^[A-Za-z0-9._-]{1,32}$/u)
    .refine(value => value !== '.' && value !== '..'),
});

const boundedString = z.string().max(256);
const nullableString = boundedString.nullable();
const stateSchema = z.enum(['MISSING', 'IDENTITY_MISMATCH', 'UNVERIFIED', 'APPROVED']);
// Matches document-api src/features/country-packs/readiness.ts's returned JSON.
const readinessResponseSchema = z.strictObject({
  jurisdiction: readinessInputSchema.shape.jurisdiction,
  version: readinessInputSchema.shape.version,
  ready: z.boolean(),
  blockerCodes: z.array(boundedString).max(128),
  sources: z
    .array(
      z.strictObject({
        sourceKey: boundedString,
        state: stateSchema,
        documentId: nullableString,
        currentVersionId: nullableString,
        checksumSha256: nullableString,
        verificationId: nullableString,
        reviewerId: nullableString,
        reviewedAt: nullableString,
      }),
    )
    .max(512),
});

export interface DocumentOptions {
  applicationUrl: string;
  /** An operator-owned automation API key. Resolve it on every call. */
  getApiKey: () => string | Promise<string>;
  /** Only for local fixtures or explicitly configured local deployments. */
  allowLoopbackHttp?: boolean;
}

export class DocumentReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentReadinessError';
  }
}

export function createReadinessReader(options: DocumentOptions) {
  const origin = parseServiceOrigin(options.applicationUrl, { allowLoopbackHttp: options.allowLoopbackHttp });
  return async (input: z.infer<typeof readinessInputSchema>) => {
    const parsed = readinessInputSchema.safeParse(input);
    if (!parsed.success) throw new DocumentReadinessError('Invalid country pack identity.');
    const { jurisdiction, version } = parsed.data;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5_000);
    try {
      const key = await Promise.race([
        Promise.resolve(options.getApiKey()),
        new Promise<never>((_resolve, reject) =>
          abort.signal.addEventListener('abort', () => reject(new DocumentReadinessError('Document API readiness request timed out.')), { once: true }),
        ),
      ]);
      if (!key || /[\r\n]/u.test(key)) throw new DocumentReadinessError('Document API credential unavailable.');
      const response = await fetch(`${origin}/v1/knowledge/country-packs/${encodeURIComponent(jurisdiction)}/${encodeURIComponent(version)}/readiness`, {
        method: 'GET',
        headers: { 'x-api-key': key, accept: 'application/json' },
        redirect: 'manual',
        signal: abort.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new DocumentReadinessError('Document API authorization failed.');
        if (response.status >= 300 && response.status < 400) throw new DocumentReadinessError('Document API redirects are disabled.');
        throw new DocumentReadinessError('Document API request failed.');
      }
      if (!response.body) throw new DocumentReadinessError('Document API returned an invalid readiness response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 131_072) {
          await reader.cancel();
          throw new DocumentReadinessError('Document API readiness response exceeded the size limit.');
        }
        chunks.push(chunk.value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      const validated = readinessResponseSchema.safeParse(decoded);
      if (!validated.success || validated.data.jurisdiction !== jurisdiction || validated.data.version !== version) {
        throw new DocumentReadinessError('Document API returned an invalid readiness response.');
      }
      const result = validated.data;
      const counts = { MISSING: 0, IDENTITY_MISMATCH: 0, UNVERIFIED: 0, APPROVED: 0 };
      for (const source of result.sources) counts[source.state] += 1;
      return {
        jurisdiction: result.jurisdiction,
        version: result.version,
        ready: result.ready,
        blockerCodes: result.blockerCodes.slice(0, 20),
        sourceCounts: counts,
        sources: result.sources.slice(0, 20).map(({ sourceKey, state }) => ({ sourceKey, state })),
        omission: {
          totalBlockerCodes: result.blockerCodes.length,
          omittedBlockerCodes: Math.max(0, result.blockerCodes.length - 20),
          totalSources: result.sources.length,
          omittedSources: Math.max(0, result.sources.length - 20),
          omittedFields: ['documentId', 'currentVersionId', 'checksumSha256', 'verificationId', 'reviewerId', 'reviewedAt'],
          continuation: null,
          detailRoute: `/v1/knowledge/country-packs/${encodeURIComponent(jurisdiction)}/${encodeURIComponent(version)}/readiness`,
        },
      };
    } catch (error) {
      if (error instanceof DocumentReadinessError) throw error;
      throw new DocumentReadinessError('Document API readiness request could not be completed.');
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const readinessOutputSchema = z.strictObject({
  jurisdiction: readinessInputSchema.shape.jurisdiction,
  version: readinessInputSchema.shape.version,
  ready: z.boolean(),
  blockerCodes: z.array(boundedString).max(20),
  sourceCounts: z.strictObject({
    MISSING: z.number().int().nonnegative(),
    IDENTITY_MISMATCH: z.number().int().nonnegative(),
    UNVERIFIED: z.number().int().nonnegative(),
    APPROVED: z.number().int().nonnegative(),
  }),
  sources: z.array(z.strictObject({ sourceKey: boundedString, state: stateSchema })).max(20),
  omission: z.strictObject({
    totalBlockerCodes: z.number().int().nonnegative(),
    omittedBlockerCodes: z.number().int().nonnegative(),
    totalSources: z.number().int().nonnegative(),
    omittedSources: z.number().int().nonnegative(),
    omittedFields: z.array(boundedString),
    continuation: z.null(),
    detailRoute: z.string().max(128),
  }),
});
