import { createHash } from 'node:crypto';

export const openworldLauncherFile = '.nickhosting-openworld-launch.py';
export const openworldTransientConfig = '.nickhosting-openworld-config.json';

// The game anchors *all* relative data (including its identity) at the path used
// for --config. A link in the instance root keeps that contract. Its target is
// anonymous memory belonging only to the game process, never a file in its volume.
export const openworldLauncherSource = `import json
import os
import pathlib
import secrets

root = pathlib.Path.cwd()
base = root / "server.json"
link = root / ".nickhosting-openworld-config.json"
password = os.environ.pop("OW_WEB_PASSWORD", "")
game_port = int(os.environ["SERVER_PORT"])
web_port = int(os.environ["OW_WEB_PORT"])
if not (0 < game_port < 65536 and 0 < web_port < 65536 and game_port != web_port):
    raise SystemExit("Invalid allocated Openworld ports")

args = ["./openworld-server", "--port", str(game_port)]
if base.exists() or password:
    if not base.exists():
        with base.open("x", encoding="utf-8") as document:
            document.write("{}\\n")
    with base.open("rb") as document:
        raw = document.read(1048577)
    if len(raw) > 1048576:
        raise SystemExit("Openworld configuration is too large")
    settings = json.loads(raw)
    if not isinstance(settings, dict):
        raise SystemExit("Invalid Openworld configuration")
    settings["web"] = {
        "enabled": bool(password), "host": "0.0.0.0", "port": web_port, "password": password
    }
    fd = os.memfd_create("openworld-config", flags=0)
    with os.fdopen(os.dup(fd), "w", encoding="utf-8") as document:
        json.dump(settings, document)
    os.lseek(fd, 0, os.SEEK_SET)
    os.set_inheritable(fd, True)
    temporary = root / (".openworld-config-" + secrets.token_hex(12))
    temporary.symlink_to("/proc/self/fd/" + str(fd))
    os.replace(temporary, link)
    args.extend(["--config", str(link)])
os.execv(args[0], args)
`;

const digest = createHash('sha256').update(openworldLauncherSource).digest('hex');
// Hash and run the same bytes: a File Manager edit cannot replace the helper
// between verification and execution. Isolated mode ignores tenant Python paths.
export const openworldStartup = `/usr/bin/python3 -I -c "import hashlib,sys; p='${openworldLauncherFile}'; s=open(p,'rb').read(65536); sys.exit('Invalid Openworld launcher') if hashlib.sha256(s).hexdigest()!='${digest}' else exec(compile(s,p,'exec'))"`;
