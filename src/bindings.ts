import { Http3Server } from "@fails-components/webtransport";
import { WebSocketServer } from "ws";
import { Slokr } from "./index.js";
import { genCerts } from "./WebTransport/certs.js";
import { createServer as createHttpsServer, Server as HTTPSServer } from "node:https";
import { createServer as createHttpServer, Server as HTTPServer } from "node:http";
import { DataTools } from "@briklab/slikr/datatools"
export class Bindings {
    #type: Slokr.ValidMode;
    wt?: Http3Server;
    wss?: WebSocketServer;
    https?: HTTPSServer | HTTPServer;
    oncf: Function[] = []
    onef: Function[] = []
    wsconnected?: boolean;
    wtconnected?: boolean;
    startupError?: Error;
    #onconnected(a: Function) {
        this.oncf.push(a)
    }
    #isConnected() {
        if (this.#type === Slokr.WebSocket) return Boolean(this.wsconnected);
        if (this.#type === Slokr.WebTransport) return Boolean(this.wtconnected);
        return Boolean(this.wsconnected && this.wtconnected);
    }
    get connected() {
        if (this.#isConnected()) {
            return Promise.resolve("connected");
        }
        return new Promise((resolve) => {
            this.#onconnected(() => { resolve("connected") })
            this.#onerror((error: Error) => reject(error))
        })
    }
    constructor(type: Slokr.ValidMode, port: number = 3000, host: string = "0.0.0.0") {
        this.#type = type;

        const certificate = genCerts();
        if (type === Slokr.Hybrid) {
            this.flags.wt = true;
            this.flags.ws = true;
            this.flags.hy = true;
            this.handle.WebSocket.call(this, host, port, certificate);
            this.handle.WebTransport.call(this, host, port, certificate);
            return;
        }

        if (type === Slokr.WebSocket) {
            this.flags.ws = true;
            this.handle.WebSocket.call(this, host, port, certificate);
            return;
        }

        if (type === Slokr.WebTransport) {
            this.flags.wt = true;
            this.handle.WebTransport.call(this, host, port, certificate);
            return;
        }

        throw new Slokr.Error(`Invalid mode: ${type}`);
    }
    #ratelimitt: number | false = 100;
    #ratelimitr: number | false = 2;
    ratelimittime(num: number) {
        if (num === 0) this.#ratelimitt = false;
        else this.#ratelimitt = num;
    }
    ratelimitrate(rate: number) {
        if (rate === 0) this.#ratelimitr = false;
        else this.#ratelimitr = rate;
    }
    get ratelimit() {
        return this.#ratelimitr || this.#ratelimitt
    }
    async #handleWebTransportSession(session: any) {
        const streams = session.incomingBidirectionalStreams;

        for await (const bidiStream of streams) {
            (async () => {
                const reader = bidiStream.readable.getReader();
                let chunks: Uint8Array[] = [];

                while (true) {
                    const { value, done } = await reader.read();

                    if (done) {
                        const fullMessage = Buffer.concat(chunks).toString();
                        let parsed = DataTools.get(fullMessage);

                        if (!parsed) {
                            const wrt = bidiStream.writable.getWriter();
                            await wrt.write(Buffer.from(JSON.stringify({
                                isError: true,
                                error: "Data could not be parsed!",
                                resolution: "slokr only parses messages from `slikr`",
                                code: "EUNKNOWN",
                                from: "Slokr",
                            })));
                            await wrt.close();
                            break;
                        }

                        const events = this.handle.events[parsed.name] ?? [];
                        if (parsed.name === "SLIKR_INTERNAL_EVENT") {
                            const { room, do: action } = parsed.payload;
                            if (action === "join") this.joinRoom(room, session);
                            if (action === "leave") this.leaveRoom(room, session);
                            return;
                        }
                        let eventinfo: Slokr.EVENT.DATA = {
                            eventname: parsed.name,
                            slikr: { version: parsed.version },
                            time: {
                                sentAt: parsed.date,
                                timeTaken: Date.now() - parsed.date,
                                recievedAt: Date.now()
                            },
                            client: {
                                averagePerformance: parsed.clientAveragePerformance,
                                ip: session.remoteAddress,
                                from: Slokr.WebTransport,
                                userAgent: "Unknown"
                            },
                            raw: Buffer.concat(chunks),
                            slokr: { mode: this.#type },
                            join: (room: string) => this.joinRoom(room, session),
                            leave: (room: string) => this.leaveRoom(room, session),
                            broadcast: async (room: string, name: string, data: any) => {
                                await this.broadcastToRoom(room, name, data);
                            },
                            reply: async (name: string, data: any) => {
                                await this.handle.send(session, name, data);
                            }
                        };
                        for (const fn of events) {
                            fn(parsed.payload, new Slokr.Client(eventinfo));
                        }
                        const anyEvents = this.handle.events["any"]
                        if (anyEvents) {
                            for (let i = 0; i < anyEvents.length; i++) {
                                let fn = anyEvents[i]
                                fn(parsed.payload, new Slokr.Client(eventinfo))
                            }
                        }
                        break;
                    }
                    chunks.push(value);
                }
            })();
        }
    }
    async send(name: string, data: any) {
        const packet = DataTools.create(name, data);

        if (this.#type === Slokr.Hybrid || this.#type === Slokr.WebSocket) {
            if (this.wss) {
                for (const client of this.wss.clients) {
                    if (client.readyState === 1) {
                        await this.handle.send(client, name, data);
                    }
                }
            }
        }

        if (this.#type === Slokr.Hybrid || this.#type === Slokr.WebTransport) {
            for (const session of this.handle.wtSessions) {
                await this.handle.send(session, name, data);
            }
        }
    }
    cache: Slokr.CACHE = {}
    flags:  Slokr.FLAGS = {}
    handle:  Slokr.HANDLE.TYPE = {
        cache: {},
        events: {},
        async receive(eventName: string, timeout: number = 0) {
            let timeoutId: any;

            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
            };

            const dataPromise = new Promise((resolve) => {
                const handler = (data: string) => {
                    cleanup();
                    resolve(data);
                };
                this.on(eventName, handler);
            });

            if (timeout === 0) return await dataPromise;

            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Slokr.Error(`${eventName} exceeded timeout`));
                }, timeout);
            });

            return await Promise.race([dataPromise, timeoutPromise]);
        },
        on(eventName: string, listener: Slokr.EVENT) {
            if (!this.events[eventName]) {
                this.events[eventName] = [];
            }
            this.events[eventName].push(listener)
        },
        WebTransport: async (host: string, port: number, certificate: genCerts.returns) => {
            this.wt = new Http3Server({
                port,
                host,
                cert: certificate.cert,
                privKey: certificate.key,
                secret: "SLOKR-SECRET",
            });
            this.handle.wt = this.wt
            try {
                this.wt.startServer();
                this.wtconnected = true;
                const isHybridReady = (this.#type === Slokr.Hybrid && this.wsconnected && this.wtconnected);
                const isSingleReady = (this.#type === Slokr.WebTransport && this.wtconnected);

                if (isHybridReady || isSingleReady) {
                    this.oncf.forEach(a => a());
                }
            } catch (error) {
                this.#emitError(error);
                return;
            }

            const wtAny = this.wt as any;
            if (wtAny?.on) {
                wtAny.on("error", (error: Error) => this.#emitError(error));
            }
            const sessions = this.wt.sessionStream("/");
            (async () => {
                try {
                for await (const session of sessions) {
                    await session.ready;
                    this.handle.wtSessions.push(session);
                    this.joinRoom("global", session);
                    this.stats.connections++;
                    session.closed.then(() => {
                        const closeEvents = this.handle.events["close"] ?? [];
                        let closeInfo: Slokr.EVENT.DATA = {
                            eventname: "close",
                            slikr: { version: "unknown" },
                            time: { sentAt: Date.now(), timeTaken: 0, recievedAt: Date.now() },
                            client: {
                                averagePerformance: 0,
                                ip: session.remoteAddress,
                                from: Slokr.WebTransport
                            },
                            raw: Buffer.alloc(0),
                            slokr: { mode: this.#type },
                            join: (room) => false,
                            leave: (room) => false,
                            broadcast: async (room, name, data) => false,
                            reply: async (name, data) => false
                        };

                        const clientObj = new Slokr.Client(closeInfo);
                        for (const fn of closeEvents) {
                            fn("disconnected", clientObj);
                        }
                        this.leaveRoom("global", session)
                        this.handle.wtSessions = this.handle.wtSessions.filter(s => s !== session);
                        this.stats.connections--;
                        this.fullCleanup(session);
                    });
                    // handle here
                    const connectionEvents = this.handle.events["connection"] ?? [];

                    let connectInfo: Slokr.EVENT.DATA = {
                        eventname: "connection",
                        slikr: { version: "unknown" },
                        time: { sentAt: Date.now(), timeTaken: 0, recievedAt: Date.now() },
                        client: {
                            averagePerformance: 0,
                            ip: session.remoteAddress,
                            from: Slokr.WebTransport
                        },
                        raw: Buffer.alloc(0),
                        slokr: { mode: this.#type },
                        join: (room) => this.joinRoom(room, session),
                        leave: (room) => this.leaveRoom(room, session),
                        broadcast: (room, name, data) => this.broadcastToRoom(room, name, data),
                        reply: (name, data) => this.handle.send(session, name, data)
                    };

                    const clientObj = new Slokr.Client(connectInfo);
                    for (const fn of connectionEvents) {
                        fn("connected", clientObj);
                    }
                    this.#handleWebTransportSession(session);
                }
                } catch (error) {
                    this.#emitError(error);
                }
            })();
        },
        async send(target: any, name: string, payload: any) {
            const data = Buffer.from(DataTools.create(name, payload));

            // WEBSOCKET CHECK
            if (target.send && typeof target.readyState !== 'undefined') {
                target.send(data);
            }
            // WEBTRANSPORT CHECK
            else if (target.createUnidirectionalStream) {
                try {
                    const stream = await target.createUnidirectionalStream();
                    const writer = stream.getWriter();
                    await writer.write(data);
                    await writer.close();
                } catch (e) {
                }
            }
        },
        wtSessions: [],
        WebSocket: async (host: string, port: number, certificate: genCerts.returns) => {
            if (this.#type === Slokr.WebSocket) {
                this.https = createHttpServer();
            } else {
                this.https = createHttpsServer({
                    key: certificate.key,
                    cert: certificate.cert,
                });
            }
            this.handle.https = this.https
            this.wss = new WebSocketServer({
                server: this.https,
            });
            this.handle.wss = this.wss
            this.wss.on("error", (error) => this.#emitError(error));
            this.https.on("error", (error) => this.#emitError(error));
            this.https.listen(port, host, () => {
                this.wsconnected = true;
                const isHybridReady = (this.#type === Slokr.Hybrid && this.wtconnected && this.wsconnected);
                const isSingleReady = (this.#type === Slokr.WebSocket && this.wsconnected);

                if (isHybridReady || isSingleReady) {
                    this.oncf.forEach(a => a());
                }
            });
            this.wss.on("connection", (socket, request) => {
                const info = {
                    ip: request.socket.remoteAddress
                }
                this.joinRoom("global", socket);
                this.stats.connections++
                socket.on("close", () => {
                    const closeEvents = this.handle.events["close"] ?? [];
                    let closeInfo: Slokr.EVENT.DATA = {
                        eventname: "close",
                        slikr: { version: "unknown" },
                        time: { sentAt: Date.now(), timeTaken: 0, recievedAt: Date.now() },
                        client: {
                            averagePerformance: 0,
                            ip: info.ip,
                            from: Slokr.WebSocket,
                            userAgent: request.headers["user-agent"]
                        },
                        raw: Buffer.alloc(0),
                        slokr: { mode: this.#type },
                        join: (room) => false,
                        leave: (room) => false,
                        broadcast: async (room, name, data) => false,
                        reply: async (name, data) => false
                    };

                    const clientObj = new Slokr.Client(closeInfo);
                    for (const fn of closeEvents) {
                        fn("disconnected", clientObj);
                    }
                    this.leaveRoom("global", socket)
                    this.stats.connections--;
                    this.fullCleanup(socket)
                })
                const connectionEvents = this.handle.events["connection"] ?? [];
                let connectInfo: Slokr.EVENT.DATA = {
                    eventname: "connection",
                    slikr: { version: "unknown" },
                    time: { sentAt: Date.now(), timeTaken: 0, recievedAt: Date.now() },
                    client: {
                        averagePerformance: 0,
                        ip: request.socket.remoteAddress,
                        from: Slokr.WebSocket,
                        userAgent: request.headers["user-agent"]
                    },
                    raw: Buffer.alloc(0),
                    slokr: { mode: this.#type },
                    join: (room) => this.joinRoom(room, socket),
                    leave: (room) => this.leaveRoom(room, socket),
                    broadcast: (room, name, data) => this.broadcastToRoom(room, name, data),
                    reply: (name, data) => this.handle.send(socket, name, data)
                };

                const clientObj = new Slokr.Client(connectInfo);
                for (const fn of connectionEvents) {
                    fn("connected", clientObj);
                }
                let rtdata: number[] = []
                socket.on("message", (raw) => {
                    const now = Date.now();
                    const windowMs = this.#ratelimitt as number;
                    const maxPackets = this.#ratelimitr as number;
                    rtdata = rtdata.filter(timestamp => now - timestamp < windowMs);
                    if (this.ratelimit && rtdata.length >= maxPackets) {
                        return;
                    }
                    rtdata.push(now);

                    let rawBuffer: Buffer;
                    if (Buffer.isBuffer(raw)) rawBuffer = raw;
                    else if (Array.isArray(raw)) rawBuffer = Buffer.concat(raw);
                    else rawBuffer = Buffer.from(raw);

                    const data = rawBuffer.toString();
                    let parsed = DataTools.get(data);
                    if (!parsed) return socket.send(Buffer.from(JSON.stringify({
                        isError: true,
                        error: "Data could not be parsed!",
                        resolution: "slokr only parses messages from `slikr`",
                        code: "EUNKNOWN",
                        from: "Slokr",
                    })))

                    if (parsed.name === "SLIKR_INTERNAL_EVENT") {
                        const { room, do: action } = parsed.payload;
                        if (action === "join") this.joinRoom(room, socket);
                        if (action === "leave") this.leaveRoom(room, socket);
                        return;
                    }

                    const events = this.handle.events[parsed.name] ?? [];
                    let eventinfo: Slokr.EVENT.DATA = {
                        eventname: parsed.name,
                        slikr: {
                            version: parsed.version
                        },
                        time: {
                            sentAt: parsed.date,
                            timeTaken: Date.now() - parsed.date,
                            recievedAt: Date.now()
                        },
                        client: {
                            averagePerformance: parsed.clientAveragePerformance,
                            ip: info.ip,
                            from: Slokr.WebSocket,
                            userAgent: request.headers["user-agent"]
                        },
                        raw: rawBuffer,
                        slokr: {
                            mode: this.#type
                        },
                        join: (room) => this.joinRoom(room, socket),
                        leave: (room) => this.leaveRoom(room, socket),
                        broadcast: async (room, name, data) => {
                            await this.broadcastToRoom(room, name, data);
                        },
                        reply: async (name, data) => {
                            await this.handle.send(socket, name, data);
                        }
                    }
                    for (let i = 0; i < events.length; i++) {
                        let fn = events[i]
                        fn(parsed.payload, new Slokr.Client(eventinfo))
                    }
                    const anyEvents = this.handle.events["any"]
                    if (anyEvents) {
                        for (let i = 0; i < anyEvents.length; i++) {
                            let fn = anyEvents[i]
                            fn(parsed.payload, new Slokr.Client(eventinfo))
                        }
                    }
                })
            })
        },

    };
    stats = {
        connections: 0,
    }
    rooms: Map<string, Set<any>> = new Map();

    joinRoom(roomName: string, target: any, onJoin?: () => any) {
        if (!this.rooms.has(roomName)) {
            this.rooms.set(roomName, new Set());
        }
        this.rooms.get(roomName)!.add(target);
        if (target && onJoin) this.broadcastToRoomExcept(roomName, "New Client", onJoin(), target)
    }

    leaveRoom(roomName: string, target: any, onLeave?: () => any) {
        const room = this.rooms.get(roomName);
        if (room) {
            room.delete(target);
            if (room.size === 0) this.rooms.delete(roomName);
        }
        if (target && onLeave) this.broadcastToRoomExcept(roomName, "Client Left", onLeave(), target)
    }

    async broadcastToRoom(roomName: string, name: string, data: any) {
        const room = this.rooms.get(roomName);
        if (!room) return;

        const roomAwareData = {
            ...data,
            SLIKR_INTERNAL_EVENT: { _room: roomName }
        };
        for (const target of room) {
            try {
                await this.handle.send(target, name, roomAwareData);
            } catch (e) { }
        }
    }

    fullCleanup(target: any) {
        for (const [name, set] of this.rooms) {
            if (set.has(target)) {
                this.leaveRoom(name, target);
            }
        }
    }
    broadcastToRoomExcept(roomName: string, name: string, data: any, exclude: any) {
        const room = this.rooms.get(roomName);
        if (!room) return;
        const roomAwareData = {
            ...data,
            SLIKR_INTERNAL_EVENT: { _room: roomName }
        };
        const promises = [];
        for (const client of room) {
            if (client !== exclude) promises.push(this.handle.send(client, name, roomAwareData));
        }
        return Promise.all(promises);
    }
    async broadcastToAllRoomsExcept(name: string, data: any, exclude: string[]) {
        const excludeSet = new Set(exclude);
        for (const [roomName, clients] of this.rooms) {
            if (excludeSet.has(roomName)) continue;
            for (const client of clients) {
                try {
                    await this.handle.send(client, name, data);
                } catch (e) {
                }
            }
        }
    }
}
