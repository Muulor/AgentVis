import type { NetworkDirectTarget } from '@/types/networkDirectAuthorization';

export type NetworkDirectTargetRisk = 'public' | 'private' | 'metadata' | 'unknown';
type Ipv4Octets = [number, number, number, number];

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
}

function parseIpv4(host: string): Ipv4Octets | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  const [first, second, third, fourth] = octets;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return null;
  }
  return [first, second, third, fourth];
}

function isMetadataIpv4(octets: Ipv4Octets): boolean {
  return (
    (octets[0] === 169 && octets[1] === 254 && octets[2] === 169 && octets[3] === 254) ||
    (octets[0] === 169 && octets[1] === 254 && octets[2] === 170 && octets[3] === 2) ||
    (octets[0] === 100 && octets[1] === 100 && octets[2] === 100 && octets[3] === 200)
  );
}

function isPrivateOrLocalIpv4(octets: Ipv4Octets): boolean {
  return (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    octets[0] >= 224
  );
}

function isPrivateOrLocalIpv6(host: string): boolean {
  return (
    host === '::' ||
    host === '::1' ||
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  );
}

export function classifyNetworkDirectTarget(target: NetworkDirectTarget): NetworkDirectTargetRisk {
  if (target.resolvedRisk) {
    return target.resolvedRisk;
  }

  const host = normalizeHost(target.host);
  if (
    host === 'metadata' ||
    host === 'metadata.google.internal' ||
    host === 'metadata.azure.internal' ||
    host === 'metadata.aliyuncs.com'
  ) {
    return 'metadata';
  }

  const mappedIpv4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  const ipv4 = parseIpv4(mappedIpv4);
  if (ipv4) {
    if (isMetadataIpv4(ipv4)) return 'metadata';
    return isPrivateOrLocalIpv4(ipv4) ? 'private' : 'public';
  }

  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateOrLocalIpv6(host)) {
    return 'private';
  }

  return 'public';
}

export function hasMetadataNetworkDirectTarget(targets: NetworkDirectTarget[]): boolean {
  return targets.some((target) => classifyNetworkDirectTarget(target) === 'metadata');
}

export function hasPrivateNetworkDirectTarget(targets: NetworkDirectTarget[]): boolean {
  return targets.some((target) => classifyNetworkDirectTarget(target) === 'private');
}
