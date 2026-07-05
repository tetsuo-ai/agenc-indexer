import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

/**
 * GET /api/jobspec-check backing logic: fetch a creator-supplied job-spec URI
 * server-side and report its sha-256 + size + content type, so the web create
 * flow can pin an honest job_spec_hash without CORS pain.
 *
 * The URI is UNTRUSTED INPUT (it will be user-typed in the create flow), so
 * this is a textbook SSRF surface. Guards, all fail-closed:
 *  - https only, default port (443) only, no credentials in the URL
 *  - hostname resolved first; EVERY resolved address must be public
 *    (loopback, private, link-local, CGNAT, ULA, multicast, mapped/embedded
 *    IPv4 forms, documentation ranges are all rejected)
 *  - the TCP connection is PINNED to the vetted address (custom `lookup`),
 *    closing the DNS-rebinding TOCTOU window
 *  - redirects are NOT followed (3xx is an error — a redirect could point
 *    anywhere, including non-https)
 *  - 256 KiB response cap, 5s total deadline, bounded concurrency
 */

export const JOB_SPEC_MAX_BYTES = 256 * 1024;
export const JOB_SPEC_TIMEOUT_MS = 5_000;
const MAX_URI_LENGTH = 2_048;
const MAX_CONCURRENT_CHECKS = 4;

export type JobSpecCheckResult = {
  /** sha-256 of the exact response bytes, hex (64 chars). */
  sha256: string;
  /** Response size in bytes. */
  bytes: number;
  /** Content-Type response header, or null when absent. */
  contentType: string | null;
};

/** {@link fetchSpecBody} result: the check plus the body as UTF-8 text. */
export type SpecBodyResult = JobSpecCheckResult & {
  /** Response body decoded as UTF-8 (lenient), for JSON metadata parsing. */
  text: string;
};

/** Client-fault failure (bad URI / blocked target / oversized / upstream). */
export class JobSpecCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobSpecCheckError';
  }
}

/* ----------------------------- IP vetting ----------------------------- */

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function isPublicIPv4(ip: string): boolean {
  const octets = parseIPv4(ip);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // 10/8 private
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 127) return false; // 127/8 loopback
  if (a === 169 && b === 254) return false; // 169.254/16 link-local (cloud metadata!)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12 private
  if (a === 192 && b === 0 && octets[2] === 0) return false; // 192.0.0/24 special
  if (a === 192 && b === 0 && octets[2] === 2) return false; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 168) return false; // 192.168/16 private
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // 224/4 multicast + 240/4 reserved + broadcast
  return true;
}

/** Expand an IPv6 textual address to its 16 bytes; null when malformed. */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let head = ip;
  // Trailing dotted-quad (e.g. ::ffff:127.0.0.1) → two trailing groups.
  // Keep the colon(s) preceding the quad so `::`-compression survives.
  let v4Groups: string[] = [];
  const lastColon = head.lastIndexOf(':');
  if (lastColon !== -1 && head.includes('.', lastColon)) {
    const v4 = parseIPv4(head.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    v4Groups = [
      ((v4[0] << 8) | v4[1]).toString(16),
      ((v4[2] << 8) | v4[3]).toString(16),
    ];
    head = head.slice(0, lastColon + 1);
  }
  const sections = head.split('::');
  if (sections.length > 2) {
    return null;
  }
  const left = sections[0] ? sections[0].split(':').filter(Boolean) : [];
  const right = sections.length === 2 && sections[1] ? sections[1].split(':').filter(Boolean) : [];
  const groups =
    sections.length === 2
      ? [
          ...left,
          ...Array(Math.max(0, 8 - left.length - right.length - v4Groups.length)).fill('0'),
          ...right,
          ...v4Groups,
        ]
      : [...left, ...v4Groups];
  if (groups.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[index])) {
      return null;
    }
    const value = Number.parseInt(groups[index], 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function isPublicIPv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) {
    return false;
  }
  const allZeroThrough = (end: number) => bytes.slice(0, end).every((byte) => byte === 0);
  // :: (unspecified) and ::1 (loopback)
  if (allZeroThrough(15) && (bytes[15] === 0 || bytes[15] === 1)) return false;
  if (bytes[0] === 0xff) return false; // ff00::/8 multicast
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if ((bytes[0] & 0xfe) === 0xfc) return false; // fc00::/7 ULA
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return false; // 2001:db8::/32 documentation
  }
  const embeddedV4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  // ::ffff:a.b.c.d IPv4-mapped → vet the embedded IPv4
  if (allZeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIPv4(embeddedV4);
  }
  // ::a.b.c.d IPv4-compatible (deprecated) → vet the embedded IPv4
  if (allZeroThrough(12)) {
    return isPublicIPv4(embeddedV4);
  }
  // 64:ff9b::/96 NAT64 → vet the embedded IPv4
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return isPublicIPv4(embeddedV4);
  }
  return true;
}

export function isPublicAddress(ip: string, family: number): boolean {
  return family === 4 ? isPublicIPv4(ip) : family === 6 ? isPublicIPv6(ip) : false;
}

/* ----------------------------- the check ----------------------------- */

let inFlightChecks = 0;

/**
 * Validate + fetch a job-spec URI with the SSRF guards above.
 * @throws JobSpecCheckError with a safe, user-facing message.
 */
export async function checkJobSpec(rawUri: string): Promise<JobSpecCheckResult> {
  const { text: _text, ...result } = await runCheck(rawUri, false);
  return result;
}

/**
 * Like {@link checkJobSpec} but also returns the response body as UTF-8 text,
 * for spec-metadata resolution (listing-metadata.ts). Same SSRF guards, size
 * cap, and deadline; the 256 KiB cap keeps the buffering bounded.
 */
export async function fetchSpecBody(rawUri: string): Promise<SpecBodyResult> {
  const result = await runCheck(rawUri, true);
  return { ...result, text: result.text ?? '' };
}

async function runCheck(
  rawUri: string,
  captureBody: boolean,
): Promise<JobSpecCheckResult & { text?: string }> {
  if (inFlightChecks >= MAX_CONCURRENT_CHECKS) {
    throw new JobSpecCheckError('Too many concurrent job-spec checks; retry shortly');
  }
  if (!rawUri || rawUri.length > MAX_URI_LENGTH) {
    throw new JobSpecCheckError('uri is required and must be at most 2048 characters');
  }
  let url: URL;
  try {
    url = new URL(rawUri);
  } catch {
    throw new JobSpecCheckError('uri is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new JobSpecCheckError('Only https:// job-spec URIs are allowed');
  }
  if (url.port && url.port !== '443') {
    throw new JobSpecCheckError('Only the default https port (443) is allowed');
  }
  if (url.username || url.password) {
    throw new JobSpecCheckError('Credentials in the URI are not allowed');
  }

  // Resolve and vet EVERY address; pin the connection to one vetted address.
  const bareHost = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(bareHost);
  let pinned: { address: string; family: number };
  if (literalFamily) {
    if (!isPublicAddress(bareHost, literalFamily)) {
      throw new JobSpecCheckError('Job-spec host resolves to a non-public address');
    }
    pinned = { address: bareHost, family: literalFamily };
  } else {
    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(bareHost, { all: true, verbatim: true });
    } catch {
      throw new JobSpecCheckError('Job-spec host could not be resolved');
    }
    if (!resolved.length) {
      throw new JobSpecCheckError('Job-spec host could not be resolved');
    }
    for (const candidate of resolved) {
      if (!isPublicAddress(candidate.address, candidate.family)) {
        throw new JobSpecCheckError('Job-spec host resolves to a non-public address');
      }
    }
    pinned = resolved[0];
  }

  inFlightChecks += 1;
  try {
    return await fetchPinned(url, pinned, captureBody);
  } finally {
    inFlightChecks -= 1;
  }
}

function fetchPinned(
  url: URL,
  pinned: { address: string; family: number },
  captureBody: boolean,
): Promise<JobSpecCheckResult & { text?: string }> {
  return new Promise<JobSpecCheckResult & { text?: string }>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        action();
      }
    };

    const req = request(
      url,
      {
        method: 'GET',
        // Pin to the pre-vetted address: DNS is NOT consulted again, so a
        // rebinding host cannot swap in a private address after vetting.
        lookup: (_hostname, options, callback) => {
          if (options && (options as { all?: boolean }).all) {
            (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
              null,
              [pinned],
            );
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
        headers: { accept: '*/*', 'user-agent': 'agenc-indexer/jobspec-check' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          finish(() => reject(new JobSpecCheckError('Redirects are not followed for job-spec URIs; link the final https URL directly')));
          return;
        }
        if (status !== 200) {
          response.destroy();
          finish(() => reject(new JobSpecCheckError(`Upstream responded with status ${status}`)));
          return;
        }
        const declared = Number(response.headers['content-length'] ?? 0);
        if (declared > JOB_SPEC_MAX_BYTES) {
          response.destroy();
          finish(() => reject(new JobSpecCheckError('Job spec exceeds the 256 KiB limit')));
          return;
        }
        const hash = createHash('sha256');
        const bodyChunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > JOB_SPEC_MAX_BYTES) {
            response.destroy();
            req.destroy();
            finish(() => reject(new JobSpecCheckError('Job spec exceeds the 256 KiB limit')));
            return;
          }
          hash.update(chunk);
          if (captureBody) {
            bodyChunks.push(chunk);
          }
        });
        response.on('end', () => {
          const contentTypeHeader = response.headers['content-type'];
          finish(() =>
            resolve({
              sha256: hash.digest('hex'),
              bytes,
              contentType:
                typeof contentTypeHeader === 'string' ? contentTypeHeader : null,
              ...(captureBody
                ? { text: Buffer.concat(bodyChunks).toString('utf8') }
                : {}),
            }),
          );
        });
        response.on('error', () => {
          finish(() => reject(new JobSpecCheckError('Connection failed while reading the job spec')));
        });
      },
    );

    const deadline = setTimeout(() => {
      req.destroy();
      finish(() => reject(new JobSpecCheckError('Job-spec fetch timed out (5s limit)')));
    }, JOB_SPEC_TIMEOUT_MS);

    req.on('error', () => {
      finish(() => reject(new JobSpecCheckError('Connection to the job-spec host failed')));
    });
    req.end();
  });
}
