import { useState } from 'react';
import './profile-avatar.css';

/** Session presentation can only load this app's authenticated photo endpoint. */
function localPhotoUrl(value?: string | null) {
  return value && /^\/v1\/web\/profile-photo\/[A-Za-z0-9%_-]+\?v=[a-f0-9]{64}$/.test(value)
    ? value
    : undefined;
}

export function ProfileAvatar({ avatarUrl }: { avatarUrl?: string | null }) {
  const source = localPhotoUrl(avatarUrl);
  return <AvatarSource key={source ?? 'fallback'} source={source} />;
}

function AvatarSource({ source }: { source?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="profile-avatar" aria-hidden="true">
      {source && !failed ? (
        <img src={source} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
        </svg>
      )}
    </span>
  );
}
