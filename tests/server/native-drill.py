#!/usr/bin/env python3
"""Linux-only real packed helper + PM2 cluster/TLS/Unix-peer acceptance.

Run inside the pinned network-isolated Node image; /source is read-only, and
/evidence belongs only to this retained fixture. No production endpoints exist.
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import struct
import subprocess
import tarfile
import threading
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument('--artifact', type=Path, required=True)
p.add_argument('--artifact-sha256', required=True)
p.add_argument('--wait-observer', action='store_true')
a = p.parse_args()
assert os.geteuid() == 0 and Path('/source/tests/server/fixtures/pm2-worker.cjs').is_file()
assert hashlib.sha256(a.artifact.read_bytes()).hexdigest() == a.artifact_sha256
root = Path('/fixture'); root.mkdir(exist_ok=True); root.chmod(0o700)
export = Path('/evidence'); export.mkdir(exist_ok=True)
control = root / 'control'; control.mkdir(mode=0o700)
fixture = root / 'runtime'; fixture.mkdir(mode=0o700)
package = fixture / 'node_modules/csar-ts'; package.mkdir(parents=True)
with tarfile.open(a.artifact) as archive:
    for member in archive.getmembers():
        assert member.name.startswith('package/') and '..' not in Path(member.name).parts and member.isfile()
        target = package / member.name.removeprefix('package/')
        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(archive.extractfile(member).read())
worker = fixture / 'worker.cjs'; worker.write_bytes(Path('/source/tests/server/fixtures/pm2-worker.cjs').read_bytes())
worker_sha = hashlib.sha256(worker.read_bytes()).hexdigest()
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'key.pem'),'-out',str(root/'ca.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.chmod(root/'key.pem',0o600)
env = dict(os.environ, PM2_HOME=str(root/'pm2'), NODE_PATH='/source/node_modules', NO_COLOR='1')
cli = ['node','/source/node_modules/pm2/bin/pm2']
def pm2(*args):
    value = subprocess.run(cli+list(args), env=env, capture_output=True, text=True, timeout=30)
    assert value.returncode == 0, 'isolated PM2 operation refused'
    return value.stdout

def ask(path, command):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(3); connection.connect(str(path))
        pid,uid,gid = struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        connection.sendall((json.dumps(command)+'\n').encode()); result=b''
        while not result.endswith(b'\n'):
            chunk=connection.recv(4096); assert chunk; result+=chunk; assert len(result)<=16384
    return json.loads(result),dict(pid=pid,uid=uid,gid=gid)

def statuses():
    rows=[]
    for path in sorted(control.glob('*.sock')):
        status,peer=ask(path,dict(v=1,command='status'))
        assert status['pid']==peer['pid'] and status['uid']==peer['uid']==0
        assert status['entry_sha256']==worker_sha and status['linux_start_ticks'].isdigit()
        stat=Path('/proc/'+str(peer['pid'])+'/stat').read_text()
        assert stat[stat.rfind(')')+2:].split()[19]==status['linux_start_ticks']
        assert path.stat().st_mode & 0o777 == 0o600
        assert len(status['servers'])==1 and not status['counters_saturated']
        rows.append(dict(socket=str(path),status=status,peer=peer))
    return rows

def wait(check, timeout=20):
    deadline=time.monotonic()+timeout
    while not check():
        assert time.monotonic()<deadline,'native fixture condition timed out'
        time.sleep(.05)

received=threading.Event(); release=threading.Event(); calls=[]
class Mock(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        assert self.path=='/wb-mutation'
        calls.append(time.monotonic()); received.set()
        assert release.wait(30),'outbound mutation fixture was not released'
        self.send_response(200); self.end_headers(); self.wfile.write(b'completed')
    def log_message(self,*args): pass
mock=http.server.ThreadingHTTPServer(('127.0.0.1',18444),Mock)
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(root/'ca.pem',root/'key.pem');mock.socket=ctx.wrap_socket(mock.socket,server_side=True)
threading.Thread(target=mock.serve_forever,daemon=True).start()
epoch='native-helper-window-0001'
try:
    pm2('start',str(worker),'--name','csar-http-helper-fixture','-i','2','--no-autorestart','--silent')
    wait(lambda:len(statuses())==2)
    initial=statuses(); assert all(r['status']['phase']=='serving' for r in initial)
    # Wait until both worker business listeners are bound, not merely control-ready.
    wait(lambda:all(r['status']['servers'][0]['listening'] for r in statuses()))
    clientctx=ssl.create_default_context(cafile=root/'ca.pem')
    with urllib.request.urlopen('https://localhost:18443/held',context=clientctx,timeout=5) as response:
        held_pid=int(response.read())
    assert received.wait(5)
    incomplete=[]
    for row in initial:
        result,peer=ask(row['socket'],dict(v=1,command='drain',epoch=epoch,timeout_ms=40))
        if not result['complete']: incomplete.append(peer['pid'])
    assert incomplete==[held_pid], 'response finish concealed or fabricated handler completion'
    assert {r['status']['pid'] for r in statuses()}=={r['status']['pid'] for r in initial},'drain replaced/killed a worker'
    release.set()
    wait(lambda:all(r['status']['phase']=='drained' for r in statuses()))
    final=statuses()
    assert len(calls)==1
    for row in final:
        s=row['status']; assert s['epoch']==epoch and s['admission_closed']
        assert all(s[k]==0 for k in ('active_requests','active_handlers','active_tasks'))
        assert all(v==0 for v in s['epoch_failures'].values())
        assert s['servers']==[dict(listening=False,closed=True,error=False)]
    master=int((root/'pm2/pm2.pid').read_text())
    assert all(r['peer']['pid']!=master for r in final), 'PM2 master accepted worker control socket'
    proof=dict(status='passed',image=os.environ.get('FIXTURE_IMAGE'),node=subprocess.check_output(['node','--version'],text=True).strip(),pm2='6.0.14',artifact_sha256=a.artifact_sha256,worker_sha256=worker_sha,epoch=epoch,pm2_master=master,workers=final,real_tls_outbound_mutation_calls=len(calls),response_finish_not_completion=True,actual_unix_peer_matches=True,actual_packed_helper=True,production_mutations=False)
    (export/'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
    print(json.dumps({k:v for k,v in proof.items() if k!='workers'}),flush=True)
    if a.wait_observer:
        (export/'observer-ready.json').write_text(json.dumps(proof,indent=2)+'\n')
        wait(lambda:(export/'observer.done').exists(),timeout=300)
finally:
    release.set(); mock.shutdown()
    pm2('kill')
