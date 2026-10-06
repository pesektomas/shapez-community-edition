import { createConnection, createServer, type Server, type Socket } from "node:net";

/**
 * TCP proxy which delays every chunk by `latencyMs ± jitterMs`, keeping the
 * order of the data (like toxiproxy's latency toxic). Works for HTTP and
 * WebSocket traffic alike.
 */
export async function startLatencyProxy(targetPort: number, latencyMs: number, jitterMs: number) {
    const sockets = new Set<Socket>();

    const pipeDelayed = (from: Socket, to: Socket) => {
        let lastSendAt = 0;
        from.on("data", chunk => {
            const delay = Math.max(0, latencyMs + (Math.random() * 2 - 1) * jitterMs);
            // Never overtake earlier chunks
            const sendAt = Math.max(Date.now() + delay, lastSendAt);
            lastSendAt = sendAt;
            setTimeout(() => {
                if (!to.destroyed) {
                    to.write(chunk);
                }
            }, sendAt - Date.now());
        });
        from.on("end", () => setTimeout(() => to.end(), Math.max(0, lastSendAt - Date.now())));
        from.on("error", () => to.destroy());
    };

    const server: Server = createServer(client => {
        const upstream = createConnection({ port: targetPort, host: "127.0.0.1" });
        sockets.add(client);
        sockets.add(upstream);
        pipeDelayed(client, upstream);
        pipeDelayed(upstream, client);
        const cleanup = () => {
            sockets.delete(client);
            sockets.delete(upstream);
        };
        client.on("close", cleanup);
        upstream.on("close", cleanup);
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    return {
        port,
        baseURL: `http://127.0.0.1:${port}`,
        async close() {
            sockets.forEach(socket => socket.destroy());
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}
