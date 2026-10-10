export function parseDevPreparationArgs(args: string[]): { ownerApproved: true; publicUrl: string };
export function prepareDevelopmentEnvironment(options: {
  root: string;
  ownerApproved: boolean;
  publicUrl: string;
}): Promise<{ envPath: string; devRoot: string; uid: number; gid: number }>;
