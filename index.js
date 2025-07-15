import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify, identifyPush } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webRTC } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { multiaddr, protocols } from '@multiformats/multiaddr'
import { byteStream } from 'it-byte-stream'
import { createLibp2p } from 'libp2p'
import { fromString, toString } from 'uint8arrays'

document.title = 'v6'

const WEBRTC_CODE = protocols('webrtc').code

const output = document.getElementById('output')
const sendSection = document.getElementById('send-section')
const appendOutput = (line) => {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(line))
  output.append(div)
}
const CHAT_PROTOCOL = '/libp2p/examples/chat/1.0.0'
let ma
let chatStream

const node = await createLibp2p({
  addresses: {
    listen: [
      '/p2p-circuit',
      '/webrtc'
    ]
  },
  transports: [
    webSockets({
      filter: filters.all
    }),
    webRTC(),
    circuitRelayTransport()
  ],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: {
    denyDialMultiaddr: () => {
      // by default we refuse to dial local addresses from the browser since they
      // are usually sent by remote peers broadcasting undialable multiaddrs but
      // here we are explicitly connecting to a local node so do not deny dialing
      // any discovered address
      return false
    }
  },
  services: {
    identify: identify(),
    identifyPush: identifyPush(),
    ping: ping()
  }
})

await node.start()

function updateConnList () {
  // Update connections list
  const connListEls = node.getConnections()
    .map((connection) => {
      if (connection.remoteAddr.protoCodes().includes(WEBRTC_CODE)) {
        ma = connection.remoteAddr
        sendSection.style.display = 'block'
      }

      const el = document.createElement('li')
      el.textContent = connection.remoteAddr.toString()
      return el
    })
  document.getElementById('connections').replaceChildren(...connListEls)
}

node.addEventListener('connection:open', (event) => {
  updateConnList()
})
node.addEventListener('connection:close', (event) => {
  updateConnList()
})

node.addEventListener('self:peer:update', (event) => {
  // debug addresses
  console.log(node.getMultiaddrs().map(ma => ma.toString()))

  // Update multiaddrs list, only show WebRTC addresses with websocket relays
  const multiaddrs = node.getMultiaddrs()
    .map(ma => ma.toString())
    .filter(ma => ma.includes('/webrtc/') && ma.includes('/ws/'))
    .map((ma) => {
      const el = document.createElement('li')
      el.textContent = ma
      return el
    })
  document.getElementById('multiaddrs').replaceChildren(...multiaddrs)

  doPeerDiscovery()
})

node.handle(CHAT_PROTOCOL, async ({ stream }) => {
  chatStream = byteStream(stream)

  while (true) {
    const buf = await chatStream.read()
    appendOutput(`Received message '${toString(buf.subarray())}'`)
  }
})

const isWebrtc = (ma) => {
  return ma.protoCodes().includes(WEBRTC_CODE)
}

window.connect.onclick = async () => {
  ma = multiaddr(window.peer.value)
  appendOutput(`Dialing '${ma}'`)

  const signal = AbortSignal.timeout(5000)

  try {
    if (isWebrtc(ma)) {
      const rtt = await node.services.ping.ping(ma, {
        signal
      })
      appendOutput(`Connected to '${ma}'`)
      appendOutput(`RTT to ${ma.getPeerId()} was ${rtt}ms`)
    } else {
      await node.dial(ma, {
        signal
      })
      appendOutput('Connected to relay')
    }
  } catch (err) {
    if (signal.aborted) {
      appendOutput(`Timed out connecting to '${ma}'`)
    } else {
      appendOutput(`Connecting to '${ma}' failed - ${err.message}`)
    }
  }
}

window.send.onclick = async () => {
  if (chatStream == null) {
    appendOutput('Opening chat stream')

    const signal = AbortSignal.timeout(5000)

    try {
      const stream = await node.dialProtocol(ma, CHAT_PROTOCOL, {
        signal
      })
      chatStream = byteStream(stream)

      Promise.resolve().then(async () => {
        while (true) {
          const buf = await chatStream.read()
          appendOutput(`Received message '${toString(buf.subarray())}'`)
        }
      })
    } catch (err) {
      if (signal.aborted) {
        appendOutput('Timed out opening chat stream')
      } else {
        appendOutput(`Opening chat stream failed - ${err.message}`)
      }

      return
    }
  }

  const message = window.message.value.toString().trim()
  appendOutput(`Sending message '${message}'`)
  chatStream.write(fromString(message))
    .catch(err => {
      appendOutput(`Error sending message - ${err.message}`)
    })
}

// connect to relay
const relay = '/dns4/194-11-226-35.k51qzi5uqu5dhlxz4gos5ph4wivip9rgsg6tywpypccb403b0st1nvzhw8as9q.libp2p.direct/tcp/4001/tls/ws/p2p/12D3KooWDfnXqdZfsoqKbcYEDKRttt3adumB5m6tw8YghPwMAz8V'
try {
  await node.dial(multiaddr(relay))
  appendOutput(`Connected to relay '${relay}'`)
}
catch (e) {
  console.log(e)
  appendOutput(`Error connecting to relay: ${e.message}`)
}

// do peer discovery, announce and get peers
let peersDiscovered = []
const doPeerDiscovery = async () => {
  const routingCid = 'webrtctestaaaaaaaabbbbbbbbccccccccdddddddd'
  // discover peers
  try {
    const {Providers} = await fetch(`https://peers.pleb.bot/routing/v1/providers/${routingCid}`).then(res => res.json())
    const addresses = []
    for (const provider of Providers) {
      if (!provider.ID) {
        continue
      }
      for (const address of provider.Addrs) {
        if (address.includes('/webrtc/') && address.includes('/ws/')) {
          addresses.push(`${address}/p2p/${provider.ID}`)
        }
      }
    }
    peersDiscovered = addresses
    console.log({peersDiscovered})
  }
  catch (e) {
    console.log(e)
    appendOutput(`Error discovering peers: ${e.message}`)
  }

  // announce
  try {
    const myAddresses = node.getMultiaddrs()
      .map(ma => ma.toString())
      .filter(ma => ma.includes('/webrtc/') && ma.includes('/ws/'))
    if (!myAddresses.length) {
      throw Error(`I don't have any addresses`)
    }

    const body = {Providers: [{
      Schema: 'bitswap',
      Protocol: 'transport-bitswap',
      Signature: 'mx5kamm5kzxuCnVJtX3K9DEj8gKlFqXil2x/M8zDTozvzowTY6W+HOALQ2LCkTZCEz4H5qizpnHxPM/rVQ7MNBg',
      Payload: {
        Keys: [routingCid],
        Timestamp: Date.now(),
        AdvisoryTTL: 86400000000000,
        ID: node.peerId.toString(),
        Addrs: myAddresses
      }
    }]}
    const res = await fetch('https://peers.pleb.bot/routing/v1/providers/', {method: 'PUT', body}).then(res => res.txt())
    console.log(res)
  }
  catch (e) {
    console.log(e)
    appendOutput(`Error announcing: ${e.message}`)
  }
}
