import { Bindings } from "./bindings.js";
import { Server as HTTPSServer } from "node:https";
import { Http3Server } from "@fails-components/webtransport";
import { WebSocketServer } from "ws";
export class Slokr {
    public bindings: Bindings;
    private _isReady: boolean = false;

    constructor(mode: Slokr.ValidMode, port: number = 3000, host: string = "0.0.0.0") {
        this.bindings = new Bindings(mode, port, host);

        this.bindings.connected.then(() => {
            this._isReady = true;
            console.log(`[Slokr] Server live on ${host}:${port} 🚀`);
        });
    }

    /**
     * Standard Event Listener
     * 
     * Special Events: "any", "connection", "close"
     */
    on(eventName: string, callback: Slokr.EVENT) {
        this.bindings.handle.on(eventName, callback);
    }
    /**
     * Wait for connection
     */
    get connected(){
        return this.bindings.connected;
    }
    /**
     * alias for {@link on}
     */
    listen = this.on;
    /**
     * THE RECEIVE FUNCTION
     * Pauses execution until a specific event hits.
     */
    async receive(eventName: string, timeout: number = 0): Promise<any> {
        return await this.bindings.handle.receive(eventName, timeout);
    }

    /**
     * Broadcast to every single client connected
     * 
     * Please do not use the special events "any", "connection", "close" as a normal event.
     */
    async broadcast(eventName: string, data: any) {
        if (typeof data === "object" && typeof data?.SLIKR_INTERNAL_EVENT) throw new Slokr.Error("Data passed cannot have SLIKR_INTERNAL_EVENT as a property if the data is a object.")
        await this.bindings.send(eventName, data);
    }

    /**
     * Alias for {@link broadcast}
     */
    send = this.broadcast;

    close() {
        if (this.bindings.wss) this.bindings.wss.close();
        if (this.bindings.https) this.bindings.https.close();
        if (this.bindings.wt) this.bindings.wt.stopServer();
    }

    get stats() {
        return {
            online: this.bindings.stats.connections,
            activeProtocols: this.bindings.flags,
            ready: this._isReady
        };
    }
    sendTo(client: Slokr.Client, name: string, data: any) {
        return client.reply(name, data)
    }
    for(client: Slokr.Client) {
        return {
            send: (name: string, data: any) => {
                return client.reply(name, data)
            },
            join: (roomname: string) => {
                return client.join(roomname)
            },
            leave: (roomname: string) => {
                return client.leave(roomname)
            },
            broadcast: (roomname: string, name: string, data: any) => {
                if (typeof data === "object" && typeof data?.SLIKR_INTERNAL_EVENT) throw new Slokr.Error("Data passed cannot have SLIKR_INTERNAL_EVENT as a property if the data is a object.")
                return client.broadcast(roomname, name, data)
            }
        }
    }
    rooms(rms: string[]): { except: Function, broadcast: Function, on: Function }
    rooms(...rms: string[]): { except: Function, broadcast: Function, on: Function }
    rooms(rms: "all"): { except: Function, broadcast: Function, on: Function }
    rooms(...rms: any[]): { except: (...ex: any[]) => any, broadcast: (name: string, data: any) => Promise<void>, on: (eventname: string, callback: Slokr.EVENT) => void } {
        let targetRooms: string[] | "all" = [];

        if (rms[0] === "all") {
            targetRooms = "all";
        } else {
            targetRooms = Array.isArray(rms[0]) ? rms[0] : rms;
        }

        const self = this;
        let exceptions: string[] = [];

        const chain = {
            except(...ex: any[]) {
                const normalizedEx = Array.isArray(ex[0]) ? ex[0] : ex;
                exceptions.push(...normalizedEx);
                return chain;
            },

            async broadcast(name: string, data: any) {
                if (typeof data === "object" && data !== null && "SLIKR_INTERNAL_EVENT" in data) {
                    throw new Slokr.Error("Data passed cannot have SLIKR_INTERNAL_EVENT as a property.");
                }

                if (targetRooms === "all") {
                    await self.bindings.broadcastToAllRoomsExcept(name, data, exceptions);
                } else {
                    const excludeSet = new Set(exceptions);
                    const promises = (targetRooms as string[]).map(roomName => {
                        if (excludeSet.has(roomName)) return Promise.resolve();
                        return self.bindings.broadcastToRoom(roomName, name, data);
                    });
                    await Promise.all(promises);
                }
            },

            on(eventname: string, callback: Slokr.EVENT) {
                self.bindings.handle.on(eventname, (data: any, client: Slokr.Client) => {
                    const roomInPacket = data?.SLIKR_INTERNAL_EVENT?._room;

                    if (targetRooms === "all") {
                        if (!exceptions.includes(roomInPacket)) {
                            callback(data, client);
                        }
                    } else {
                        if (targetRooms.includes(roomInPacket) && !exceptions.includes(roomInPacket)) {
                            callback(data, client);
                        }
                    }
                });
                return chain;
            }
        };

        return chain;
    }
}
export namespace Slokr {
    export type WebSocket = "WebSocket"
    export type WebTransport = "WebTransport"
    export type Hybrid = "Hybrid"
    export const WebSocket = "WebSocket"
    export const WebTransport = "WebTransport"
    export const Hybrid = "Hybrid"
    export const ValidModes = [Slokr.WebSocket, Slokr.WebTransport, Slokr.Hybrid]
    export type ValidMode = typeof Slokr.ValidModes[number]
    export class Error extends globalThis.Error {
        constructor(message?: string) {
            super(message);
            this.name = "Slokr"
        }
    }
    export const HANDLE = "";
    export type CACHE = { [key: string]: unknown }
    export type FLAGS = { [key: string]: unknown, wt?: boolean, ws?: boolean, hy?: boolean }
    export type EVENTS = { [key: string]: EVENT[] };
    export type EVENT = (data: string, client: Slokr.Client) => any;
    export class Client {
        public slikr!: {
            version: string;
        };
        public time!: {
            sentAt: number;
            timeTaken: number;
            recievedAt: number;
        };
        public client!: {
            averagePerformance: number;
            ip?: string;
            from: Slokr.WebSocket | Slokr.WebTransport;
            userAgent?: string;
        };
        public raw!: ArrayBuffer | Buffer | Buffer[];
        public slokr!: {
            mode: Slokr.ValidMode;
        };
        public eventname!: string;
        public join!: (room: string) => any;
        public leave!: (room: string) => any;
        public broadcast!: (room: string, name: string, data: any) => Promise<any>;
        public reply!: (name: string, data: any) => Promise<any>;

        constructor(evinfo: Slokr.EVENT.DATA) {
            Object.assign(this, evinfo);
        }
    }
}
export namespace Slokr.HANDLE {
    export type TYPE = { receive: (data: string, timeout: number) => Promise<any>, send: (target: any, name: string, data: string) => Promise<any>, wtSessions: any[], [key: string]: unknown, cache: CACHE_TYPE, on: Function, WebTransport: Function, WebSocket: Function, https?: HTTPSServer, wt?: Http3Server, ws?: WebSocketServer, events: Slokr.EVENTS }
    export type CACHE_TYPE = { [key: string]: unknown, handleon?: Function }
};
export namespace Slokr.EVENT {
    export interface DATA {
        slikr: {
            version: string
        };
        time: {
            sentAt: number,
            timeTaken: number;
            recievedAt: number;
        }
        client: {
            averagePerformance: number;
            ip?: string;
            from: Slokr.WebSocket | Slokr.WebTransport;
            userAgent?: string;
        };
        raw: ArrayBuffer | Buffer<ArrayBufferLike> | Buffer<ArrayBufferLike>[],
        slokr: {
            mode: Slokr.ValidMode
        },
        eventname: string,
        join: (room: string) => any;
        leave: (room: string) => any;
        broadcast: (room: string, name: string, data: any) => Promise<any>;
        reply: (name: string, data: any) => Promise<any>
    }
}

export default function slokr(type:Slokr.ValidMode,port?:number,host?:string){
    return new Slokr(type,port,host)
}