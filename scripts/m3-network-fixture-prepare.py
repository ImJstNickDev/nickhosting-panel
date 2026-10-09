#!/usr/bin/env python3
"""Prepare a private reviewable fixture env. No Docker/network mutation or bind."""
import ipaddress
import json
import os
from pathlib import Path
import secrets
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / '.env.m3-network.local'
PROJECT = 'nickhosting-m3-network-tests'


def command(*args):
    return subprocess.check_output(args, text=True, timeout=20).strip()


if ENV.exists():
    raise SystemExit('Existing fixture environment preserved; review it rather than overwriting.')
if command('docker', 'container', 'ls', '--all', '--filter', f'label=com.docker.compose.project={PROJECT}', '--format', '{{.ID}}'):
    raise SystemExit('Existing project containers require provenance review.')
if command('docker', 'network', 'ls', '--filter', f'name=^{PROJECT}$', '--format', '{{.ID}}'):
    raise SystemExit('Existing project network requires provenance review.')
existing = []
network_ids = command('docker', 'network', 'ls', '--no-trunc', '--format', '{{.ID}}').splitlines()
if network_ids:
    raw = command('docker', 'network', 'inspect', '--format', '{{json .IPAM.Config}}', *network_ids)
    for line in raw.splitlines():
        for item in json.loads(line) or []:
            if item.get('Subnet'):
                existing.append(ipaddress.ip_network(item['Subnet'], strict=False))
for route in json.loads(command('ip', '-j', '-4', 'route', 'show', 'table', 'all')):
    if route.get('dst', 'default') != 'default':
        existing.append(ipaddress.ip_network(route['dst'], strict=False))
selected = None
for third in range(254, 0, -1):
    candidate = ipaddress.ip_network(f'10.254.{third}.0/28')
    if not any(candidate.overlaps(network) for network in existing if network.version == 4):
        selected = candidate
        break
if selected is None:
    raise SystemExit('No disjoint fixture subnet found; obtain an Owner decision.')
used_ports = set()
for table in ['tcp', 'tcp6', 'udp', 'udp6']:
    for row in Path('/proc/net', table).read_text().splitlines()[1:]:
        used_ports.add(int(row.split()[1].split(':')[-1], 16))
container_ids = command('docker', 'container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}').splitlines()
if container_ids:
    raw = command('docker', 'container', 'inspect', '--format', '{"configured":{{json .HostConfig.PortBindings}},"active":{{json .NetworkSettings.Ports}}}', *container_ids)
    for line in raw.splitlines():
        for mappings in json.loads(line).values():
            for bindings in (mappings or {}).values():
                for binding in bindings or []:
                    if binding['HostPort'].isdigit():
                        used_ports.add(int(binding['HostPort']))
ports = []
while len(ports) < 3:
    port = secrets.randbelow(16384) + 49152
    if port not in used_ports and port not in ports:
        ports.append(port)
fixture_uuid = str(uuid.uuid4())
if command('docker', 'container', 'ls', '--all', '--filter', f'name=^/{fixture_uuid}$', '--format', '{{.ID}}'):
    raise SystemExit('Fixture UUID unexpectedly exists; stop for review.')
values = {
    'NH_M3_SUBNET': str(selected), 'NH_M3_BACKEND_IP': str(selected.network_address + 1),
    'NH_M3_GAME_PORT': str(ports[0]), 'NH_M3_QUERY_PORT': str(ports[1]), 'NH_M3_NODE_PROBE_PORT': str(ports[2]),
    'NH_M3_FIXTURE_UUID': fixture_uuid, 'NH_M3_GATEWAY_BIND': '127.0.0.1',
    'NH_M3_EXPECTED_NAMESPACE': os.readlink('/proc/self/ns/net'),
    'NH_M3_DOCKER_DAEMON_ID': json.loads(command('docker', 'info', '--format', '{{json .ID}}')),
}
fd = os.open(ENV, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    output.write('# Local fixture proposal only; no infrastructure has been created.\n')
    for name, value in values.items():
        output.write(f'{name}={value}\n')
print('Prepared ignored .env.m3-network.local after read-only subnet/route/socket/Docker checks.')
print('No Docker objects or listeners created. Final provider inventory and topology recheck remain required.')
