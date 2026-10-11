"""In-memory PHP tests using existing vendor libraries; never boot Panel or connect its DB."""
import base64
from pathlib import Path
import subprocess
import argparse
root = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--container', required=True)
args=parser.parse_args()
sources=[]
for path in sorted((root/'app').rglob('*.php')):
    # CapabilitiesRequest depends on Panel autoload and is safe to define, never instantiate.
    sources.append("eval(base64_decode('"+base64.b64encode(path.read_bytes().replace(b'{identifier}',b'nickhosting').removeprefix(b'<?php')).decode()+"'));")
sources.append("eval(base64_decode('"+base64.b64encode((root/'admin/controller.php').read_bytes().replace(b'{identifier}',b'nickhosting').removeprefix(b'<?php')).decode()+"'));")
migration=root/'private/migrations/2026_10_11_000001_nickhosting_bridge.php'
script="<?php require '/app/vendor/autoload.php';\n"+'\n'.join(sources)
script+="\n$schemaMigration=eval(base64_decode('"+base64.b64encode(migration.read_bytes().removeprefix(b'<?php')).decode()+"'));\n"
script+="\ndefine('NICKHOSTING_TEST_CONFIGURE', true); eval(base64_decode('"+base64.b64encode((root/'private/configure.php').read_bytes().removeprefix(b'<?php')).decode()+"'));\n"
script+="\n$settingsView=base64_decode('"+base64.b64encode((root/'admin/view.blade.php').read_bytes()).decode()+"');\n"
script+=(root/'tests/php_harness.php').read_text().removeprefix('<?php')
subprocess.run(['docker','exec','-i',args.container,'php'],input=script,text=True,check=True)
