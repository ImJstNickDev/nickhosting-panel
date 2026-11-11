export const isPrivateKeyName = (name: string) => /(?:private|privkey|\.key$)/i.test(name);
export const isCrashContextName = (name: string) => /^CrashContext\.runtime-xml$/i.test(name);
export const isCertificateName = (name: string) =>
  !isPrivateKeyName(name) && /\.(?:pem|crt|cer)$/i.test(name);
