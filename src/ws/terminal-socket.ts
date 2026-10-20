import {WebSocket} from 'ws';
import type {TerminalManager} from '../terminals.js';

export type TerminalSocketContext = {
  terminals: TerminalManager;
  clients: Set<WebSocket>;
};

/** Serves `/api/v1/terminals/:id/ws`: terminal output streaming plus input and resize commands. */
export function handleTerminalSocket(ctx: TerminalSocketContext, ws: WebSocket, terminalId: string) {
  ctx.clients.add(ws);
  let unsubscribe = () => {};
  ws.on('close', () => {
    ctx.clients.delete(ws);
    unsubscribe();
  });
  try {
    const send = (message: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 1024 * 1024) {
        ws.close(1013, 'Terminal client is too slow');
        return;
      }
      ws.send(JSON.stringify(message));
    };
    unsubscribe = ctx.terminals.subscribe(terminalId, event => {
      send(event);
      if (event.type === 'exit') setTimeout(() => ws.close(), 50);
    });
    const snapshot = ctx.terminals.snapshot(terminalId);
    send({type: 'snapshot', data: snapshot.data, record: snapshot.record});
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'input') ctx.terminals.write(terminalId, message.data);
        else if (message.type === 'resize')
          ctx.terminals.resize(terminalId, Number(message.cols), Number(message.rows));
        else throw new Error('Unknown terminal command');
      } catch (error) {
        send({type: 'error', message: (error as Error).message});
      }
    });
  } catch (error) {
    ws.send(JSON.stringify({type: 'error', message: (error as Error).message}));
    ws.close();
  }
}
