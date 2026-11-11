#!/usr/bin/env node
// 一键唤醒局域网 OCR 笔记本（wangw@192.168.2.35，RTX 4070）。
// WoL 只对睡眠生效；关机/深度休眠需物理开机。启用脚本在笔记本 C:\Users\wangw\ppseg\enable_wol.ps1。
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';

const MAC = '1c:83:41:d0:59:f0';
const IP = '192.168.2.35';
const BROADCAST = '192.168.2.255';
const PORTS = [9, 7];
const WAIT_SECONDS = 90;

const macBytes = MAC.split(':').map((h) => parseInt(h, 16));
const packet = Buffer.alloc(6 + 16 * 6);
packet.fill(0xff, 0, 6);
for (let i = 0; i < 16; i++) packet.set(macBytes, 6 + i * 6);

const sock = dgram.createSocket('udp4');
await new Promise((resolve, reject) => {
  sock.once('error', reject);
  sock.bind(() => {
    sock.setBroadcast(true);
    resolve();
  });
});
for (const port of PORTS) {
  for (const addr of [BROADCAST, IP]) {
    sock.send(packet, port, addr);
  }
}
sock.close();
console.log(`魔术包已发：MAC ${MAC} → ${BROADCAST}:${PORTS.join('/')} + ${IP} 直发`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + WAIT_SECONDS * 1000;
let up = false;
while (Date.now() < deadline) {
  try {
    execFileSync('ping', ['-c', '1', '-t', '2', IP], { stdio: 'ignore' });
    up = true;
    break;
  } catch {
    await sleep(2000);
  }
}
if (up) {
  console.log(`✓ ${IP} 已可达，SSH 入口：ssh laptop`);
} else {
  console.log(`✗ ${WAIT_SECONDS}s 内 ping 不通：可能已关机/休眠过深，或 WoL 未生效（检查笔记本电源与网卡设置）`);
}
process.exit(up ? 0 : 1);