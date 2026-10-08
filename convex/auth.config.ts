import type { AuthConfig } from 'convex/server';
const domain = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (!domain) throw new Error('Set CLERK_JWT_ISSUER_DOMAIN in the Convex deployment environment.');
export default { providers: [{ domain, applicationID: 'convex' }] } satisfies AuthConfig;
