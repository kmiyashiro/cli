const { EOL } = require('os')
const path = require('path')
const process = require('process')
const rl = require('readline')

const { getTrafficMeshForLocalSystem } = require('@netlify/traffic-mesh-agent')
const execa = require('execa')
const waitPort = require('wait-port')

const { getPathInProject } = require('../lib/settings')
const { startSpinner, stopSpinner } = require('../lib/spinner')

const { NETLIFYDEVLOG, NETLIFYDEVERR, NETLIFYDEVWARN } = require('./logo')

const EDGE_HANDLERS_BUNDLER_CLI_PATH = path.resolve(require.resolve('@netlify/plugin-edge-handlers'), '..', 'cli.js')

const startForwardProxy = async ({ port, frameworkPort, functionsPort, publishDir, log, debug }) => {
  const args = [
    'start',
    'local',
    '--port',
    port,
    '--forward-proxy',
    `http://localhost:${frameworkPort}`,
    '--watch',
    publishDir,
    '--bundler',
    EDGE_HANDLERS_BUNDLER_CLI_PATH,
    '--log-file',
    getPathInProject(['logs', 'traffic-mesh.log']),
    '--progress',
  ]

  if (functionsPort) {
    args.push('--local-services-uri', `http://localhost:${functionsPort}`)
  }

  if (debug) {
    args.push('--debug')
  }

  const { subprocess } = runProcess({ log, args })
  const forwarder = forwardMessagesToLog({ log, subprocess })

  subprocess.on('close', process.exit)
  subprocess.on('SIGINT', process.exit)
  subprocess.on('SIGTERM', process.exit)
  ;['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP', 'exit'].forEach((signal) => {
    process.on(signal, () => {
      forwarder.close()

      const sig = signal === 'exit' ? 'SIGTERM' : signal
      subprocess.kill(sig, {
        forceKillAfterTimeout: PROXY_EXIT_TIMEOUT,
      })
    })
  })

  try {
    const open = await waitPort({ port, output: 'silent', timeout: PROXY_READY_TIMEOUT })
    if (!open) {
      throw new Error(`Timed out waiting for forward proxy to be ready on port '${port}'`)
    }
    return `http://localhost:${port}`
  } catch (error) {
    log(`${NETLIFYDEVERR}`, error)
  }
}

const forwardMessagesToLog = ({ log, subprocess }) => {
  let currentId = null
  let spinner = null

  const reset = () => {
    currentId = null
    spinner = null
  }

  const iface = rl.createInterface({
    input: subprocess.stderr,
  })

  iface
    .on('line', (line) => {
      let data
      try {
        data = JSON.parse(line.trim())
      } catch (error) {
        log(`${NETLIFYDEVERR} Cannot parse log line as JSON: ${line.trim()}${EOL}${EOL}${error}`)
        return
      }

      const { error, id, type } = data
      switch (type) {
        case 'bundle:start':
          currentId = id
          if (!spinner) {
            spinner = startSpinner({ text: 'Bundling edge handlers...' })
          }
          break

        case 'bundle:success':
          if (currentId !== id) {
            return
          }

          stopSpinner({ spinner, error: false, text: 'Done.' })
          reset()
          break

        case 'bundle:fail':
          if (currentId !== id) {
            return
          }

          stopSpinner({
            spinner,
            error: true,
            text: (error && error.msg) || 'Failed bundling Edge Handlers',
          })
          log(`${NETLIFYDEVLOG} Change any project file to trigger a re-bundle`)
          reset()
          break

        default:
          log(`${NETLIFYDEVWARN} Unknown mesh-forward event '${type}'`)
          break
      }
    })
    .on('close', () => {
      if (spinner) {
        // Hide the spinner
        spinner.stop()
      }

      reset()
    })
    .on('error', (err) => {
      stopSpinner({
        spinner,
        error: true,
        text: `${NETLIFYDEVERR} An error occured while bundling processing the messages from mesh-forward: ${err}`,
      })

      reset()
    })

  return iface
}

// 30 seconds
const PROXY_READY_TIMEOUT = 3e4
// 2 seconds
const PROXY_EXIT_TIMEOUT = 2e3

const runProcess = ({ args }) => {
  const subprocess = execa(getTrafficMeshForLocalSystem(), args, { stdio: ['inherit', 'inherit', 'pipe'] })
  return { subprocess }
}

module.exports = { runProcess, startForwardProxy }
