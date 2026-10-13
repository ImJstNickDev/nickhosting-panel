import {
  createFilemanExtensionHost,
  type FilemanContext,
  type FilemanSlotName,
  type TrustedFilemanExtension,
} from '@nickhosting/game-sdk/ui';
import { createContext, Fragment, type ReactNode, useContext, useMemo } from 'react';

const emptyHost = createFilemanExtensionHost<ReactNode>([]);
const Host = createContext<{
  host: ReturnType<typeof createFilemanExtensionHost<ReactNode>>;
  context: Readonly<FilemanContext>;
} | null>(null);

/** Presentation only: existing controllers remain the sole owners of I/O and authorization. */
export function FilemanHost({
  context,
  extensions,
  children,
}: {
  context: Readonly<FilemanContext>;
  extensions?: readonly TrustedFilemanExtension<ReactNode>[];
  children?: ReactNode;
}) {
  const host = useMemo(
    () => (extensions ? createFilemanExtensionHost(extensions) : emptyHost),
    [extensions],
  );
  const value = useMemo(() => ({ host, context }), [host, context]);
  return <Host.Provider value={value}>{children}</Host.Provider>;
}

/** Scoped patches apply to real folders and virtual folders through the same components. */
export function FilemanSlot({
  name,
  context,
  children,
}: {
  name: FilemanSlotName;
  context?: Partial<FilemanContext>;
  children?: ReactNode;
}) {
  const parent = useContext(Host);
  if (!parent) return children;
  return parent.host.render(name, { ...parent.context, ...context }, children, (parts) => (
    <>
      <Fragment key="before">{parts[0]}</Fragment>
      <Fragment key="after">{parts[1]}</Fragment>
    </>
  ));
}

/** Viewers retain the host registry while narrowing presentation context for their subtree. */
export function FilemanScope({
  context,
  children,
}: {
  context: Partial<FilemanContext>;
  children?: ReactNode;
}) {
  const parent = useContext(Host);
  const value = useMemo(
    () => (parent ? { host: parent.host, context: { ...parent.context, ...context } } : null),
    [parent, context],
  );
  return <Host.Provider value={value}>{children}</Host.Provider>;
}
