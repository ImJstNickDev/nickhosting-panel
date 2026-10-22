import { minecraftUiModule } from '@nickhosting/minecraft/ui';

export function MinecraftPlayerAvatar({
  name,
  uuid,
  avatar,
  className,
}: {
  name: string;
  uuid?: string;
  avatar?: string;
  className?: string;
}) {
  const appearance = minecraftUiModule.playerAppearance;
  const source = avatar ?? (uuid ? appearance?.avatarUrl(uuid) : undefined) ?? appearance?.fallback;
  return (
    <img
      className={`minecraft-player-avatar${className ? ` ${className}` : ''}`}
      src={source}
      alt=""
      width="36"
      height="36"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(event) => {
        if (appearance?.fallback && event.currentTarget.src !== appearance.fallback)
          event.currentTarget.src = appearance.fallback;
      }}
      data-player={name}
    />
  );
}
