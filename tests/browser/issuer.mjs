// Local verification only. Never deploy this issuer or configure a hosted backend to trust it.
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
const issuer = 'http://127.0.0.1:24102';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'local-test', alg: 'RS256', use: 'sig' };
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:24100');
  const url = new URL(req.url, issuer);
  if (url.pathname === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer, jwks_uri: issuer + '/jwks' }));
  if (url.pathname === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
  if (url.pathname === '/token') {
    const user = url.searchParams.get('user') || 'owner';
    if (!['owner', 'teammate', 'outsider'].includes(user)) {
      res.statusCode = 400;
      return res.end('{}');
    }
    const now = Math.floor(Date.now() / 1000);
    const body =
      b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }) +
      '.' +
      b64({
        iss: issuer,
        sub: user,
        aud: 'convex',
        email: user + '@example.com',
        email_verified: true,
        name: user === 'owner' ? 'Test Owner' : 'Test Teammate',
        iat: now,
        exp: now + 3600,
      });
    return res.end(JSON.stringify({ token: body + '.' + sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url') }));
  }
  res.statusCode = 404;
  res.end('{}');
}).listen(24102, '127.0.0.1', () => console.log('Local-only test issuer listening on 24102'));
