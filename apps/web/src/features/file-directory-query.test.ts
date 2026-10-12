import { afterEach, expect, it } from 'vitest';
import { queryClient } from '../api/client.js';
import { fileDirectoryQuery } from './service-contracts.js';

afterEach(() => queryClient.clear());

it('isolates directory data when the session identity changes without a local sign-in action', () => {
  const context = {
    actorUserId: 'actor',
    subjectUserId: 'first-user',
    sessionType: 'regular',
  };
  queryClient.setQueryData(['session'], { context });
  const first = fileDirectoryQuery('server', 'world').queryKey;
  queryClient.setQueryData(first, [{ name: 'first-user.txt' }]);
  expect(fileDirectoryQuery('server', 'world').queryKey).toEqual(first);
  for (const next of [
    { ...context, subjectUserId: 'second-user' },
    { ...context, actorUserId: 'second-actor' },
    { ...context, sessionType: 'support', support: { id: 'assistance' } },
  ]) {
    queryClient.setQueryData(['session'], { context: next });
    const key = fileDirectoryQuery('server', 'world').queryKey;
    expect(key.slice(0, 3)).toEqual(['files', 'server', 'world']);
    expect(queryClient.getQueryData(key)).toBeUndefined();
  }
  queryClient.removeQueries({ queryKey: ['session'] });
  expect(queryClient.getQueryData(fileDirectoryQuery('server', 'world').queryKey)).toBeUndefined();
});
