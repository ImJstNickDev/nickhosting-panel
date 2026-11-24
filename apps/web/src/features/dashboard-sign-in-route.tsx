import { type LoaderFunctionArgs, redirect } from 'react-router';
import { api } from '../api/client.js';
import { isSignedOut } from '../app/session.js';
import { Loading } from '../components/ui.js';
import { dashboardSignIn } from './dashboard-sign-in.js';

export async function loader({ request }: LoaderFunctionArgs) {
  const target = dashboardSignIn(new URL(request.url).searchParams);
  if (!target) throw new Response(null, { status: 400 });
  let result: { redirectUrl: string };
  try {
    result = await api('/v1/web/openworld/dashboard/authorize', {
      body: { hostname: target.hostname, challenge: target.challenge },
      signal: request.signal,
    });
  } catch (error) {
    if (isSignedOut(error)) return redirect(`/login?${target.search}`);
    throw error;
  }
  const next = new URL(result.redirectUrl);
  if (
    next.origin !== `https://${target.hostname}` ||
    next.pathname !== '/.nickhosting/callback' ||
    next.username ||
    next.password ||
    next.hash ||
    !/^[A-Za-z0-9_-]{43}$/.test(next.searchParams.get('code') ?? '')
  )
    throw new Response(null, { status: 502 });
  window.location.replace(next.href);
  return null;
}

export { Loading as Component };
