import os from 'node:os';
import ipaddr from 'ipaddr.js';

export function isPrivateIPv4(address) {
  if (!ipaddr.IPv4.isValid(address)) return false;
  return ['private', 'linkLocal'].includes(ipaddr.parse(address).range());
}

export function localInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses || []).filter(a => a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address))
      .map(a => ({ name, address: a.address, cidr: a.cidr })))
    .sort((a, b) => Number(/docker|veth|br-|virbr|vmnet|tun|tap|wsl/i.test(a.name)) - Number(/docker|veth|br-|virbr|vmnet|tun|tap|wsl/i.test(b.name)));
}

export function normalizeIP(address) {
  try { return ipaddr.process(address).toString(); } catch { return ''; }
}

export function isLoopback(address) {
  try { return ipaddr.process(address).range() === 'loopback'; } catch { return false; }
}

export function allowPeer(address, interfaces) {
  if (isLoopback(address)) return true;
  const normalized = normalizeIP(address);
  if (!isPrivateIPv4(normalized)) return false;
  return interfaces.some(({ cidr }) => {
    try { return ipaddr.parse(normalized).match(ipaddr.parseCIDR(cidr)); } catch { return false; }
  });
}
