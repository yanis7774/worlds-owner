import { Lifecycle } from '@well-known-components/interfaces'
import { IslandChangedMessage, JoinIslandMessage } from './controllers/proto/archipelago'
import { setupRouter } from './controllers/routes'
import { AppComponents, GlobalContext, TestComponents } from './types'
import { sign } from 'jsonwebtoken'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  // wire the HTTP router (make it automatic? TBD)
  const router = await setupRouter(globalContext)
  // register routes middleware
  components.server.use(router.middleware())
  // register not implemented/method not allowed/cors responses middleware
  components.server.use(router.allowedMethods())
  // set the context to be passed to the handlers
  components.server.setContext(globalContext)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  const { nats, config, logs } = components
  const logger = logs.getLogger('archipelago')

  const baseURL = await config.requireString('WS_ROOM_SERVICE_URL')
  const secret = await config.requireString('WS_ROOM_SERVICE_SECRET')

  const alreadyHaveIsland = new Set<string>()

  nats.subscribe('peer.*.disconnect', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    const peerId = message.subject.split('.')[1]
    alreadyHaveIsland.delete(peerId)
  })

  nats.subscribe('client-proto.peer.*.heartbeat', (err, message) => {
    if (err) {
      logger.error(err)
      return
    }

    const peerId = message.subject.split('.')[2]
    if (alreadyHaveIsland.has(peerId)) {
      return
    }

    alreadyHaveIsland.add(peerId)
    const islandId = 'island'

    const accessToken = sign({ peerId }, secret, {})
    const connStr = `ws-room:${baseURL}/ws-rooms/${islandId}?access_token=${accessToken}`

    const islandChangedMessage: IslandChangedMessage = {
      islandId,
      connStr: connStr,
      peers: {}
    }

    logger.log(`publishing island changed message for ${peerId}`)
    nats.publish(`client-proto.${peerId}.island_changed`, IslandChangedMessage.encode(islandChangedMessage).finish())

    nats.publish(
      `client-proto.island.${islandId}.peer_join`,
      JoinIslandMessage.encode({
        islandId,
        peerId
      }).finish()
    )
  })
}
