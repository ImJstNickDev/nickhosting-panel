export function parseDevPreparationArgs(args: string[]): { ownerApproved: true; publicUrl: string };
export function prepareDevelopmentEnvironment(options: {
  root: string;
  ownerApproved: boolean;
  publicUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ envPath: string; devRoot: string; uid: number; gid: number }>;
