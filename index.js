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
import { gossipsub } from '@chainsafe/libp2p-gossipsub'

document.title = 'v17'

const logHtml = (line) => {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(line))
  document.getElementById('output').append(div)
}

const node = await createLibp2p({
  addresses: {
    listen: [
      '/p2p-circuit',
      '/webrtc'
    ]
  },
  transports: [
    webSockets(), // needed to connect to relay
    webRTC(),
    circuitRelayTransport() // needed to listen with webrtc using the relay
  ],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  connectionGater: {denyDialMultiaddr: () => false},
  services: {
    identify: identify(),
    identifyPush: identifyPush(),
    pubsub: gossipsub({allowPublishToZeroPeers: true})
  }
})
await node.start()

// pubsub sub
const pubsubTopic = 'demo'
node.services.pubsub.addEventListener('message', (evt) => {
  logHtml(`${evt.detail.from}: ${new TextDecoder().decode(evt.detail.data)} on topic ${evt.detail.topic}`)
})
await node.services.pubsub.subscribe(pubsubTopic)

// pubsub pub
setInterval(() => {
  node.services.pubsub.publish(pubsubTopic, new TextEncoder().encode(`demo message from browser ${node.peerId}`)).catch(console.error)
}, 2000)

const logConnections = () => document.getElementById('connections').replaceChildren(...node.getConnections().map((connection) => {
  const el = document.createElement('li')
  el.textContent = connection.remoteAddr.toString()
  return el
}))
node.addEventListener('connection:open', logConnections)
node.addEventListener('connection:close', logConnections)

// only use webrtc addresses with relay over websocket
const isValidAddress = (address) => address.includes('/webrtc/') && address.includes('/ws/') && address.includes('/dns')

// when own listen addresses change
node.addEventListener('self:peer:update', (event) => {
  // log own listen addresses
  console.log(node.getMultiaddrs().map(ma => ma.toString()))
  document.getElementById('multiaddrs').replaceChildren(...node.getMultiaddrs()
    .map(ma => ma.toString())
    .filter(isValidAddress)
    .map((ma) => {
      const el = document.createElement('li')
      el.textContent = ma
      return el
    }))

  doPeerDiscovery()
})

// connect to relay (any kubo node with auto tls)
const relay = '/dns4/194-11-226-35.k51qzi5uqu5dhlxz4gos5ph4wivip9rgsg6tywpypccb403b0st1nvzhw8as9q.libp2p.direct/tcp/4001/tls/ws/p2p/12D3KooWDfnXqdZfsoqKbcYEDKRttt3adumB5m6tw8YghPwMAz8V'
try {
  await node.dial(multiaddr(relay))
  logHtml(`Connected to relay '${relay}'`)
}
catch (e) {
  console.log(e)
  logHtml(`Error connecting to relay: ${e.message}`)
}

// do peer discovery with plebbit trackers, announce and get peers
let peersDiscovered = []
const doPeerDiscovery = async () => {
  const routingCid = 'bafybeigmddlmc235fgegsdagzfcutnqjo2kxamyfrpfziaxrsc6ptb5fnm'

  // discover peers
  try {
    const {Providers} = await fetch(`https://peers.pleb.bot/routing/v1/providers/${routingCid}`).then(res => res.json())
    const addresses = []
    for (const provider of Providers) {
      if (!provider.ID) {
        continue
      }
      for (const address of provider.Addrs) {
        if (isValidAddress(address)) {
          addresses.push(address)
        }
      }
    }
    peersDiscovered = addresses
    console.log({peersDiscovered})
  }
  catch (e) {
    console.log(e)
    logHtml(`Error discovering peers: ${e.message}`)
  }

  // announce
  try {
    const myAddresses = node.getMultiaddrs()
      .map(ma => ma.toString())
      .filter(isValidAddress)
    if (!myAddresses.length) {
      throw Error(`don't have any addresses`)
    }

    const body = JSON.stringify({Providers: [{
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
    }]})
    const res = await fetch('https://peers.pleb.bot/routing/v1/providers/', {method: 'PUT', body})
    console.log('announced', res)
  }
  catch (e) {
    console.log(e)
    logHtml(`Error announcing: ${e.message}`)
  }

  // connect to peers
  peersDiscovered.forEach(address => {
    console.log('dialing', address)
    node.dial(multiaddr(address))
      .catch(console.log)
  })
}
