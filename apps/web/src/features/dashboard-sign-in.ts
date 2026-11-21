const dnsHostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function dashboardSignIn(params: URLSearchParams) {
  const hostname = params.get('hostname') ?? '';
  const challenge = params.get('challenge') ?? '';
  if (
    params.getAll('hostname').length !== 1 ||
    params.getAll('challenge').length !== 1 ||
    hostname.length > 253 ||
    !dnsHostname.test(hostname) ||
    !/^[a-f0-9]{64}$/.test(challenge)
  )
    return;
  const search = new URLSearchParams({ hostname, challenge }).toString();
  return { hostname, challenge, search, path: `/dashboard/authorize?${search}` };
}
