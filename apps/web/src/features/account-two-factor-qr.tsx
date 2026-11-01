import { QRCodeSVG } from 'qrcode.react';

/** Local encoding only: the enrollment URI never leaves the application. */
export function AuthenticatorQr({ uri, title }: { uri: string; title: string }) {
  return (
    <QRCodeSVG
      value={uri}
      size={192}
      level="M"
      marginSize={4}
      title={title}
      role="img"
      aria-label={title}
    />
  );
}
