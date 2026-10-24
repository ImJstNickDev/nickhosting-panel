import {
  createFilemanExtensionHost,
  type FilemanContext,
  type FilemanPathProvider,
  type FilemanSlotName,
  type TrustedFilemanExtension,
} from '@nickhosting/game-sdk/ui';
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

const emptyHost = createFilemanExtensionHost<ReactNode>([]);
const PathProvider = createContext<FilemanPathProvider | undefined>(undefined);
const RegisterPathProvider = createContext<
  ((provider: FilemanPathProvider) => () => void) | undefined
>(undefined);
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
  const [providers, setProviders] = useState<
    readonly { token: symbol; provider: FilemanPathProvider }[]
  >([]);
  const register = useCallback((provider: FilemanPathProvider) => {
    const token = Symbol();
    setProviders((current) => [...current, { token, provider }]);
    return () => setProviders((current) => current.filter((entry) => entry.token !== token));
  }, []);
  return (
    <Host.Provider value={value}>
      <RegisterPathProvider.Provider value={register}>
        <PathProvider.Provider value={providers.at(-1)?.provider}>{children}</PathProvider.Provider>
      </RegisterPathProvider.Provider>
    </Host.Provider>
  );
}

export function useFilemanPathProvider(): FilemanPathProvider | undefined {
  return useContext(PathProvider);
}

/** Scope changes preserve registration; unmount removes only this particular contribution. */
export function useRegisterFilemanPathProvider(provider: FilemanPathProvider | undefined) {
  const register = useContext(RegisterPathProvider);
  useLayoutEffect(() => {
    if (provider && register) return register(provider);
  }, [provider, register]);
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
