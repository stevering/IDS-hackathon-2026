#!/usr/bin/env node

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import process from 'process';

// Génère le secret
const MCP_TUNNEL_SECRET = randomBytes(32).toString('base64');
process.env.MCP_TUNNEL_SECRET = MCP_TUNNEL_SECRET;

// Lance le tunnel cloudflared
const tunnel = spawn('npx', [
  'cloudflared',
  'tunnel',
  '--url', 'http://localhost:3000',
  '--http-host-header', 'localhost:3000'
], {
  stdio: ['ignore', 'pipe', 'pipe']
});

// Filtre la sortie du tunnel
tunnel.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    if (
      /ERR|error|Error|FATAL/i.test(line)
    ) {
        console.log(line);
    } else {
        console.log(line);
    }
  }
});

tunnel.stderr.on('data', (data) => {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    if (
      line.includes('Your quick Tunnel has been created') ||
      line.includes('trycloudflare.com') ||
      /ERR|error|Error|FATAL/i.test(line)
    ) {
      // Extraction de l'URL trycloudflare.com
      const urlMatch = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
      if (urlMatch) {
        console.log(line);

        let tunnelUrl = urlMatch[0];
        console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
        console.log("║                                                                              ║");
        console.log("║   COPY your TUNEL_INFO and past it in parameters of:                         ║");
        console.log("║   https://ids-hackathon-2026-ds-ai-guardian.vercel.app/                      ║");
        console.log("║                                                                              ║");
        console.log("╠══════════════════════════════════════════════════════════════════════════════╣");
        console.log("║   TUNEL_INFO:                                                                ║");
        console.log("║   " + tunnelUrl.padEnd(75) + "║");
        console.log("║   " + MCP_TUNNEL_SECRET.padEnd(75) + "║");
        console.log("║                                                                              ║");
        console.log("╚══════════════════════════════════════════════════════════════════════════════╝");

      } else {
        console.log(line);
      }
    } else {
        console.log(line);
    }
  }
});

tunnel.on('error', (err) => {
  console.error('Tunnel error:', err.message);
  process.exit(1);
});

// Lance Next.js
const nextDev = spawn('npx', ['next', 'dev'], {
  stdio: 'inherit',
  env: { ...process.env, PROXY_ONLY: 'true' }
});

nextDev.on('close', (code) => {
  tunnel.kill();
  process.exit(code);
});

process.on('SIGINT', () => {
  tunnel.kill();
  nextDev.kill();
  process.exit(0);
});
