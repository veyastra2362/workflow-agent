import { describe, expect, it } from 'vitest';
import { isBlockedIp } from '../../src/tools/web/guarded-fetch';

describe('SSRF：IP 段阻止矩阵（isBlockedIp）', () => {
  const blockedV4 = [
    '127.0.0.1',
    '127.1.2.3', // 127/8 整段回环
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254', // 172.16/12 边界
    '192.168.1.1',
    '192.168.0.255',
    '169.254.169.254', // 云元数据
    '169.254.0.1',
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    '192.0.0.9',
    '192.0.2.1', // TEST-NET-1
    '192.88.99.1',
    '198.18.0.1', // 基准
    '198.19.255.1',
    '198.51.100.7', // TEST-NET-2
    '203.0.113.9', // TEST-NET-3
    '224.0.0.1', // 组播
    '239.1.1.1',
    '240.0.0.1', // 保留
    '255.255.255.255'
  ];
  const allowedV4 = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.254', '100.63.255.255', '100.128.0.1', '198.17.255.1', '198.20.0.1'];

  it.each(blockedV4)('阻止 IPv4 %s', (ip) => {
    expect(isBlockedIp(ip), ip).toBe(true);
  });
  it.each(allowedV4)('放行公网 IPv4 %s', (ip) => {
    expect(isBlockedIp(ip), ip).toBe(false);
  });

  const blockedV6 = [
    '::',
    '::1',
    'fe80::1', // 链路本地
    'febf:ffff::1',
    'fc00::1', // ULA
    'fdff:ffff::1',
    'ff02::1', // 组播
    '2001:db8::1', // 文档段
    '100::1', // discard
    '::ffff:127.0.0.1', // IPv4-mapped 回环（点分写法）
    '::ffff:7f00:1', // IPv4-mapped 回环（十六进制写法，URL 归一化产物）
    '::ffff:10.0.0.5', // 映射私网
    '::ffff:a9fe:a9fe', // 映射链路本地（169.254.169.254）
    '::ffff:192.168.1.1',
    '64:ff9b::127.0.0.1', // 知名 NAT64 映射回环
    '64:ff9b::10.0.0.1', // NAT64 映射私网
    '64:ff9b:1::1' // 本地用途 NAT64
  ];
  const allowedV6 = [
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8', // 映射公网地址（IP 层放行）
    '64:ff9b::8.8.8.8' // NAT64 映射公网
  ];

  it.each(blockedV6)('阻止 IPv6 %s', (ip) => {
    expect(isBlockedIp(ip), ip).toBe(true);
  });
  it.each(allowedV6)('放行公网 IPv6 %s', (ip) => {
    expect(isBlockedIp(ip), ip).toBe(false);
  });

  it('非法地址字符串一律拒绝', () => {
    expect(isBlockedIp('')).toBe(true);
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('999.1.1.1')).toBe(true);
    expect(isBlockedIp('::gg::1')).toBe(true);
  });
});
