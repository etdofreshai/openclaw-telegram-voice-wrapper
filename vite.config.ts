import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn, execSync } from 'child_process'

function autoBackend(): Plugin {
  let proc: ReturnType<typeof spawn> | null = null
  // In dev, Express runs on a separate port so Vite can proxy to it
  const backendPort = process.env.BACKEND_PORT || '3001'
  return {
    name: 'auto-backend',
    configureServer() {
      console.log(`[auto-backend] Starting Express on port ${backendPort}...`)
      proc = spawn('npx', ['tsx', 'src/server.ts'], {
        stdio: 'inherit',
        env: { ...process.env, PORT: backendPort },
        shell: true,
      })
      proc.on('error', (err) => console.error('[auto-backend] Failed:', err))
      proc.on('exit', (code) => console.log(`[auto-backend] Exited code ${code}`))
    },
    buildEnd() {
      if (proc) { proc.kill(); proc = null }
    },
  }
}

const backendPort = process.env.BACKEND_PORT || '3001'
const frontendPort = parseInt(process.env.FRONTEND_PORT || '3000')
// Dev: Vite on FRONTEND_PORT (3000), Express on BACKEND_PORT (3001), Vite proxies API/WS
// Prod: Express on PORT (3000) serves everything (static + API + WS)

// Inject build info at build time if not already set via env vars
const buildTime = process.env.VITE_BUILD_TIME || new Date().toISOString()
let gitSha = process.env.VITE_GIT_SHA || 'dev'
if (gitSha === 'dev') {
  try { gitSha = execSync('git rev-parse --short HEAD').toString().trim() } catch {}
}

export default defineConfig({
  plugins: [react(), autoBackend()],
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(buildTime),
    'import.meta.env.VITE_GIT_SHA': JSON.stringify(gitSha),
  },
  server: {
    port: frontendPort,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      '^/proxy/\\d+/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/proxy\/\d+/, ''),
      },
      '/ws': {
        target: `http://localhost:${backendPort}`,
        ws: true,
        changeOrigin: true,
      },
      '^/proxy/\\d+/ws': {
        target: `http://localhost:${backendPort}`,
        ws: true,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/proxy\/\d+/, ''),
      },
    },
  },
})
