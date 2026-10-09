import { describe, expect, it } from 'vitest';
import { assertMinecraftDeclaredEnvironment } from './minecraft-registry.js';
import {
  assertMinecraftFabricLaunch,
  assertMinecraftJavaLaunch,
} from './minecraft-runtime-evidence.js';

const environment = { SERVER_MEMORY: '1024', SERVER_JARFILE: 'server.jar' };
const startup =
  'java -Xms128M -Xmx{{SERVER_MEMORY}}M -XX:+UseG1GC -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}} nogui';
describe('attested Fabric launch shape', () => {
  it('accepts the verified launcher and ordinary heap/GC/terminal settings', () => {
    expect(() => assertMinecraftFabricLaunch(startup, environment, 'server.jar')).not.toThrow();
  });
  it.each([
    '-Dfabric.gameJarPath=another.jar',
    '-Dfabric.gameJarPath.server=another.jar',
    '-Dfabric.development=true',
    '-Djava.system.class.loader=other.Loader',
    '-cp other.jar',
    '-javaagent:other.jar',
    '-agentlib:other',
    '-agentpath:/other',
    '@user_jvm_args.txt',
    '-XX:Flags=123',
    '-XX:OnError=123',
    '--patch-module=java.base=other.jar',
    '-Xbootclasspath/a:other.jar',
  ])('rejects executable override %s', (option) => {
    expect(() =>
      assertMinecraftFabricLaunch(`java ${option} -jar server.jar`, environment, 'server.jar'),
    ).toThrow('configuration_invalid');
  });
  it.each([
    'JDK_JAVA_OPTIONS',
    'JAVA_TOOL_OPTIONS',
    '_JAVA_OPTIONS',
    'CLASSPATH',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'PATH',
    'BASH_ENV',
    'ENV',
    'LD_AUDIT',
    'JAVA_HOME',
    'IFS',
  ])('rejects implicit JVM environment %s', (name) => {
    expect(() =>
      assertMinecraftFabricLaunch(
        startup,
        { ...environment, [name]: '-Dfabric.gameJarPath=other.jar' },
        'server.jar',
      ),
    ).toThrow('configuration_invalid');
  });
  it.each([
    'java -jar other.jar',
    'sh -c java -jar server.jar',
    'java -jar server.jar; other',
    'java -jar server.jar | other',
    'java -jar {{UNKNOWN}}',
    'java -jar server.jar\nother',
    'java -jar server.jar $(other)',
  ])('fails closed for unsupported startup %s', (command) => {
    expect(() => assertMinecraftFabricLaunch(command, environment, 'server.jar')).toThrow(
      'configuration_invalid',
    );
  });
});

describe('frozen complete Minecraft egg environment', () => {
  it('requires the exact actual set with every default captured explicitly', () => {
    expect(() =>
      assertMinecraftDeclaredEnvironment(['VERSION', 'FLAGS'], ['VERSION', 'FLAGS'], {
        VERSION: '1.21.1',
        FLAGS: '',
      }),
    ).not.toThrow();
    expect(() =>
      assertMinecraftDeclaredEnvironment(['VERSION'], ['VERSION', 'FLAGS'], { VERSION: '1.21.1' }),
    ).toThrow('configuration_invalid');
    expect(() =>
      assertMinecraftDeclaredEnvironment(['VERSION', 'FLAGS'], ['VERSION', 'FLAGS'], {
        VERSION: '1.21.1',
      }),
    ).toThrow('configuration_invalid');
    expect(() =>
      assertMinecraftDeclaredEnvironment(['VERSION'], ['VERSION'], {
        VERSION: '1.21.1',
        JDK_JAVA_OPTIONS: 'bad',
      }),
    ).toThrow('configuration_invalid');
  });
  it('permits only explicit assigned port placeholders before allocation', () => {
    expect(() =>
      assertMinecraftDeclaredEnvironment(
        ['VERSION', 'PORT'],
        ['VERSION', 'PORT'],
        { VERSION: '1.21.1' },
        ['PORT'],
      ),
    ).not.toThrow();
    expect(() =>
      assertMinecraftDeclaredEnvironment(['VERSION'], ['VERSION'], { VERSION: '1.21.1' }, ['PORT']),
    ).toThrow('configuration_invalid');
  });
});
describe('verified Forge argument file launch', () => {
  const path = 'libraries/net/minecraftforge/forge/1.21.4-54.1.16/unix_args.txt';
  const target = { kind: 'forge' as const, paths: [path] };
  it('accepts the exact verified installer output with ordinary heap settings', () => {
    expect(() =>
      assertMinecraftJavaLaunch(
        `java -Xms128M -XX:MaxRAMPercentage=95.0 @${path} nogui`,
        {},
        target,
      ),
    ).not.toThrow();
  });
  it.each([
    'java @unix_args.txt nogui',
    `java @user_jvm_args.txt @${path} nogui`,
    `sh -c java @${path}`,
    `java @${path} @other.txt`,
    'java -jar server.jar',
  ])('rejects unverified indirection %s', (startup) => {
    expect(() => assertMinecraftJavaLaunch(startup, {}, target)).toThrow('configuration_invalid');
  });
});
