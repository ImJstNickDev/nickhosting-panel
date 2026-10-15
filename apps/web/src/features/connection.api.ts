export type ConnectionOptions = {
  mode: string;
  customizable: boolean;
  domains: { id: string; hostname: string }[];
  defaultDomainId: string | null;
  defaultHostname: string | null;
  supportsSrv: boolean;
  configured: boolean;
};
export type ConnectionChoice = { domainId?: string; subdomain?: string };

/** Prefer stored domain identity; overlapping DNS suffixes must not alter the editable label. */
export function assignmentConnectionChoice(
  assignment: { domainId?: string; shared?: boolean; connection: { hostname: string } } | undefined,
  options: ConnectionOptions,
): ConnectionChoice {
  if (!assignment) return {};
  const hostname = assignment.connection.hostname;
  const domain =
    options.domains.find((entry) => entry.id === assignment.domainId) ??
    [...options.domains]
      .sort((a, b) => b.hostname.length - a.hostname.length)
      .find((entry) => hostname.endsWith(`.${entry.hostname}`));
  if (!domain) return {};
  if (assignment.shared || (options.mode === 'shared-host' && hostname === options.defaultHostname))
    return { domainId: domain.id };
  return {
    domainId: domain.id,
    ...(hostname.endsWith(`.${domain.hostname}`)
      ? { subdomain: hostname.slice(0, -(domain.hostname.length + 1)) }
      : {}),
  };
}

/** Static endpoints are already configured by the Owner and do not accept DNS requests. */
export function creationConnectionChoice(
  options: ConnectionOptions | undefined,
  choice: ConnectionChoice,
) {
  return options?.configured && options.mode !== 'static-host-port' ? choice : undefined;
}
