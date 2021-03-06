import { getLogger } from "log4js"
import { Socket } from "net"
import { AsyncLock } from "../../common/asyncLock"
import * as proto from "../../serialization/proto"
import { SocketParser } from "./socketParser"

const logger = getLogger("Network")
const MAX_REPLY_ID = Math.pow(2, 32) - 1
const MIN_REPLY_ID = Math.pow(2, 30)

// tslint:disable-next-line:interface-name
interface ReplyAndPacket { reply: proto.Network, packet: Buffer }
type replyResolve = (reply: ReplyAndPacket) => void
type replyReject = (reason?: any) => void
export abstract class BasePeer {
    public static DefaultTimeoutTime = 30000
    public socketBuffer: SocketParser
    private replyId: number
    private replyMap: Map<number, { resolved: replyResolve, reject: replyReject, timeout: NodeJS.Timer }>
    private requestSemaphore = new AsyncLock(0, 30000, 5)

    constructor(socket: Socket) {
        this.replyId = MIN_REPLY_ID + Math.floor(MAX_REPLY_ID - MIN_REPLY_ID)
        this.replyMap = new Map()
        this.socketBuffer = new SocketParser(socket, (route, buffer) => this.onPacket(route, buffer))
        socket.on("close", () => this.close())
    }
    public async sendPacket(buffer: Uint8Array): Promise<void> {
        return this.socketBuffer.send(0, buffer)
    }
    public disconnect() {
        this.socketBuffer.destroy()
        this.rejectAllReplies("Disconnect")
    }

    public getInfo(): string {
        return (this.socketBuffer === null) ? "" : this.socketBuffer.getInfo()
    }

    protected rejectAllReplies(reason?: string) {
        for (const [id, { reject }] of this.replyMap) {
            reject(reason)
        }
    }

    protected async onPacket(route: number, packet: Buffer): Promise<void> {
        try {
            const res = proto.Network.decode(packet)
            switch (res.request) {
                case "status":
                case "ping":
                case "getTxs":
                case "putTx":
                case "putBlock":
                case "getBlocksByHash":
                case "getHeadersByHash":
                case "getBlocksByRange":
                case "getHeadersByRange":
                case "getPeers":
                case "getTip":
                case "putHeaders":
                case "getHash":
                case "getBlockTxs":
                    this.requestSemaphore.critical(async () => await this.respond(route, res, packet)).catch((e) => logger.debug(e))
                    break
                case "statusReturn":
                case "pingReturn":
                case "putTxReturn":
                case "getTxsReturn":
                case "putBlockReturn":
                case "getBlocksByHashReturn":
                case "getHeadersByHashReturn":
                case "getBlocksByRangeReturn":
                case "getHeadersByRangeReturn":
                case "getPeersReturn":
                case "getTipReturn":
                case "putHeadersReturn":
                case "getHashReturn":
                case "getBlockTxsReturn":
                    if (route === 0) {
                        logger.debug(`Recieved ${res.request} broadcast`)
                    }
                    await this.route(route, res, packet)
                    break
                default:
                    logger.debug(`Unsupported Protocol=${res.request}`)
                    break
            }
        } catch (e) {
            this.protocolError(e)
        }
    }

    protected abstract async respond(route: number, request: proto.Network, packet: Buffer): Promise<void>

    protected async route(route: number, reply: proto.Network, packet: Buffer): Promise<void> {
        try {
            const response = this.replyMap.get(route)
            if (response !== undefined) {
                response.resolved({ reply, packet })
            }
        } catch (e) {
            this.protocolError(e)
        }
    }

    protected getTimeout(request: proto.INetwork) {
        // tslint:disable-next-line:forin
        for (const key in request) {
            switch (key) {
                case "getHash":
                case "getTip":
                case "status":
                    return 4000
                case "getBlockTxs":
                case "getHeadersByRange":
                case "getBlocksByRange":
                    return 120000
                default:
                    return BasePeer.DefaultTimeoutTime
            }
        }
    }

    protected async sendRequest(request: proto.INetwork): Promise<ReplyAndPacket> {
        const id = this.newReplyID()
        let timeout: NodeJS.Timer
        try {
            return await new Promise<ReplyAndPacket>((resolved, reject) => {
                timeout = setTimeout(() => reject("Timeout"), this.getTimeout(request))
                this.replyMap.set(id, { resolved, reject, timeout })
                this.send(id, request).catch(reject)
            })
        } catch (e) {
            if (e === "Timeout") {
                timeout = undefined
            }
            throw e
        } finally {
            this.replyMap.delete(id)
            if (timeout !== undefined) {
                clearTimeout(timeout)
            }
        }
    }

    protected async send(route: number, data: proto.INetwork): Promise<void> {
        const buffer = proto.Network.encode(data).finish()
        try { const message = proto.Network.decode(buffer) } catch (e) {
            logger.fatal("Packet not properly encoded, could not decode")
        }
        return this.socketBuffer.send(route, buffer)
    }

    protected protocolError(e: Error) {
        this.socketBuffer.destroy(e)
    }

    private newReplyID(): number {
        if (this.replyId >= MAX_REPLY_ID) {
            this.replyId = MIN_REPLY_ID
        }
        return this.replyId++
    }

    private close() {
        for (const [id, replyRoute] of this.replyMap) {
            replyRoute.reject("Disconnect")
        }
    }
}
