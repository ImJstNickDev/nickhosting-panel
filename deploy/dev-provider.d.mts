import type { RequestListener, Server } from 'node:http';

export function createDevProviderHandler(token: string): RequestListener;
export function createDevProviderServer(token: string): Server;
export function stopDevProviderServer(server: Server): Promise<void>;
