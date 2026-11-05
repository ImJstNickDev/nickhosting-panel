import { DomainError, type DomainErrorCode } from '@nickhosting/core';

const nativeErrors: Record<string, DomainErrorCode> = {
  invalid_token: 'game_authentication_failed',
  token_validation_failed: 'game_authentication_failed',
  insufficient_scope: 'game_authentication_failed',
  wrong_password: 'game_authentication_failed',
  passwordless_login_not_possible: 'game_setup_conflict',
  server_claimed: 'game_setup_conflict',
  server_not_claimed: 'game_not_ready',
  server_unavailable: 'game_not_ready',
  no_game_running: 'game_not_ready',
  save_game_failed: 'game_save_failed',
  save_file_not_found: 'not_found',
  password_in_use: 'validation_failed',
  cannot_reset_admin_password: 'validation_failed',
  missing_params: 'validation_failed',
  invalid_params: 'validation_failed',
  unknown_function: 'game_request_unsupported',
  function_not_found: 'game_request_unsupported',
};

/** Never propagate the native message/data: they may echo credentials or commands. */
export function satisfactoryApiError(nativeCode: string): DomainError {
  const code = Object.hasOwn(nativeErrors, nativeCode) ? nativeErrors[nativeCode] : undefined;
  return code
    ? new DomainError(code, undefined, { nativeCode })
    : new DomainError('integration_unavailable', 503, { reason: 'satisfactory_api_failed' });
}
