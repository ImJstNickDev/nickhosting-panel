import type { GameViewerProps } from '@nickhosting/game-sdk/ui';
import { useEffect, useState } from 'react';
import { isCrashContextName, isPrivateKeyName } from './diagnostic-names.js';
import {
  type CertificateMetadata,
  type DiagnosticField,
  diagnosticReadLimit,
  parseCertificates,
  parseCrashContext,
} from './diagnostic-parser.js';
import './diagnostic-viewer.css';

const key = (name: string) => `games.satisfactory.viewers.diagnostic.${name}`;
export default function DiagnosticViewer({ source, host }: GameViewerProps) {
  const [state, setState] = useState<{
    crash?: DiagnosticField[];
    certificates?: CertificateMetadata[];
    error?: string;
  }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    if (isPrivateKeyName(source.name)) setState({ error: key('privateKey') });
    else if (source.size >= diagnosticReadLimit) setState({ error: key('tooLarge') });
    else if (!host.readPrefix) setState({ error: key('unavailable') });
    else
      void host
        .readPrefix(diagnosticReadLimit, controller.signal)
        .then(async (bytes) => {
          const next = isCrashContextName(source.name)
            ? { crash: parseCrashContext(bytes) }
            : { certificates: await parseCertificates(bytes) };
          if (!controller.signal.aborted) setState(next);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              error:
                error &&
                typeof error === 'object' &&
                'messageKey' in error &&
                typeof error.messageKey === 'string'
                  ? error.messageKey
                  : key(
                      error instanceof Error && ['privateKey', 'tooLarge'].includes(error.message)
                        ? error.message
                        : 'unavailable',
                    ),
            });
        });
    return () => controller.abort();
  }, [host, source.name, source.size]);
  const field = (name: string, value: string) => (
    <div key={name}>
      <dt>{host.t(key(name))}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <div className="satisfactory-diagnostic-viewer">
      {state.error ? (
        <p role="alert">{host.t(state.error)}</p>
      ) : state.crash ? (
        state.crash.length ? (
          <dl>{state.crash.map((row) => field(row.key, row.value))}</dl>
        ) : (
          <p>{host.t(key('empty'))}</p>
        )
      ) : state.certificates ? (
        state.certificates.map((cert, index) => (
          <section
            // biome-ignore lint/suspicious/noArrayIndexKey: immutable ordered chain may contain duplicate certificates.
            key={`${index}-${cert.fingerprint}`}
            aria-label={host.t(key('certificateNumber'), { number: index + 1 })}
          >
            <h3>{host.t(key('certificateNumber'), { number: index + 1 })}</h3>
            <dl>
              {Object.entries(cert).map(([name, value]) =>
                field(
                  name,
                  name === 'notBefore' || name === 'notAfter'
                    ? new Intl.DateTimeFormat(host.locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(value))
                    : value,
                ),
              )}
            </dl>
          </section>
        ))
      ) : (
        <p role="status">{host.t(key('loading'))}</p>
      )}
    </div>
  );
}
